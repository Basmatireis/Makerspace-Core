package printerconnector

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

const (
	testToken      = "connector-secret"
	relayWait      = 3 * time.Second
	relayQuietWait = 250 * time.Millisecond
	testSessionOne = "0198f2a4-0000-7000-8000-0000000000a1"
	testSessionTwo = "0198f2a4-0000-7000-8000-0000000000a2"
	testSessionTre = "0198f2a4-0000-7000-8000-0000000000a3"
)

// relayCore implements the two websocket endpoints of Core's relay.
type relayCore struct {
	*httptest.Server
	control  chan *websocket.Conn
	sessions chan fakeSession
	mu       sync.Mutex
	rejected []int
}

type fakeSession struct {
	id   string
	conn *websocket.Conn
}

func newRelayCore(t *testing.T) *relayCore {
	t.Helper()
	core := &relayCore{control: make(chan *websocket.Conn, 8), sessions: make(chan fakeSession, 8)}
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	core.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testToken {
			core.mu.Lock()
			core.rejected = append(core.rejected, http.StatusUnauthorized)
			core.mu.Unlock()
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		switch {
		case r.URL.Path == "/api/v1/printer-connector/self/stream-control":
			core.control <- conn
		case strings.HasPrefix(r.URL.Path, "/api/v1/printer-connector/self/stream-sessions/"):
			core.sessions <- fakeSession{id: strings.TrimPrefix(r.URL.Path, "/api/v1/printer-connector/self/stream-sessions/"), conn: conn}
		default:
			_ = conn.Close()
		}
	}))
	t.Cleanup(core.Close)
	return core
}

type relayHarness struct {
	relay *streamRelay
	core  *relayCore
	g2r   *fakeGo2RTC
}

func startRelay(t *testing.T, streams ...string) *relayHarness {
	t.Helper()
	core := newRelayCore(t)
	fake := newFakeGo2RTC(t, "api", "secret")
	client, err := NewClient(core.URL, true)
	if err != nil {
		t.Fatal(err)
	}
	g2r, err := newGo2RTCClient(fake.URL, "api", "secret")
	if err != nil {
		t.Fatal(err)
	}
	relay := newStreamRelay(client, func() string { return testToken }, g2r, discardLogger())
	relay.backoffMin, relay.backoffMax = 10*time.Millisecond, 40*time.Millisecond
	relay.SetStreams(streams)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { relay.Run(ctx); close(done) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(relayWait):
			t.Error("the relay did not stop with its context")
		}
	})
	return &relayHarness{relay: relay, core: core, g2r: fake}
}

func (h *relayHarness) control(t *testing.T) *websocket.Conn {
	t.Helper()
	select {
	case conn := <-h.core.control:
		t.Cleanup(func() { _ = conn.Close() })
		return conn
	case <-time.After(relayWait):
		t.Fatal("the connector did not open the control channel")
		return nil
	}
}

func (h *relayHarness) session(t *testing.T) fakeSession {
	t.Helper()
	select {
	case session := <-h.core.sessions:
		t.Cleanup(func() { _ = session.conn.Close() })
		return session
	case <-time.After(relayWait):
		t.Fatal("the connector did not open the data channel")
		return fakeSession{}
	}
}

func (h *relayHarness) expectNoSession(t *testing.T) {
	t.Helper()
	select {
	case <-h.core.sessions:
		t.Fatal("the connector must not open a data channel")
	case <-time.After(relayQuietWait):
	}
}

func openMessage(sessionID, stream string) string {
	return `{"type":"open","sessionId":"` + sessionID + `","stream":"` + stream + `"}`
}

func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(relayWait)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func readFrame(t *testing.T, conn *websocket.Conn) (int, string) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(relayWait))
	messageType, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return messageType, string(data)
}

