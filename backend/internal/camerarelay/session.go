package camerarelay

import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// Viewer identifies who wants to watch which camera, and through which connector assignment.
type Viewer struct {
	DeviceID, MachineID, ConnectorID, AssignmentID uuid.UUID
}

type sessionState uint8

const (
	statePending   sessionState = iota // open sent, waiting for the connector's data channel
	stateClaimed                       // the connector's data channel is being upgraded
	stateConnected                     // data channel delivered, viewer not yet upgraded
	stateRelaying                      // frames flow both ways
	stateEnded
)

// Session is one viewer's stream. Its state and connections are guarded by the hub's mutex.
type Session struct {
	hub    *Hub
	id     uuid.UUID
	viewer Viewer
	ready  chan struct{} // closed when the data channel arrived
	done   chan struct{} // closed when the session ended

	state      sessionState
	data       *websocket.Conn
	viewerConn *websocket.Conn
	endCode    int
	started    time.Time

	toViewer, toConnector atomic.Int64
}

// Open reserves a session for the viewer within the limits, asks the connector over its control channel to open the
// data channel and waits up to PendingTimeout for it. The returned session is connected; the caller upgrades the
// viewer and calls Relay, or Abort when the upgrade fails. Errors: 409 camera_offline when the connector has no
// control channel, 429 camera_stream_limit at a limit, 503 camera_unavailable when the connector does not answer.
func (h *Hub) Open(ctx context.Context, viewer Viewer) (*Session, error) {
	s := &Session{
		hub:    h,
		id:     newSessionID(),
		viewer: viewer,
		ready:  make(chan struct{}),
		done:   make(chan struct{}),
	}
	key := deviceMachine{device: viewer.DeviceID, machine: viewer.MachineID}
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return nil, errShuttingDown
	}
	c := h.controls[viewer.ConnectorID]
	switch {
	case c == nil:
		h.mu.Unlock()
		return nil, ErrCameraOffline
	case h.byDeviceMachine[key] >= MaxStreamsPerDeviceMachine:
		h.mu.Unlock()
		return nil, streamLimit("This device already watches this camera too often")
	case h.byDevice[viewer.DeviceID] >= MaxStreamsPerDevice:
		h.mu.Unlock()
		return nil, streamLimit("This device already watches too many cameras")
	case h.byConnector[viewer.ConnectorID] >= MaxSessionsPerConnector || len(h.sessions) >= maxSessions:
		h.mu.Unlock()
		return nil, streamLimit("The local service already serves too many streams")
	}
	h.sessions[s.id] = s
	h.byDeviceMachine[key]++
	h.byDevice[viewer.DeviceID]++
	h.byConnector[viewer.ConnectorID]++
	h.mu.Unlock()

	open := encodeControl(controlMessage{Type: "open", SessionID: s.id, Stream: StreamName(viewer.AssignmentID)})
	if !c.send(open) {
		s.end(CloseConnectorOffline, "local service offline")
		return nil, ErrCameraOffline
	}
	timer := time.NewTimer(h.cfg.PendingTimeout)
	defer timer.Stop()
	var err error
	select {
	case <-s.ready:
		return s, nil
	case <-timer.C:
		err = errConnectorTimeout
	case <-ctx.Done():
		err = ctx.Err()
	case <-s.done:
		err = errConnectorTimeout
		h.mu.Lock()
		switch {
		case h.closed:
			err = errShuttingDown
		case s.endCode == CloseConnectorOffline:
			err = ErrCameraOffline
		}
		h.mu.Unlock()
	}
	s.end(websocket.CloseNormalClosure, "")
	return nil, err
}

// Claim is a pending session reserved for one data channel upgrade.
type Claim struct{ session *Session }

// Claim reserves the pending session for the connector's data channel. It answers 404 when the session is unknown,
// expired, already claimed or belongs to another connector, so a connector learns nothing about other sessions.
func (h *Hub) Claim(connectorID, sessionID uuid.UUID) (*Claim, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.sessions[sessionID]
	if s == nil || s.viewer.ConnectorID != connectorID || s.state != statePending {
		return nil, errSessionNotFound
	}
	s.state = stateClaimed
	return &Claim{session: s}, nil
}

