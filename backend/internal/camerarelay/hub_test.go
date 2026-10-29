package camerarelay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const waitLimit = 5 * time.Second

func testConfig() Config {
	return Config{
		PendingTimeout:      2 * time.Second,
		PingInterval:        50 * time.Millisecond,
		PongTimeout:         5 * time.Second,
		ReauthorizeInterval: 50 * time.Millisecond,
		WriteTimeout:        time.Second,
		CheckTimeout:        time.Second,
	}
}

func newTestHub(t *testing.T, cfg Config) *Hub {
	t.Helper()
	hub := NewHub(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() {
		hub.Close()
		ctx, cancel := context.WithTimeout(context.Background(), waitLimit)
		defer cancel()
		if err := hub.Wait(ctx); err != nil {
			t.Errorf("hub did not stop: %v", err)
		}
	})
	return hub
}

// pairs hands out connected websocket pairs: the server side for the hub, the client side for the test.
type pairs struct {
	server *httptest.Server
	conns  chan *websocket.Conn
}

func newPairs(t *testing.T) *pairs {
	t.Helper()
	p := &pairs{conns: make(chan *websocket.Conn, 64)}
	upgrader := websocket.Upgrader{}
	p.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if conn, err := upgrader.Upgrade(w, r, nil); err == nil {
			p.conns <- conn
		}
	}))
	t.Cleanup(p.server.Close)
	return p
}

func (p *pairs) pair(t *testing.T) (server, client *websocket.Conn) {
	t.Helper()
	client, response, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(p.server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	t.Cleanup(func() { _ = client.Close() })
	select {
	case server = <-p.conns:
		return server, client
	case <-time.After(waitLimit):
		t.Fatal("no server connection")
		return nil, nil
	}
}

func allow(context.Context) error { return nil }

// fakeConnector is the connector side of a control channel; it reads (and so answers pings) in the background.
type fakeConnector struct {
	id       uuid.UUID
	conn     *websocket.Conn
	messages chan controlMessage
	closed   chan struct{}
	closeErr error
	served   chan struct{}
}

func connect(t *testing.T, hub *Hub, p *pairs, id uuid.UUID, check Check) *fakeConnector {
	t.Helper()
	server, client := p.pair(t)
	f := &fakeConnector{
		id: id, conn: client, messages: make(chan controlMessage, 128),
		closed: make(chan struct{}), served: make(chan struct{}),
	}
	go func() {
		defer close(f.served)
		hub.ServeControl(id, server, check)
	}()
	go func() {
		defer close(f.closed)
		for {
			_, data, err := client.ReadMessage()
			if err != nil {
				f.closeErr = err
				return
			}
			var message controlMessage
			if json.Unmarshal(data, &message) == nil {
				f.messages <- message
			}
		}
	}()
	waitFor(t, "control channel registered", func() bool { return hub.Connected(id) })
	return f
}

func (f *fakeConnector) next(t *testing.T, kind string) controlMessage {
	t.Helper()
	select {
	case message := <-f.messages:
		if message.Type != kind {
			t.Fatalf("control message = %+v, want %s", message, kind)
		}
		return message
	case <-time.After(waitLimit):
		t.Fatalf("no %s message", kind)
		return controlMessage{}
	}
}

// answer accepts the next open request like the real connector: claim, upgrade, deliver.
func (f *fakeConnector) answer(t *testing.T, hub *Hub, p *pairs) (*websocket.Conn, controlMessage) {
	t.Helper()
	open := f.next(t, "open")
	claim, err := hub.Claim(f.id, open.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	server, client := p.pair(t)
	claim.Deliver(server)
	return client, open
}

func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(waitLimit)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

type openResult struct {
	session *Session
	err     error
}

func openAsync(hub *Hub, viewer Viewer) chan openResult {
	results := make(chan openResult, 1)
	go func() {
		session, err := hub.Open(context.Background(), viewer)
		results <- openResult{session, err}
	}()
	return results
}

type relayed struct {
	viewer, data *websocket.Conn
	open         controlMessage
	done         chan struct{}
}

func startRelay(t *testing.T, hub *Hub, p *pairs, f *fakeConnector, viewer Viewer, check Check) relayed {
	t.Helper()
	results := openAsync(hub, viewer)
	data, open := f.answer(t, hub, p)
	result := <-results
	if result.err != nil {
		t.Fatal(result.err)
	}
	server, client := p.pair(t)
	done := make(chan struct{})
	go func() {
		defer close(done)
		result.session.Relay(server, check)
	}()
	return relayed{viewer: client, data: data, open: open, done: done}
}

// expectClose reads until the connection ends and checks the close code the peer sent.
func expectClose(t *testing.T, conn *websocket.Conn, code int) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(waitLimit))
	for {
		_, _, err := conn.ReadMessage()
		if err == nil {
			continue
		}
		var closeErr *websocket.CloseError
		if !errors.As(err, &closeErr) || closeErr.Code != code {
			t.Fatalf("connection ended with %v, want close code %d", err, code)
		}
		return
	}
}