func TestRelaySplicesFramesBothWaysAndPreservesTypes(t *testing.T) {
	const stream = "cam-" + testCameraID
	h := startRelay(t, stream)
	local := make(chan *websocket.Conn, 1)
	sources := make(chan string, 1)
	finished := make(chan struct{})
	h.g2r.onWebsocket = func(conn *websocket.Conn, source string) {
		sources <- source
		local <- conn
		<-finished
	}
	control := h.control(t)
	if err := control.WriteMessage(websocket.TextMessage, []byte(openMessage(testSessionOne, stream))); err != nil {
		t.Fatal(err)
	}
	session := h.session(t)
	if session.id != testSessionOne {
		t.Fatalf("session id = %q", session.id)
	}
	if source := <-sources; source != stream {
		t.Fatalf("go2rtc source = %q", source)
	}
	if user := <-h.g2r.auth; user != "api" {
		t.Fatalf("go2rtc basic auth user = %q", user)
	}
	go2rtcConn := <-local
	waitFor(t, "viewer count", func() bool { return h.relay.Viewers(stream) == 1 })

	// Viewer -> go2rtc: text stays text.
	if err := session.conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"mse","value":"avc1"}`)); err != nil {
		t.Fatal(err)
	}
	if messageType, data := readFrame(t, go2rtcConn); messageType != websocket.TextMessage || data != `{"type":"mse","value":"avc1"}` {
		t.Fatalf("go2rtc received %d %q", messageType, data)
	}
	// go2rtc -> viewer: text and binary keep their type.
	if err := go2rtcConn.WriteMessage(websocket.TextMessage, []byte(`{"type":"mse","value":"codec"}`)); err != nil {
		t.Fatal(err)
	}
	if err := go2rtcConn.WriteMessage(websocket.BinaryMessage, []byte{0, 1, 2, 3}); err != nil {
		t.Fatal(err)
	}
	if messageType, data := readFrame(t, session.conn); messageType != websocket.TextMessage || data != `{"type":"mse","value":"codec"}` {
		t.Fatalf("Core received %d %q", messageType, data)
	}
	if messageType, data := readFrame(t, session.conn); messageType != websocket.BinaryMessage || data != "\x00\x01\x02\x03" {
		t.Fatalf("Core received %d %q", messageType, data)
	}

	// Core ends the data channel: go2rtc's side closes and the session disappears.
	_ = session.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
	_ = go2rtcConn.SetReadDeadline(time.Now().Add(relayWait))
	if _, _, err := go2rtcConn.ReadMessage(); err == nil {
		t.Fatal("go2rtc's connection should be closed")
	}
	waitFor(t, "session end", func() bool { return h.relay.Viewers(stream) == 0 })
	close(finished)
}

func TestRelayClosesTheDataChannelWhenGo2RTCEnds(t *testing.T) {
	const stream = "cam-" + testCameraID
	h := startRelay(t, stream)
	h.g2r.onWebsocket = func(conn *websocket.Conn, _ string) {
		_ = conn.WriteMessage(websocket.BinaryMessage, []byte("first"))
		time.Sleep(50 * time.Millisecond)
	}
	control := h.control(t)
	_ = control.WriteMessage(websocket.TextMessage, []byte(openMessage(testSessionOne, stream)))
	session := h.session(t)
	if messageType, data := readFrame(t, session.conn); messageType != websocket.BinaryMessage || data != "first" {
		t.Fatalf("frame = %d %q", messageType, data)
	}
	_ = session.conn.SetReadDeadline(time.Now().Add(relayWait))
	if _, _, err := session.conn.ReadMessage(); err == nil {
		t.Fatal("the data channel should close when go2rtc ends the stream")
	}
	waitFor(t, "session end", func() bool { return h.relay.Viewers(stream) == 0 })
}

func TestRelayCloseMessageTearsTheSessionDown(t *testing.T) {
	const stream = "cam-" + testCameraID
	h := startRelay(t, stream)
	h.g2r.onWebsocket = func(conn *websocket.Conn, _ string) {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}
	control := h.control(t)
	_ = control.WriteMessage(websocket.TextMessage, []byte(openMessage(testSessionOne, stream)))
	session := h.session(t)
	waitFor(t, "viewer count", func() bool { return h.relay.Viewers(stream) == 1 })
	_ = control.WriteMessage(websocket.TextMessage, []byte(`{"type":"close","sessionId":"`+testSessionOne+`"}`))
	_ = session.conn.SetReadDeadline(time.Now().Add(relayWait))
	if _, _, err := session.conn.ReadMessage(); err == nil {
		t.Fatal("the data channel should close")
	}
	waitFor(t, "session end", func() bool { return h.relay.Viewers(stream) == 0 })
}

func TestRelayRefusesUnknownStreamsInvalidIDsAndDuplicates(t *testing.T) {
	const stream = "cam-" + testCameraID
	h := startRelay(t, stream)
	h.g2r.onWebsocket = func(conn *websocket.Conn, _ string) {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}
	control := h.control(t)
	for _, message := range []string{
		openMessage(testSessionOne, "cam-"+testOtherCameraID),
		openMessage(testSessionOne, "../../api/config"),
		openMessage("not-a-uuid", stream),
		openMessage(strings.ToUpper(testSessionOne), stream),
		`{"type":"open"}`,
		`not json`,
	} {
		if err := control.WriteMessage(websocket.TextMessage, []byte(message)); err != nil {
			t.Fatal(err)
		}
	}
	_ = control.WriteMessage(websocket.BinaryMessage, []byte(openMessage(testSessionOne, stream)))
	h.expectNoSession(t)

	_ = control.WriteMessage(websocket.TextMessage, []byte(openMessage(testSessionOne, stream)))
	h.session(t)
	_ = control.WriteMessage(websocket.TextMessage, []byte(openMessage(testSessionOne, stream)))
	h.expectNoSession(t)

	// A stream removed from the configuration ends its sessions.
	h.relay.SetStreams(nil)
	waitFor(t, "session end", func() bool { return h.relay.Viewers(stream) == 0 })
}

func TestRelayLimitsConcurrentSessions(t *testing.T) {
	const stream = "cam-" + testCameraID
	h := startRelay(t, stream)
	h.relay.maxSessions = 2
	h.g2r.onWebsocket = func(conn *websocket.Conn, _ string) {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}
	control := h.control(t)
	first, second := testSessionOne, testSessionTwo
	_ = control.WriteMessage(websocket.TextMessage, []byte(openMessage(first, stream)))
	one := h.session(t)
	_ = control.WriteMessage(websocket.TextMessage, []byte(openMessage(second, stream)))
	h.session(t)
	_ = control.WriteMessage(websocket.TextMessage, []byte(openMessage(testSessionTre, stream)))
	h.expectNoSession(t)
	if h.relay.Viewers(stream) != 2 {
		t.Fatalf("viewers = %d", h.relay.Viewers(stream))
	}
	// Ending one frees a slot.
	_ = one.conn.Close()
	waitFor(t, "slot", func() bool { return h.relay.Viewers(stream) == 1 })
	_ = control.WriteMessage(websocket.TextMessage, []byte(openMessage(testSessionTre, stream)))
	h.session(t)
}

func TestRelayReconnectsTheControlChannelWithBackoff(t *testing.T) {
	h := startRelay(t, "cam-"+testCameraID)
	first := h.control(t)
	_ = first.Close()
	second := h.control(t)
	// Rejected credentials keep being retried, not abandoned.
	_ = second.Close()
	h.control(t)
}

func TestRelayAnswersPingsOnTheControlChannel(t *testing.T) {
	h := startRelay(t)
	control := h.control(t)
	pong := make(chan string, 1)
	control.SetPongHandler(func(data string) error { pong <- data; return nil })
	go func() {
		for {
			if _, _, err := control.ReadMessage(); err != nil {
				return
			}
		}
	}()
	if err := control.WriteControl(websocket.PingMessage, []byte("ping-1"), time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	select {
	case data := <-pong:
		if data != "ping-1" {
			t.Fatalf("pong = %q", data)
		}
	case <-time.After(relayWait):
		t.Fatal("no pong")
	}
}

func TestRelayRetriesWhileCoreRejectsTheCredential(t *testing.T) {
	core := newRelayCore(t)
	client, err := NewClient(core.URL, true)
	if err != nil {
		t.Fatal(err)
	}
	g2r, _ := newGo2RTCClient("http://127.0.0.1:1", "a", "b")
	token := "wrong"
	var mu sync.Mutex
	relay := newStreamRelay(client, func() string { mu.Lock(); defer mu.Unlock(); return token }, g2r, discardLogger())
	relay.backoffMin, relay.backoffMax = 10*time.Millisecond, 20*time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go relay.Run(ctx)
	waitFor(t, "rejected attempts", func() bool {
		core.mu.Lock()
		defer core.mu.Unlock()
		return len(core.rejected) >= 2
	})
	mu.Lock()
	token = testToken
	mu.Unlock()
	select {
	case conn := <-core.control:
		_ = conn.Close()
	case <-time.After(relayWait):
		t.Fatal("the relay should connect once the credential works")
	}
}

func TestRelayReportsAnUnreachableGo2RTCToCore(t *testing.T) {
	const stream = "cam-" + testCameraID
	h := startRelay(t, stream)
	h.g2r.Close()
	control := h.control(t)
	_ = control.WriteMessage(websocket.TextMessage, []byte(openMessage(testSessionOne, stream)))
	session := h.session(t)
	_ = session.conn.SetReadDeadline(time.Now().Add(relayWait))
	_, _, err := session.conn.ReadMessage()
	var closeErr *websocket.CloseError
	if !errors.As(err, &closeErr) || closeErr.Code != websocket.CloseInternalServerErr {
		t.Fatalf("the data channel should close with 1011, got %v", err)
	}
	waitFor(t, "session end", func() bool { return h.relay.Viewers(stream) == 0 })
}