// Deliver hands the upgraded data channel to the waiting viewer. When the session ended meanwhile (the viewer gave
// up), the data channel is closed.
func (c *Claim) Deliver(conn *websocket.Conn) {
	s := c.session
	h := s.hub
	h.mu.Lock()
	if s.state != stateClaimed {
		h.mu.Unlock()
		closeConn(conn, websocket.CloseNormalClosure, "session ended")
		return
	}
	s.data = conn
	s.state = stateConnected
	h.mu.Unlock()
	close(s.ready)
}

// Release gives up a claim whose upgrade failed; the waiting viewer gets 503.
func (c *Claim) Release() {
	c.session.end(websocket.CloseNormalClosure, "")
}

// Abort ends a connected session whose viewer could not be upgraded.
func (s *Session) Abort() {
	s.end(websocket.CloseNormalClosure, "")
}

// end tears the session down exactly once: it leaves the hub's maps, tells the connector to drop the stream, sends
// the close code to the viewer and closes both connections. The relay goroutines then fail their reads and writes.
func (s *Session) end(code int, reason string) {
	h := s.hub
	h.mu.Lock()
	if s.state == stateEnded {
		h.mu.Unlock()
		return
	}
	relaying := s.state == stateRelaying
	s.state = stateEnded
	s.endCode = code
	delete(h.sessions, s.id)
	key := deviceMachine{device: s.viewer.DeviceID, machine: s.viewer.MachineID}
	decrement(h.byDeviceMachine, key)
	decrement(h.byDevice, s.viewer.DeviceID)
	decrement(h.byConnector, s.viewer.ConnectorID)
	c := h.controls[s.viewer.ConnectorID]
	data, viewer := s.data, s.viewerConn
	h.mu.Unlock()
	close(s.done)
	if c != nil {
		c.send(encodeControl(controlMessage{Type: "close", SessionID: s.id}))
	}
	closeConn(viewer, code, reason)
	closeConn(data, websocket.CloseNormalClosure, "")
	if relaying {
		h.logger.Info(
			"camera relay session ended",
			"session_id", s.id.String(),
			"machine_id", s.viewer.MachineID.String(),
			"device_id", s.viewer.DeviceID.String(),
			"connector_id", s.viewer.ConnectorID.String(),
			"close_code", code,
			"duration_ms", time.Since(s.started).Milliseconds(),
			"bytes_to_viewer", s.toViewer.Load(),
			"bytes_to_connector", s.toConnector.Load(),
		)
	}
}

// decrement lowers a counter and drops it at zero, so the maps only hold live keys.
func decrement[K comparable](counts map[K]int, key K) {
	if counts[key] <= 1 {
		delete(counts, key)
		return
	}
	counts[key]--
}