func expectFrame(t *testing.T, conn *websocket.Conn, kind int, payload []byte) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(waitLimit))
	gotKind, got, err := conn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	if gotKind != kind || !bytes.Equal(got, payload) {
		t.Fatalf("frame = %d %q, want %d %q", gotKind, got, kind, payload)
	}
}

func viewerFor(connector uuid.UUID) Viewer {
	return Viewer{DeviceID: uuid.New(), MachineID: uuid.New(), ConnectorID: connector, AssignmentID: uuid.New()}
}

func expectCode(t *testing.T, err error, status int, code string) {
	t.Helper()
	var appError *apperror.Error
	if !errors.As(err, &appError) || appError.HTTPStatus != status || appError.Code != code {
		t.Fatalf("error = %v, want %d %s", err, status, code)
	}
}

func TestRelaySplicesFramesBothWaysPreservingTheirType(t *testing.T) {
	hub, p := newTestHub(t, testConfig()), newPairs(t)
	f := connect(t, hub, p, uuid.New(), allow)
	viewer := viewerFor(f.id)
	r := startRelay(t, hub, p, f, viewer, allow)
	if r.open.Stream != "cam-"+viewer.AssignmentID.String() {
		t.Fatalf("stream = %q", r.open.Stream)
	}

	request := []byte(`{"type":"mse","value":"avc1.640029"}`)
	if err := r.viewer.WriteMessage(websocket.TextMessage, request); err != nil {
		t.Fatal(err)
	}
	expectFrame(t, r.data, websocket.TextMessage, request)
	for _, frame := range []struct {
		kind    int
		payload []byte
	}{
		{websocket.TextMessage, []byte(`{"type":"mse","value":"avc1"}`)},
		{websocket.BinaryMessage, bytes.Repeat([]byte{0x47}, 256<<10)},
		{websocket.BinaryMessage, []byte{0, 1, 2}},
	} {
		if err := r.data.WriteMessage(frame.kind, frame.payload); err != nil {
			t.Fatal(err)
		}
		expectFrame(t, r.viewer, frame.kind, frame.payload)
	}

	// The viewer leaves: the data channel is closed, the connector is told and the session is gone.
	_ = r.viewer.Close()
	expectClose(t, r.data, websocket.CloseNormalClosure)
	if message := f.next(t, "close"); message.SessionID != r.open.SessionID {
		t.Fatalf("close for %v, want %v", message.SessionID, r.open.SessionID)
	}
	<-r.done
	if stats := hub.Stats(); stats.Sessions != 0 || stats.Controls != 1 {
		t.Fatalf("stats = %+v", stats)
	}
}

