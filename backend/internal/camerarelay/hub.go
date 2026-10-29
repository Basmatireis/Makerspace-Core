// Package camerarelay is Core's side of the camera relay: an in-memory hub that keeps the control channel of every
// connected printer connector (the local service), asks a connector for a data channel when a signage player wants
// to watch a camera, and splices the viewer's websocket with that data channel. Core is a byte pipe: it copies
// websocket frames with their type and never parses the media. The deployment runs a single API process, so the
// hub's state lives in memory; every map is bounded and every connection ends on either side's close, on failed
// re-authorization and on shutdown.
package camerarelay

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// Limits of the relay. The per-device and per-connector limits are part of the API contract.
const (
	MaxStreamsPerDeviceMachine = 4
	MaxStreamsPerDevice        = 20
	MaxSessionsPerConnector    = 32
	// maxSessions and maxControlChannels bound the hub's memory independently of the per-client limits.
	maxSessions        = 1024
	maxControlChannels = 256

	// MaxControlFrameBytes caps what a connector may send on its control channel (it should send only pongs).
	MaxControlFrameBytes = 4 << 10
	// MaxViewerFrameBytes and MaxViewerFramesPerSecond bound what a viewer may send: go2rtc's MSE protocol needs only
	// the initial {"type":"mse"} request.
	MaxViewerFrameBytes      = 4 << 10
	MaxViewerFramesPerSecond = 10
	// MaxConnectorFrameBytes caps one message from the connector's data channel.
	MaxConnectorFrameBytes = 4 << 20

	// controlQueueSize bounds the messages waiting for a control channel's writer: an open and a close per session.
	controlQueueSize = 2 * MaxSessionsPerConnector
	closeGrace       = time.Second
	limitRetryAfter  = 10 * time.Second
)

// Close codes the relay sends.
const (
	// CloseForbidden ends a viewer session whose right to watch is gone.
	CloseForbidden = 4403
	// CloseCameraGone ends a viewer session whose camera was switched off or moved.
	CloseCameraGone = 4404
	// CloseReplaced ends a control channel that a newer one of the same connector replaced.
	CloseReplaced = 4409
	// CloseConnectorOffline ends a viewer session whose local service went away or ended the stream.
	CloseConnectorOffline = 4503
)

// Config holds the relay's timing. Tests shorten it; production uses DefaultConfig.
type Config struct {
	// PendingTimeout is how long a viewer waits for the connector's data channel.
	PendingTimeout time.Duration
	// PingInterval is how often the hub pings every websocket; a peer silent for PongTimeout is dropped.
	PingInterval time.Duration
	PongTimeout  time.Duration
	// ReauthorizeInterval is how often a running viewer session and a control channel are re-authorized.
	ReauthorizeInterval time.Duration
	// WriteTimeout bounds one websocket write; a peer that cannot take a frame in time is dropped.
	WriteTimeout time.Duration
	// CheckTimeout bounds one re-authorization.
	CheckTimeout time.Duration
}

// DefaultConfig is the production timing of the relay protocol.
func DefaultConfig() Config {
	return Config{
		PendingTimeout:      10 * time.Second,
		PingInterval:        20 * time.Second,
		PongTimeout:         60 * time.Second,
		ReauthorizeInterval: 15 * time.Second,
		WriteTimeout:        15 * time.Second,
		CheckTimeout:        5 * time.Second,
	}
}

// Check re-authorizes a long-lived connection. A nil error keeps it open; see closeCodeFor for the mapping of errors.
type Check func(ctx context.Context) error

var (
	errShuttingDown = apperror.New(
		http.StatusServiceUnavailable,
		"camera_unavailable",
		"The camera relay is shutting down",
	)
	errConnectorTimeout = apperror.New(
		http.StatusServiceUnavailable,
		"camera_unavailable",
		"The local service did not open the camera stream in time",
	)
	errSessionNotFound = apperror.New(http.StatusNotFound, "stream_session_not_found", "The stream session does not exist")
)

// ErrCameraOffline answers a viewer whose connector is not connected on its control channel.
var ErrCameraOffline = apperror.New(
	http.StatusConflict,
	"camera_offline",
	"The local service of this camera is not connected",
)

func streamLimit(message string) error {
	return apperror.RateLimited("camera_stream_limit", message, limitRetryAfter)
}

type deviceMachine struct{ device, machine uuid.UUID }