// Relay splices the upgraded viewer websocket with the session's data channel until either side closes, a frame
// breaks the rules, a peer misses pings, reauthorize fails (it runs every ReauthorizeInterval) or the hub closes.
// Viewer to connector: text frames only, at most MaxViewerFrameBytes each and MaxViewerFramesPerSecond. Connector to
// viewer: any frame type, at most MaxConnectorFrameBytes. Relay owns viewer and returns after both copy goroutines
// ended.
func (s *Session) Relay(viewer *websocket.Conn, reauthorize Check) {
	h := s.hub
	h.mu.Lock()
	if s.state != stateConnected || !h.trackLocked() {
		code := websocket.CloseGoingAway
		if s.state == stateEnded && s.endCode != 0 {
			code = s.endCode
		}
		h.mu.Unlock()
		closeConn(viewer, code, "")
		s.end(websocket.CloseGoingAway, "server shutting down")
		return
	}
	s.state = stateRelaying
	s.viewerConn = viewer
	s.started = time.Now()
	data := s.data
	h.mu.Unlock()
	defer h.running.Done()
	h.logger.Info(
		"camera relay session started",
		"session_id", s.id.String(),
		"machine_id", s.viewer.MachineID.String(),
		"device_id", s.viewer.DeviceID.String(),
		"connector_id", s.viewer.ConnectorID.String(),
	)

	viewer.SetReadLimit(MaxViewerFrameBytes)
	data.SetReadLimit(MaxConnectorFrameBytes)
	for _, conn := range []*websocket.Conn{viewer, data} {
		// The HTTP server's deadlines no longer apply to the hijacked connections; the relay sets its own.
		_ = conn.SetReadDeadline(time.Now().Add(h.cfg.PongTimeout))
		conn.SetPongHandler(func(string) error {
			return conn.SetReadDeadline(time.Now().Add(h.cfg.PongTimeout))
		})
	}
	var pumps sync.WaitGroup
	pumps.Add(2)
	go func() {
		defer pumps.Done()
		s.end(s.copyFromViewer(viewer, data))
	}()
	go func() {
		defer pumps.Done()
		s.end(s.copyFromConnector(data, viewer))
	}()

	ping := time.NewTicker(h.cfg.PingInterval)
	defer ping.Stop()
	recheck := time.NewTicker(h.cfg.ReauthorizeInterval)
	defer recheck.Stop()
loop:
	for {
		select {
		case <-s.done:
			break loop
		case <-ping.C:
			deadline := time.Now().Add(h.cfg.WriteTimeout)
			if viewer.WriteControl(websocket.PingMessage, nil, deadline) != nil ||
				data.WriteControl(websocket.PingMessage, nil, deadline) != nil {
				s.end(websocket.CloseGoingAway, "")
			}
		case <-recheck.C:
			if err := h.check(reauthorize); err != nil {
				s.end(closeCodeFor(err))
			}
		}
	}
	pumps.Wait()
}

// copyFromViewer forwards the viewer's text frames to the connector and returns the close code for the viewer.
func (s *Session) copyFromViewer(viewer, data *websocket.Conn) (int, string) {
	var windowStart time.Time
	frames := 0
	for {
		kind, payload, err := viewer.ReadMessage()
		if errors.Is(err, websocket.ErrReadLimit) {
			return websocket.CloseMessageTooBig, "frame too large"
		}
		if err != nil {
			return websocket.CloseNormalClosure, ""
		}
		if kind != websocket.TextMessage {
			return websocket.CloseUnsupportedData, "only text frames are accepted"
		}
		now := time.Now()
		if now.Sub(windowStart) >= time.Second {
			windowStart, frames = now, 0
		}
		if frames++; frames > MaxViewerFramesPerSecond {
			return websocket.ClosePolicyViolation, "too many frames"
		}
		_ = viewer.SetReadDeadline(now.Add(s.hub.cfg.PongTimeout))
		_ = data.SetWriteDeadline(now.Add(s.hub.cfg.WriteTimeout))
		if err := data.WriteMessage(websocket.TextMessage, payload); err != nil {
			return CloseConnectorOffline, "local service ended the stream"
		}
		s.toConnector.Add(int64(len(payload)))
	}
}

// copyFromConnector streams the connector's frames to the viewer with their type, without buffering whole frames,
// and returns the close code for the viewer.
func (s *Session) copyFromConnector(data, viewer *websocket.Conn) (int, string) {
	for {
		kind, reader, err := data.NextReader()
		if err != nil {
			return CloseConnectorOffline, "local service ended the stream"
		}
		now := time.Now()
		_ = data.SetReadDeadline(now.Add(s.hub.cfg.PongTimeout))
		_ = viewer.SetWriteDeadline(now.Add(s.hub.cfg.WriteTimeout))
		writer, err := viewer.NextWriter(kind)
		if err != nil {
			return websocket.CloseNormalClosure, ""
		}
		copied, err := io.Copy(writer, reader)
		s.toViewer.Add(copied)
		// A broken frame is not completed towards the viewer: the session ends instead.
		if errors.Is(err, websocket.ErrReadLimit) {
			return CloseConnectorOffline, "frame too large"
		}
		if err != nil {
			return CloseConnectorOffline, "local service ended the stream"
		}
		if err := writer.Close(); err != nil {
			return websocket.CloseNormalClosure, ""
		}
	}
}