func TestOpenNeedsAControlChannelAndAnAnswerInTime(t *testing.T) {
	cfg := testConfig()
	cfg.PendingTimeout = 100 * time.Millisecond
	hub, p := newTestHub(t, cfg), newPairs(t)

	_, err := hub.Open(context.Background(), viewerFor(uuid.New()))
	expectCode(t, err, http.StatusConflict, "camera_offline")

	f := connect(t, hub, p, uuid.New(), allow)
	started := time.Now()
	_, err = hub.Open(context.Background(), viewerFor(f.id))
	expectCode(t, err, http.StatusServiceUnavailable, "camera_unavailable")
	if elapsed := time.Since(started); elapsed < cfg.PendingTimeout {
		t.Fatalf("gave up after %v", elapsed)
	}
	open := f.next(t, "open")
	if closed := f.next(t, "close"); closed.SessionID != open.SessionID {
		t.Fatalf("close = %+v", closed)
	}
	// A late data channel finds nothing.
	if _, err = hub.Claim(f.id, open.SessionID); err == nil {
		t.Fatal("expired session claimed")
	}
	expectCode(t, err, http.StatusNotFound, "stream_session_not_found")
	if stats := hub.Stats(); stats.Sessions != 0 {
		t.Fatalf("stats = %+v", stats)
	}

	// A viewer that gives up while waiting releases its session too.
	ctx, cancel := context.WithCancel(context.Background())
	results := make(chan error, 1)
	go func() {
		_, err := hub.Open(ctx, viewerFor(f.id))
		results <- err
	}()
	f.next(t, "open")
	cancel()
	if err := <-results; !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	f.next(t, "close")
	waitFor(t, "session released", func() bool { return hub.Stats().Sessions == 0 })
}

