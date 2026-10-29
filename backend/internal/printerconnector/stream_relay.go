package printerconnector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	// relayMaxSessions is how many viewer sessions the connector relays at once.
	relayMaxSessions = 32
	// relayMaxFrameBytes bounds one websocket frame in either direction.
	relayMaxFrameBytes = 4 << 20
	// controlMaxFrameBytes bounds the small JSON frames of the control channel.
	controlMaxFrameBytes = 4 << 10
	// controlIdleTimeout: Core pings every 20 seconds; a channel that stays silent longer is dead.
	controlIdleTimeout = 60 * time.Second
	relayWriteTimeout  = 15 * time.Second

	relayBackoffMin    = time.Second
	relayBackoffMax    = time.Minute
	relayStableConnect = 30 * time.Second

	controlPath = "/printer-connector/self/stream-control"
	sessionPath = "/printer-connector/self/stream-sessions/"
)

// streamRelay keeps the control channel to Core open and, for every `open` request, splices a go2rtc
// MSE websocket to a data websocket at Core. Core never parses the media: frames are copied
// unchanged, text as text and binary as binary.
type streamRelay struct {
	core   *Client
	token  func() string
	g2r    *go2rtcClient
	logger *slog.Logger

	backoffMin, backoffMax, stableAfter time.Duration
	maxSessions                         int

	mu       sync.Mutex
	streams  map[string]struct{}
	sessions map[uuid.UUID]*relaySession
	wg       sync.WaitGroup
}

type relaySession struct {
	stream string
	cancel context.CancelFunc
}

func newStreamRelay(core *Client, token func() string, g2r *go2rtcClient, logger *slog.Logger) *streamRelay {
	return &streamRelay{
		core:        core,
		token:       token,
		g2r:         g2r,
		logger:      logger,
		backoffMin:  relayBackoffMin,
		backoffMax:  relayBackoffMax,
		stableAfter: relayStableConnect,
		maxSessions: relayMaxSessions,
		streams:     map[string]struct{}{},
		sessions:    map[uuid.UUID]*relaySession{},
	}
}

// SetStreams replaces the streams the relay serves. Sessions of streams that are no longer
// configured end.
func (r *streamRelay) SetStreams(names []string) {
	set := make(map[string]struct{}, len(names))
	for _, name := range names {
		set[name] = struct{}{}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.streams = set
	for _, session := range r.sessions {
		if _, ok := set[session.stream]; !ok {
			session.cancel()
		}
	}
}

// Viewers is the number of active relay sessions of a stream.
func (r *streamRelay) Viewers(stream string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	count := 0
	for _, session := range r.sessions {
		if session.stream == stream {
			count++
		}
	}
	return count
}

// Run keeps the control channel connected until ctx ends, reconnecting with exponential backoff
// (1 s to 60 s) and jitter, then waits for all sessions to end.
func (r *streamRelay) Run(ctx context.Context) {
	defer r.wg.Wait()
	delay := r.backoffMin
	for ctx.Err() == nil {
		started := time.Now()
		err := r.serveControl(ctx)
		if ctx.Err() != nil {
			return
		}
		if time.Since(started) >= r.stableAfter {
			delay = r.backoffMin
		}
		r.logger.Warn("camera control channel disconnected", "reason", describeDialError(err), "retry_in", delay.String())
		//nolint:gosec // reconnect jitter needs no cryptographic randomness
		timer := time.NewTimer(delay/2 + rand.N(delay/2+1))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		delay = min(delay*2, r.backoffMax)
	}
}

// describeDialError keeps log lines free of URLs: the HTTP status for a refused handshake, the error
// text otherwise (network errors name only the Core address).
func describeDialError(err error) string {
	var coreErr *CoreError
	switch {
	case err == nil:
		return "closed"
	case errors.As(err, &coreErr):
		return fmt.Sprintf("core answered %d", coreErr.Status)
	default:
		return err.Error()
	}
}

type controlMessage struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	Stream    string `json:"stream"`
}

// serveControl runs one control channel connection until it fails.
func (r *streamRelay) serveControl(ctx context.Context) error {
	conn, err := r.core.dialWebsocket(ctx, controlPath, r.token())
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close() }()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	conn.SetReadLimit(controlMaxFrameBytes)
	_ = conn.SetReadDeadline(time.Now().Add(controlIdleTimeout))
	conn.SetPingHandler(func(data string) error {
		_ = conn.SetReadDeadline(time.Now().Add(controlIdleTimeout))
		err := conn.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(5*time.Second))
		if errors.Is(err, websocket.ErrCloseSent) {
			return nil
		}
		return err
	})
	r.logger.Info("camera control channel connected")
	for {
		messageType, data, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		_ = conn.SetReadDeadline(time.Now().Add(controlIdleTimeout))
		if messageType != websocket.TextMessage {
			continue
		}
		var message controlMessage
		if json.Unmarshal(data, &message) != nil {
			continue
		}
		switch message.Type {
		case "open":
			r.open(ctx, message)
		case "close":
			r.closeSession(message.SessionID)
		}
	}
}

