package camerarelay

import (
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// control is the control channel of one connector. Only its serving goroutine writes data frames; others queue
// messages on out or stop it.
type control struct {
	connectorID uuid.UUID
	conn        *websocket.Conn
	out         chan []byte
	done        chan struct{}

	stopOnce   sync.Once
	stopCode   int
	stopReason string
}

// stop ends the channel with the given close code; the first call wins.
func (c *control) stop(code int, reason string) {
	c.stopOnce.Do(func() {
		c.stopCode, c.stopReason = code, reason
		close(c.done)
	})
}

// send queues a message without blocking. It fails when the channel has ended or its queue is full.
func (c *control) send(message []byte) bool {
	select {
	case <-c.done:
		return false
	default:
	}
	select {
	case c.out <- message:
		return true
	default:
		return false
	}
}

// ServeControl runs the control channel of a connector on an upgraded websocket until it ends: the connector
// disconnects or misses pings for PongTimeout, a newer control channel of the same connector replaces it, check fails
// (it runs every ReauthorizeInterval), or the hub closes. When the channel ends without a successor, the connector's
// sessions end with 4503. ServeControl owns conn and closes it.
func (h *Hub) ServeControl(connectorID uuid.UUID, conn *websocket.Conn, check Check) {
	c := &control{
		connectorID: connectorID,
		conn:        conn,
		out:         make(chan []byte, controlQueueSize),
		done:        make(chan struct{}),
	}
	h.mu.Lock()
	previous := h.controls[connectorID]
	if previous == nil && len(h.controls) >= maxControlChannels {
		h.mu.Unlock()
		closeConn(conn, websocket.CloseTryAgainLater, "too many control channels")
		return
	}
	if !h.trackLocked() {
		h.mu.Unlock()
		closeConn(conn, websocket.CloseGoingAway, "server shutting down")
		return
	}
	h.controls[connectorID] = c
	h.mu.Unlock()
	defer h.running.Done()
	if previous != nil {
		previous.stop(CloseReplaced, "replaced by a newer control channel")
	}
	h.logger.Info("camera relay control channel opened", "connector_id", connectorID.String())

	code := h.runControl(c, check)

	h.mu.Lock()
	successor := h.controls[connectorID] != c
	var orphaned []*Session
	if !successor {
		delete(h.controls, connectorID)
		for _, s := range h.sessions {
			if s.viewer.ConnectorID == connectorID {
				orphaned = append(orphaned, s)
			}
		}
	}
	h.mu.Unlock()
	// Sessions survive a replacement: their data channels are separate connections of the same connector.
	for _, s := range orphaned {
		s.end(CloseConnectorOffline, "local service offline")
	}
	h.logger.Info("camera relay control channel closed", "connector_id", connectorID.String(), "close_code", code)
}

// runControl pumps the control channel until it ends, closes the connection with the reason it ended and returns the
// close code it sent.
func (h *Hub) runControl(c *control, check Check) (code int) {
	var reason string
	conn := c.conn
	conn.SetReadLimit(MaxControlFrameBytes)
	// The HTTP server's deadlines no longer apply to the hijacked connection; the relay sets its own.
	_ = conn.SetReadDeadline(time.Now().Add(h.cfg.PongTimeout))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(h.cfg.PongTimeout))
	})
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		// The connector sends nothing but pongs; other frames are read (within the limit) and ignored.
		for {
			if _, _, err := conn.NextReader(); err != nil {
				return
			}
		}
	}()
	defer func() {
		closeConn(conn, code, reason)
		<-readerDone
	}()
	ping := time.NewTicker(h.cfg.PingInterval)
	defer ping.Stop()
	recheck := time.NewTicker(h.cfg.ReauthorizeInterval)
	defer recheck.Stop()
	for {
		select {
		case <-readerDone:
			return websocket.CloseNormalClosure
		case <-c.done:
			reason = c.stopReason
			return c.stopCode
		case message := <-c.out:
			_ = conn.SetWriteDeadline(time.Now().Add(h.cfg.WriteTimeout))
			if err := conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return websocket.CloseNormalClosure
			}
		case <-ping.C:
			if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(h.cfg.WriteTimeout)); err != nil {
				return websocket.CloseNormalClosure
			}
		case <-recheck.C:
			if err := h.check(check); err != nil {
				code, reason = closeCodeFor(err)
				return code
			}
		}
	}
}