func TestClaimBelongsToTheSessionsConnectorOnce(t *testing.T) {
	hub, p := newTestHub(t, testConfig()), newPairs(t)
	f := connect(t, hub, p, uuid.New(), allow)
	other := connect(t, hub, p, uuid.New(), allow)
	results := openAsync(hub, viewerFor(f.id))
	open := f.next(t, "open")

	_, err := hub.Claim(other.id, open.SessionID)
	expectCode(t, err, http.StatusNotFound, "stream_session_not_found")
	_, err = hub.Claim(f.id, uuid.New())
	expectCode(t, err, http.StatusNotFound, "stream_session_not_found")
	claim, err := hub.Claim(f.id, open.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = hub.Claim(f.id, open.SessionID); err == nil {
		t.Fatal("a session was claimed twice")
	}
	// A failed upgrade releases the claim and the viewer gets 503.
	claim.Release()
	result := <-results
	expectCode(t, result.err, http.StatusServiceUnavailable, "camera_unavailable")
}

func TestLimitsPerDeviceMachineDeviceAndConnector(t *testing.T) {
	cfg := testConfig()
	cfg.PendingTimeout = time.Minute
	hub, p := newTestHub(t, cfg), newPairs(t)
	f := connect(t, hub, p, uuid.New(), allow)
	pending := 0
	hold := func(viewer Viewer) {
		t.Helper()
		openAsync(hub, viewer)
		pending++
		waitFor(t, "pending session", func() bool { return hub.Stats().Sessions == pending })
	}

	device, machine := uuid.New(), uuid.New()
	same := Viewer{DeviceID: device, MachineID: machine, ConnectorID: f.id, AssignmentID: uuid.New()}
	for range MaxStreamsPerDeviceMachine {
		hold(same)
	}
	_, err := hub.Open(context.Background(), same)
	expectCode(t, err, http.StatusTooManyRequests, "camera_stream_limit")

	for range MaxStreamsPerDevice - MaxStreamsPerDeviceMachine {
		hold(Viewer{DeviceID: device, MachineID: uuid.New(), ConnectorID: f.id, AssignmentID: uuid.New()})
	}
	_, err = hub.Open(context.Background(), Viewer{DeviceID: device, MachineID: uuid.New(), ConnectorID: f.id})
	expectCode(t, err, http.StatusTooManyRequests, "camera_stream_limit")

	second := uuid.New()
	for pending < MaxSessionsPerConnector {
		hold(Viewer{DeviceID: second, MachineID: uuid.New(), ConnectorID: f.id, AssignmentID: uuid.New()})
	}
	_, err = hub.Open(context.Background(), viewerFor(f.id))
	expectCode(t, err, http.StatusTooManyRequests, "camera_stream_limit")

	// Another connector is not affected.
	g := connect(t, hub, p, uuid.New(), allow)
	results := openAsync(hub, Viewer{DeviceID: second, MachineID: uuid.New(), ConnectorID: g.id})
	g.next(t, "open")
	hub.Close()
	expectCode(t, (<-results).err, http.StatusServiceUnavailable, "camera_unavailable")
	waitFor(t, "all sessions released", func() bool { return hub.Stats().Sessions == 0 })
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if len(hub.byDevice) != 0 || len(hub.byDeviceMachine) != 0 || len(hub.byConnector) != 0 {
		t.Fatalf("counters kept keys: %v %v %v", hub.byDevice, hub.byDeviceMachine, hub.byConnector)
	}
}

func TestNewerControlChannelReplacesTheOlderOne(t *testing.T) {
	hub, p := newTestHub(t, testConfig()), newPairs(t)
	id := uuid.New()
	first := connect(t, hub, p, id, allow)
	r := startRelay(t, hub, p, first, viewerFor(id), allow)

	second := connect(t, hub, p, id, allow)
	<-first.closed
	var closeErr *websocket.CloseError
	if !errors.As(first.closeErr, &closeErr) || closeErr.Code != CloseReplaced {
		t.Fatalf("older channel ended with %v", first.closeErr)
	}
	<-first.served
	if stats := hub.Stats(); stats.Controls != 1 || stats.Sessions != 1 {
		t.Fatalf("stats = %+v; the running session survives a replacement", stats)
	}
	// The running session still relays, and new sessions go to the newer channel.
	if err := r.data.WriteMessage(websocket.BinaryMessage, []byte{9}); err != nil {
		t.Fatal(err)
	}
	expectFrame(t, r.viewer, websocket.BinaryMessage, []byte{9})
	results := openAsync(hub, viewerFor(id))
	second.next(t, "open")
	_ = results
}

func TestLostControlChannelEndsItsSessionsAsOffline(t *testing.T) {
	hub, p := newTestHub(t, testConfig()), newPairs(t)
	f := connect(t, hub, p, uuid.New(), allow)
	r := startRelay(t, hub, p, f, viewerFor(f.id), allow)
	_ = f.conn.Close()
	expectClose(t, r.viewer, CloseConnectorOffline)
	<-r.done
	waitFor(t, "control channel gone", func() bool { return !hub.Connected(f.id) })
	_, err := hub.Open(context.Background(), viewerFor(f.id))
	expectCode(t, err, http.StatusConflict, "camera_offline")
}

func TestControlChannelThatMissesPingsIsDropped(t *testing.T) {
	cfg := testConfig()
	cfg.PongTimeout = 200 * time.Millisecond
	hub, p := newTestHub(t, cfg), newPairs(t)
	server, client := p.pair(t)
	served := make(chan struct{})
	go func() {
		defer close(served)
		hub.ServeControl(uuid.New(), server, allow)
	}()
	// The client never reads, so it never answers a ping.
	select {
	case <-served:
	case <-time.After(waitLimit):
		t.Fatal("silent control channel was not dropped")
	}
	_ = client.Close()
	if hub.Stats().Controls != 0 {
		t.Fatal("dropped channel still registered")
	}
}

func TestControlChannelEndsWhenItsCredentialFails(t *testing.T) {
	hub, p := newTestHub(t, testConfig()), newPairs(t)
	var revoked sync.Map
	id := uuid.New()
	f := connect(t, hub, p, id, func(context.Context) error {
		if _, ok := revoked.Load(id); ok {
			return apperror.Unauthenticated
		}
		return nil
	})
	revoked.Store(id, true)
	<-f.closed
	var closeErr *websocket.CloseError
	if !errors.As(f.closeErr, &closeErr) || closeErr.Code != CloseForbidden {
		t.Fatalf("control ended with %v", f.closeErr)
	}
}

func TestViewerFrameRules(t *testing.T) {
	cases := []struct {
		name string
		send func(*websocket.Conn) error
		code int
	}{
		{"binary frame", func(c *websocket.Conn) error {
			return c.WriteMessage(websocket.BinaryMessage, []byte{1})
		}, websocket.CloseUnsupportedData},
		{"oversized text frame", func(c *websocket.Conn) error {
			return c.WriteMessage(websocket.TextMessage, bytes.Repeat([]byte("a"), MaxViewerFrameBytes+1))
		}, websocket.CloseMessageTooBig},
		{"too many frames per second", func(c *websocket.Conn) error {
			for range MaxViewerFramesPerSecond + 1 {
				if err := c.WriteMessage(websocket.TextMessage, []byte(`{}`)); err != nil {
					return err
				}
			}
			return nil
		}, websocket.ClosePolicyViolation},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hub, p := newTestHub(t, testConfig()), newPairs(t)
			f := connect(t, hub, p, uuid.New(), allow)
			r := startRelay(t, hub, p, f, viewerFor(f.id), allow)
			// The connector keeps reading so the frames that are allowed do not stall.
			go func() {
				for {
					if _, _, err := r.data.ReadMessage(); err != nil {
						return
					}
				}
			}()
			if err := tc.send(r.viewer); err != nil {
				t.Fatal(err)
			}
			expectClose(t, r.viewer, tc.code)
			<-r.done
			f.next(t, "close")
		})
	}
	t.Run("ten frames per second pass", func(t *testing.T) {
		hub, p := newTestHub(t, testConfig()), newPairs(t)
		f := connect(t, hub, p, uuid.New(), allow)
		r := startRelay(t, hub, p, f, viewerFor(f.id), allow)
		for range MaxViewerFramesPerSecond {
			if err := r.viewer.WriteMessage(websocket.TextMessage, []byte(`{"type":"mse"}`)); err != nil {
				t.Fatal(err)
			}
			expectFrame(t, r.data, websocket.TextMessage, []byte(`{"type":"mse"}`))
		}
		if hub.Stats().Sessions != 1 {
			t.Fatal("allowed frames ended the session")
		}
	})
}