// Hub is the relay's in-memory state. Its zero value is not usable; call NewHub.
type Hub struct {
	cfg    Config
	logger *slog.Logger
	// ctx ends with Close; re-authorizations derive from it.
	ctx    context.Context
	cancel context.CancelFunc

	mu              sync.Mutex
	closed          bool
	controls        map[uuid.UUID]*control
	sessions        map[uuid.UUID]*Session
	byDevice        map[uuid.UUID]int
	byDeviceMachine map[deviceMachine]int
	byConnector     map[uuid.UUID]int
	// running counts the control channels and relays that are being served, so Wait can return once all ended.
	running sync.WaitGroup
}

// NewHub builds an empty hub.
func NewHub(cfg Config, logger *slog.Logger) *Hub {
	if logger == nil {
		logger = slog.Default()
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Hub{
		cfg: cfg, logger: logger, ctx: ctx, cancel: cancel,
		controls:        map[uuid.UUID]*control{},
		sessions:        map[uuid.UUID]*Session{},
		byDevice:        map[uuid.UUID]int{},
		byDeviceMachine: map[deviceMachine]int{},
		byConnector:     map[uuid.UUID]int{},
	}
}

// Close ends every control channel and session with "going away" and refuses new ones. It does not wait; see Wait.
func (h *Hub) Close() {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return
	}
	h.closed = true
	controls := make([]*control, 0, len(h.controls))
	for _, c := range h.controls {
		controls = append(controls, c)
	}
	sessions := make([]*Session, 0, len(h.sessions))
	for _, s := range h.sessions {
		sessions = append(sessions, s)
	}
	h.mu.Unlock()
	h.cancel()
	// Sessions end first, so a control channel that stops next finds none to end as "offline". Close frames go out
	// concurrently, so one slow peer does not hold up the others' shutdown.
	var ending sync.WaitGroup
	for _, s := range sessions {
		ending.Add(1)
		go func() {
			defer ending.Done()
			s.end(websocket.CloseGoingAway, "server shutting down")
		}()
	}
	ending.Wait()
	for _, c := range controls {
		c.stop(websocket.CloseGoingAway, "server shutting down")
	}
}

// Wait blocks until every control channel and relay served by the hub has ended, or ctx ends.
func (h *Hub) Wait(ctx context.Context) error {
	done := make(chan struct{})
	go func() {
		h.running.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Connected reports whether the connector has a control channel open.
func (h *Hub) Connected(connectorID uuid.UUID) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.controls[connectorID] != nil
}

// Stats is a snapshot of the hub's size, for tests and diagnostics.
type Stats struct {
	Controls, Sessions int
}

// Stats returns the number of open control channels and sessions (pending or relaying).
func (h *Hub) Stats() Stats {
	h.mu.Lock()
	defer h.mu.Unlock()
	return Stats{Controls: len(h.controls), Sessions: len(h.sessions)}
}

// track registers a served connection with the running group. It fails once the hub is closed, so that Wait never
// races with a new registration. The caller holds h.mu.
func (h *Hub) trackLocked() bool {
	if h.closed {
		return false
	}
	h.running.Add(1)
	return true
}

func (h *Hub) check(check Check) error {
	ctx, cancel := context.WithTimeout(h.ctx, h.cfg.CheckTimeout)
	defer cancel()
	return check(ctx)
}

// closeCodeFor maps a failed re-authorization to the close code the viewer receives: a missing camera is 4404, a
// lost right to watch (or a lost credential) 4403, anything else an internal error.
func closeCodeFor(err error) (int, string) {
	var appError *apperror.Error
	if errors.As(err, &appError) {
		switch appError.HTTPStatus {
		case http.StatusNotFound:
			return CloseCameraGone, "camera gone"
		case http.StatusUnauthorized, http.StatusForbidden:
			return CloseForbidden, "forbidden"
		}
	}
	return websocket.CloseInternalServerErr, "re-authorization failed"
}

// closeConn sends a close frame (best effort, bounded by closeGrace) and closes the connection.
func closeConn(conn *websocket.Conn, code int, reason string) {
	if conn == nil {
		return
	}
	_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(closeGrace))
	_ = conn.Close()
}

type controlMessage struct {
	Type      string    `json:"type"`
	SessionID uuid.UUID `json:"sessionId"`
	Stream    string    `json:"stream,omitempty"`
}

func encodeControl(message controlMessage) []byte {
	encoded, _ := json.Marshal(message) // a struct of strings and a UUID always encodes
	return encoded
}

// StreamName is the go2rtc stream name the connector serves for an assignment's camera.
func StreamName(assignmentID uuid.UUID) string { return "cam-" + assignmentID.String() }

func newSessionID() uuid.UUID { return ids.New() }