// open starts a relay session if the stream is configured and the limits allow it. A refused request
// is not answered; Core's pending session expires.
func (r *streamRelay) open(ctx context.Context, message controlMessage) {
	id, err := uuid.Parse(message.SessionID)
	if err != nil || id.String() != message.SessionID {
		r.logger.Warn("camera session refused: invalid session id")
		return
	}
	r.mu.Lock()
	if _, known := r.streams[message.Stream]; !known {
		r.mu.Unlock()
		r.logger.Warn("camera session refused: unknown stream", "session_id", message.SessionID)
		return
	}
	if _, exists := r.sessions[id]; exists || len(r.sessions) >= r.maxSessions {
		r.mu.Unlock()
		r.logger.Warn("camera session refused: limit reached or duplicate", "session_id", message.SessionID)
		return
	}
	sessionCtx, cancel := context.WithCancel(ctx)
	r.sessions[id] = &relaySession{stream: message.Stream, cancel: cancel}
	r.wg.Add(1)
	r.mu.Unlock()
	go func() {
		defer r.wg.Done()
		defer func() {
			cancel()
			r.mu.Lock()
			delete(r.sessions, id)
			r.mu.Unlock()
		}()
		r.runSession(sessionCtx, id, message.Stream)
	}()
}

func (r *streamRelay) closeSession(sessionID string) {
	id, err := uuid.Parse(sessionID)
	if err != nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if session, ok := r.sessions[id]; ok {
		session.cancel()
	}
}

// runSession dials Core's data channel and go2rtc's MSE websocket and copies frames both ways until
// either side ends.
func (r *streamRelay) runSession(ctx context.Context, id uuid.UUID, stream string) {
	started := time.Now()
	core, err := r.core.dialWebsocket(ctx, sessionPath+id.String(), r.token())
	if err != nil {
		r.logger.Warn("camera session not accepted by Core", "session_id", id.String(), "reason", describeDialError(err))
		return
	}
	local, err := r.dialGo2RTC(ctx, stream)
	if err != nil {
		r.logger.Warn("camera session: go2rtc unavailable", "session_id", id.String(), "reason", describeDialError(err))
		closeWebsocket(core, websocket.CloseInternalServerErr, "camera unavailable")
		return
	}
	r.logger.Info("camera session started", "session_id", id.String(), "stream", stream)
	toGo2RTC, fromGo2RTC := splice(ctx, core, local)
	r.logger.Info(
		"camera session ended",
		"session_id", id.String(), "stream", stream, "duration", time.Since(started).Round(time.Second).String(),
		"bytes_to_go2rtc", toGo2RTC, "bytes_from_go2rtc", fromGo2RTC,
	)
}

func (r *streamRelay) dialGo2RTC(ctx context.Context, stream string) (*websocket.Conn, error) {
	header := http.Header{}
	r.g2r.authorize(header)
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, response, err := dialer.DialContext(ctx, r.g2r.websocketURL(stream), header)
	if response != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		if response != nil {
			return nil, &CoreError{Status: response.StatusCode, Code: response.Status}
		}
		return nil, errGo2RTCDown
	}
	return conn, nil
}

func closeWebsocket(conn *websocket.Conn, code int, text string) {
	_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, text), time.Now().Add(time.Second))
	_ = conn.Close()
}

// splice copies frames between the two connections until one ends or ctx is cancelled, then closes
// both. It returns the payload bytes copied toward and from go2rtc.
func splice(ctx context.Context, core, local *websocket.Conn) (toGo2RTC, fromGo2RTC int64) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(ctx, func() {
		closeWebsocket(core, websocket.CloseNormalClosure, "")
		closeWebsocket(local, websocket.CloseNormalClosure, "")
	})
	defer stop()
	var up, down atomic.Int64
	done := make(chan struct{}, 2)
	go func() { pumpFrames(core, local, &up); done <- struct{}{} }()
	go func() { pumpFrames(local, core, &down); done <- struct{}{} }()
	<-done
	cancel()
	<-done
	closeWebsocket(core, websocket.CloseNormalClosure, "")
	closeWebsocket(local, websocket.CloseNormalClosure, "")
	return up.Load(), down.Load()
}

// pumpFrames copies frames from src to dst, preserving the frame type, until either fails.
func pumpFrames(src, dst *websocket.Conn, copied *atomic.Int64) {
	src.SetReadLimit(relayMaxFrameBytes)
	for {
		messageType, data, err := src.ReadMessage()
		if err != nil {
			return
		}
		_ = dst.SetWriteDeadline(time.Now().Add(relayWriteTimeout))
		if err = dst.WriteMessage(messageType, data); err != nil {
			return
		}
		copied.Add(int64(len(data)))
	}
}