func TestConnectorFrameAboveTheLimitEndsTheSession(t *testing.T) {
	hub, p := newTestHub(t, testConfig()), newPairs(t)
	f := connect(t, hub, p, uuid.New(), allow)
	r := startRelay(t, hub, p, f, viewerFor(f.id), allow)
	go func() { _ = r.data.WriteMessage(websocket.BinaryMessage, make([]byte, MaxConnectorFrameBytes+1)) }()
	expectClose(t, r.viewer, CloseConnectorOffline)
	<-r.done
}

func TestReauthorizationFailureClosesTheViewer(t *testing.T) {
	cases := []struct {
		name string
		err  error
		code int
	}{
		{"forbidden", apperror.New(http.StatusForbidden, "camera_forbidden", "no"), CloseForbidden},
		{"credential gone", apperror.Unauthenticated, CloseForbidden},
		{"camera gone", apperror.New(http.StatusNotFound, "camera_not_found", "gone"), CloseCameraGone},
		{"internal", errors.New("database down"), websocket.CloseInternalServerErr},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hub, p := newTestHub(t, testConfig()), newPairs(t)
			f := connect(t, hub, p, uuid.New(), allow)
			var fail sync.Map
			r := startRelay(t, hub, p, f, viewerFor(f.id), func(context.Context) error {
				if value, ok := fail.Load("err"); ok {
					return value.(error)
				}
				return nil
			})
			fail.Store("err", tc.err)
			expectClose(t, r.viewer, tc.code)
			expectClose(t, r.data, websocket.CloseNormalClosure)
			<-r.done
			f.next(t, "close")
		})
	}
}

func TestCloseEndsEveryConnectionWithoutLeakingGoroutines(t *testing.T) {
	p := newPairs(t)
	baseline := runtime.NumGoroutine()
	hub := NewHub(testConfig(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	f := connect(t, hub, p, uuid.New(), allow)
	r := startRelay(t, hub, p, f, viewerFor(f.id), allow)
	pendingResult := openAsync(hub, viewerFor(f.id))
	f.next(t, "open")

	hub.Close()
	expectClose(t, r.viewer, websocket.CloseGoingAway)
	<-f.closed
	expectCode(t, (<-pendingResult).err, http.StatusServiceUnavailable, "camera_unavailable")
	ctx, cancel := context.WithTimeout(context.Background(), waitLimit)
	defer cancel()
	if err := hub.Wait(ctx); err != nil {
		t.Fatal(err)
	}
	<-r.done
	<-f.served
	if stats := hub.Stats(); stats.Sessions != 0 || stats.Controls != 0 {
		t.Fatalf("stats = %+v", stats)
	}
	// Nothing new is accepted after Close.
	_, err := hub.Open(context.Background(), viewerFor(f.id))
	expectCode(t, err, http.StatusServiceUnavailable, "camera_unavailable")
	server, client := p.pair(t)
	hub.ServeControl(uuid.New(), server, allow)
	_ = client.Close()
	_ = r.data.Close()

	waitFor(t, "goroutines to end", func() bool { return runtime.NumGoroutine() <= baseline })
}
