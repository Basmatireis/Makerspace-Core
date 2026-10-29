package integration_test

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/camerarelay"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/signage"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// relayTiming keeps the protocol's shape but re-authorizes ten times a second, so revocations show quickly.
var relayTiming = camerarelay.Config{
	PendingTimeout:      3 * time.Second,
	PingInterval:        200 * time.Millisecond,
	PongTimeout:         5 * time.Second,
	ReauthorizeInterval: 100 * time.Millisecond,
	WriteTimeout:        2 * time.Second,
	CheckTimeout:        2 * time.Second,
}

// relayEnv is a published display whose scene shows the camera of one Bambu printer behind an enrolled connector.
type relayEnv struct {
	*connectorEnv
	staff                   staffSession
	machine, connector      uuid.UUID
	assignment              uuid.UUID
	connectorToken          string
	scene                   signage.Scene
	sceneVersion            int64
	displayID               string
	playlistID              string
	player                  *http.Client
	deviceToken             string
	displayName, displayLoc string
}

func newRelayEnv(t *testing.T) *relayEnv {
	t.Helper()
	g := newConnectorEnvWithRelay(t, relayTiming)
	r := &relayEnv{connectorEnv: g, staff: g.allStaff(), displayName: "Relay display", displayLoc: "Entrance hall"}
	r.machine, r.connector = g.bambuWithConnector("Relay printer", "bambu_h2d", "192.168.1.95", "40000001")
	if err := g.pool.QueryRow(testContext(t),
		`UPDATE printer_connector_assignments SET camera_streaming = true WHERE machine_id = $1 AND ended_at IS NULL RETURNING id`,
		r.machine).Scan(&r.assignment); err != nil {
		t.Fatal(err)
	}
	r.connectorToken = r.enroll(r.connector)
	input := sceneInput("Relay camera", "full")
	input.Zones = map[string]json.RawMessage{"main": cameraWidget(r.machine)}
	scene, err := g.fixture.service.CreateScene(testContext(t), g.fixture.admin, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	r.scene, r.sceneVersion = scene, 1
	playlist := g.fixture.playlist(t, "Relay", scene.ID)
	r.playlistID = playlist.ID.String()
	display, player := g.pair(r.staff, r.displayName, playlist.ID)
	r.displayID, r.player = display["id"].(string), player
	r.deviceToken = g.deviceToken(player)
	r.publish()
	return r
}

func (r *relayEnv) enroll(connector uuid.UUID) string {
	r.t.Helper()
	issue := r.expect(
		r.as(r.admin, http.MethodPost, "/printer-connectors/"+connector.String()+"/enrollments", nil),
		http.StatusCreated,
	)
	credID, token := r.newCredential()
	r.expect(r.bearer(issue["enrollmentSecret"].(string), http.MethodPost, "/printer-connector/enroll", map[string]any{
		"credentialId": credID, "credentialSecret": token, "softwareVersion": "test", "protocolVersion": 1,
	}), http.StatusOK)
	return token
}

func (r *relayEnv) publish() {
	r.t.Helper()
	r.expect(r.as(r.staff, http.MethodPost, "/signage/displays/"+r.displayID+"/publish", nil), http.StatusOK)
}

// showOnly replaces the scene's camera widget with a status widget for the same machine.
func (r *relayEnv) showOnlyStatus() {
	r.t.Helper()
	input := sceneInput("Relay camera", "full")
	input.Zones = map[string]json.RawMessage{"main": json.RawMessage(
		`{"type":"status","machineIds":["` + r.machine.String() + `"],"showProgress":true,"showRemaining":true}`,
	)}
	if _, err := r.fixture.service.UpdateScene(testContext(r.t), r.fixture.admin, r.scene.ID, r.sceneVersion, input, nil); err != nil {
		r.t.Fatal(err)
	}
	r.sceneVersion++
}

func (r *relayEnv) updateDisplay(visible bool, allowOutside bool) {
	r.t.Helper()
	r.expect(r.as(r.staff, http.MethodPut, "/signage/displays/"+r.displayID, map[string]any{
		"expectedVersion": r.displayVersion(r.staff, r.displayID), "name": r.displayName, "location": r.displayLoc,
		"orientation": "landscape", "resolution": map[string]any{"width": 1920, "height": 1080},
		"visibleFromOutside": visible, "allowCameraOutside": allowOutside, "defaultPlaylistId": r.playlistID,
	}), http.StatusOK)
}

func (r *relayEnv) wsURL(path string) string {
	return "ws" + strings.TrimPrefix(r.api, "http") + path
}

func (r *relayEnv) streamPath(machine uuid.UUID) string {
	return "/signage/player/cameras/" + machine.String() + "/stream"
}

// dial opens a websocket. On a refused upgrade it returns the status and the error code of the JSON body.
func (r *relayEnv) dial(path string, header http.Header) (*websocket.Conn, int, string) {
	r.t.Helper()
	conn, response, err := websocket.DefaultDialer.Dial(r.wsURL(path), header)
	if err == nil {
		_ = response.Body.Close()
		r.t.Cleanup(func() { _ = conn.Close() })
		return conn, http.StatusSwitchingProtocols, ""
	}
	if response == nil {
		r.t.Fatalf("dial %s: %v", path, err)
	}
	defer response.Body.Close()
	if response.Header.Get("Cache-Control") != "no-store" {
		r.t.Fatalf("refused upgrade without Cache-Control: no-store: %v", response.Header)
	}
	var body struct {
		Code string `json:"code"`
	}
	raw, _ := io.ReadAll(response.Body)
	_ = json.Unmarshal(raw, &body)
	return nil, response.StatusCode, body.Code
}

func (r *relayEnv) viewer(machine uuid.UUID) (*websocket.Conn, int, string) {
	r.t.Helper()
	return r.dial(r.streamPath(machine), http.Header{"X-Managed-Device-Token": {r.deviceToken}})
}

func (r *relayEnv) expectViewerRefused(machine uuid.UUID, status int, code string) {
	r.t.Helper()
	if _, got, gotCode := r.viewer(machine); got != status || (code != "" && gotCode != code) {
		r.t.Fatalf("viewer upgrade = %d %s, want %d %s", got, gotCode, status, code)
	}
}

func (r *relayEnv) liveStreams() []any {
	r.t.Helper()
	return r.expect(r.do(r.player, "", http.MethodGet, "/signage/player/live", nil), http.StatusOK)["streams"].([]any)
}

// fakeConnector plays the local service: it keeps the control channel, answers every open by dialing the session
// and echoes the viewer's frames after a greeting of one text and one binary frame.
type fakeConnector struct {
	env     *relayEnv
	token   string
	control *websocket.Conn
	opens   chan string
	ended   chan error
	mu      sync.Mutex
	data    []*websocket.Conn
}

var greeting = []byte{0x00, 0x00, 0x00, 0x1c, 'f', 't', 'y', 'p'}

func (r *relayEnv) startConnector(token string) *fakeConnector {
	r.t.Helper()
	control, status, code := r.dial("/printer-connector/self/stream-control", http.Header{"Authorization": {"Bearer " + token}})
	if status != http.StatusSwitchingProtocols {
		r.t.Fatalf("control channel = %d %s", status, code)
	}
	f := &fakeConnector{env: r, token: token, control: control, opens: make(chan string, 16), ended: make(chan error, 1)}
	registered := make(chan struct{})
	var once sync.Once
	control.SetPingHandler(func(data string) error {
		once.Do(func() { close(registered) })
		return control.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(time.Second))
	})
	go func() {
		for {
			_, raw, err := control.ReadMessage()
			if err != nil {
				f.ended <- err
				return
			}
			var message struct{ Type, SessionID, Stream string }
			if json.Unmarshal(raw, &message) != nil || message.Type != "open" {
				continue
			}
			f.opens <- message.SessionID
			if message.Stream != "cam-"+r.assignment.String() {
				continue // a real connector refuses streams outside its configuration
			}
			f.serve(message.SessionID)
		}
	}()
	// The hub pings only registered control channels.
	select {
	case <-registered:
	case <-time.After(5 * time.Second):
		r.t.Fatal("control channel never registered")
	}
	return f
}

func (f *fakeConnector) serve(sessionID string) {
	conn, response, err := websocket.DefaultDialer.Dial(
		f.env.wsURL("/printer-connector/self/stream-sessions/"+sessionID),
		http.Header{"Authorization": {"Bearer " + f.token}},
	)
	if err != nil {
		return
	}
	_ = response.Body.Close()
	f.mu.Lock()
	f.data = append(f.data, conn)
	f.mu.Unlock()
	go func() {
		defer conn.Close()
		if conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"mse","value":"avc1.640029"}`)) != nil ||
			conn.WriteMessage(websocket.BinaryMessage, greeting) != nil {
			return
		}
		for {
			kind, payload, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if conn.WriteMessage(kind, payload) != nil {
				return
			}
		}
	}()
}

func readFrame(t *testing.T, conn *websocket.Conn) (int, []byte) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	kind, payload, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	return kind, payload
}

// expectViewerClosed waits (well within the re-authorization interval plus slack) for the given close code.
func expectViewerClosed(t *testing.T, conn *websocket.Conn, code int) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		_, _, err := conn.ReadMessage()
		if err == nil {
			continue
		}
		var closeErr *websocket.CloseError
		if !errors.As(err, &closeErr) || closeErr.Code != code {
			t.Fatalf("viewer ended with %v, want close code %d", err, code)
		}
		return
	}
}

func expectStreaming(t *testing.T, viewer *websocket.Conn) {
	t.Helper()
	if kind, payload := readFrame(t, viewer); kind != websocket.TextMessage || !strings.Contains(string(payload), `"mse"`) {
		t.Fatalf("first frame = %d %s", kind, payload)
	}
	if kind, payload := readFrame(t, viewer); kind != websocket.BinaryMessage || string(payload) != string(greeting) {
		t.Fatalf("second frame = %d %v", kind, payload)
	}
}

func TestCameraRelayStreamsTheCameraToItsDisplayEndToEnd(t *testing.T) {
	r := newRelayEnv(t)

	// The live data offers exactly the published camera, as a relative path without a ticket.
	streams := r.liveStreams()
	if len(streams) != 1 {
		t.Fatalf("streams = %v", streams)
	}
	stream := streams[0].(map[string]any)
	if stream["machineId"] != r.machine.String() || stream["path"] != "/api/v1"+r.streamPath(r.machine) || len(stream) != 2 {
		t.Fatalf("stream = %v", stream)
	}
	// Without the local service's control channel the camera is offline.
	r.expectViewerRefused(r.machine, http.StatusConflict, "camera_offline")

	connector := r.startConnector(r.connectorToken)
	viewer, status, code := r.viewer(r.machine)
	if status != http.StatusSwitchingProtocols {
		t.Fatalf("viewer upgrade = %d %s", status, code)
	}
	expectStreaming(t, viewer)
	// Viewer text frames reach the connector and come back with their type; media frames keep theirs.
	request := []byte(`{"type":"mse","value":"avc1.640029,mp4a.40.2"}`)
	if err := viewer.WriteMessage(websocket.TextMessage, request); err != nil {
		t.Fatal(err)
	}
	if kind, payload := readFrame(t, viewer); kind != websocket.TextMessage || string(payload) != string(request) {
		t.Fatalf("echo = %d %s", kind, payload)
	}
	// A binary frame from the viewer ends the session.
	if err := viewer.WriteMessage(websocket.BinaryMessage, []byte{1}); err != nil {
		t.Fatal(err)
	}
	expectViewerClosed(t, viewer, websocket.CloseUnsupportedData)

	// A browser upgrade with the device cookie needs the application's origin.
	cookie := http.Header{"Cookie": {signageDeviceCookie + "=" + r.deviceToken}}
	if _, status, code = r.dial(r.streamPath(r.machine), cookie); status != http.StatusForbidden || code != "origin_invalid" {
		t.Fatalf("cookie without origin = %d %s", status, code)
	}
	foreign := http.Header{"Cookie": cookie["Cookie"], "Origin": {"https://evil.example"}}
	if _, status, code = r.dial(r.streamPath(r.machine), foreign); status != http.StatusForbidden || code != "origin_invalid" {
		t.Fatalf("cookie with a foreign origin = %d %s", status, code)
	}
	sameOrigin := http.Header{"Cookie": cookie["Cookie"], "Origin": {r.origin}}
	browser, status, code := r.dial(r.streamPath(r.machine), sameOrigin)
	if status != http.StatusSwitchingProtocols {
		t.Fatalf("browser upgrade = %d %s", status, code)
	}
	expectStreaming(t, browser)
	_ = browser.Close()
	// Every accepted viewer was opened through the control channel.
	for range 2 {
		select {
		case <-connector.opens:
		case <-time.After(5 * time.Second):
			t.Fatal("a viewer was not opened through the control channel")
		}
	}

	// A plain GET is not a websocket upgrade; the refusal keeps the JSON envelope and no-store.
	response := r.do(r.player, "", http.MethodGet, r.streamPath(r.machine), nil)
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q", response.Header.Get("Cache-Control"))
	}
	r.expectCode(response, http.StatusBadRequest, "websocket_required")
}

func TestCameraRelayRefusesViewersThatMayNotWatch(t *testing.T) {
	r := newRelayEnv(t)
	r.startConnector(r.connectorToken)

	// No credential, a forged one, and a staff session are not a signage player.
	if _, status, _ := r.dial(r.streamPath(r.machine), nil); status != http.StatusUnauthorized {
		t.Fatalf("anonymous = %d", status)
	}
	if _, status, _ := r.dial(r.streamPath(r.machine), http.Header{"X-Managed-Device-Token": {"AAAA"}}); status != http.StatusUnauthorized {
		t.Fatalf("forged token = %d", status)
	}

	// A machine that the published scene does not show, and an unknown machine, are forbidden.
	other := r.bambu("Unshown printer", "bambu_x1c", "192.168.1.96", "40000002")
	if _, err := r.pool.Exec(testContext(t), `UPDATE printer_connector_assignments SET camera_streaming = true WHERE machine_id = $1`, other); err != nil {
		t.Fatal(err)
	}
	r.expectViewerRefused(other, http.StatusForbidden, "camera_forbidden")
	r.expectViewerRefused(uuid.Must(uuid.NewV7()), http.StatusForbidden, "camera_forbidden")

	// Another paired display whose published scene has no camera may not watch this one.
	statusScene := sceneInput("Status only", "full")
	statusScene.Zones = map[string]json.RawMessage{"main": json.RawMessage(
		`{"type":"status","machineIds":["` + r.machine.String() + `"],"showProgress":true,"showRemaining":true}`,
	)}
	scene, err := r.fixture.service.CreateScene(testContext(t), r.fixture.admin, statusScene, nil)
	if err != nil {
		t.Fatal(err)
	}
	plain, plainPlayer := r.pair(r.staff, "Status display", r.fixture.playlist(t, "Status", scene.ID).ID)
	r.expect(r.as(r.staff, http.MethodPost, "/signage/displays/"+plain["id"].(string)+"/publish", nil), http.StatusOK)
	plainToken := r.deviceToken
	r.deviceToken = r.connectorEnv.deviceToken(plainPlayer)
	r.expectViewerRefused(r.machine, http.StatusForbidden, "camera_forbidden")
	r.deviceToken = plainToken

	// Visible from outside: only with allowCameraOutside, for the live data and the relay alike.
	r.updateDisplay(true, false)
	if streams := r.liveStreams(); len(streams) != 0 {
		t.Fatalf("outside display without the setting got streams: %v", streams)
	}
	r.expectViewerRefused(r.machine, http.StatusForbidden, "camera_forbidden")
	r.updateDisplay(true, true)
	if streams := r.liveStreams(); len(streams) != 1 {
		t.Fatalf("outside display with the setting: %v", streams)
	}
	viewer, status, code := r.viewer(r.machine)
	if status != http.StatusSwitchingProtocols {
		t.Fatalf("outside display with the setting = %d %s", status, code)
	}
	expectStreaming(t, viewer)
	_ = viewer.Close()
	r.updateDisplay(false, false)

	// Camera switched off: the machine has no streaming camera; the live data drops it.
	if _, err := r.pool.Exec(testContext(t), `UPDATE printer_connector_assignments SET camera_streaming = false WHERE id = $1`, r.assignment); err != nil {
		t.Fatal(err)
	}
	r.expectViewerRefused(r.machine, http.StatusNotFound, "camera_not_found")
	if streams := r.liveStreams(); len(streams) != 0 {
		t.Fatalf("camera off still offered: %v", streams)
	}
	if _, err := r.pool.Exec(testContext(t), `UPDATE printer_connector_assignments SET camera_streaming = true WHERE id = $1`, r.assignment); err != nil {
		t.Fatal(err)
	}

	// The preview is not the display: it never offers streams.
	preview := r.expect(r.as(r.staff, http.MethodGet, "/signage/displays/"+r.displayID+"/preview", nil), http.StatusOK)
	if got := preview["live"].(map[string]any)["streams"].([]any); len(got) != 0 {
		t.Fatalf("preview streams = %v", got)
	}

	// A revoked display's device credential no longer authenticates.
	r.expect(r.as(r.staff, http.MethodPost, "/signage/displays/"+r.displayID+"/revoke", map[string]any{
		"expectedVersion": r.displayVersion(r.staff, r.displayID),
	}), http.StatusOK)
	if _, status, _ := r.viewer(r.machine); status != http.StatusUnauthorized && status != http.StatusForbidden {
		t.Fatalf("revoked display = %d", status)
	}
}

func TestCameraRelayReauthorizationEndsRunningStreams(t *testing.T) {
	r := newRelayEnv(t)
	r.startConnector(r.connectorToken)
	open := func() *websocket.Conn {
		t.Helper()
		viewer, status, code := r.viewer(r.machine)
		if status != http.StatusSwitchingProtocols {
			t.Fatalf("viewer upgrade = %d %s", status, code)
		}
		expectStreaming(t, viewer)
		return viewer
	}

	// Switching the camera off ends the stream as "camera gone".
	viewer := open()
	if _, err := r.pool.Exec(testContext(t), `UPDATE printer_connector_assignments SET camera_streaming = false WHERE id = $1`, r.assignment); err != nil {
		t.Fatal(err)
	}
	expectViewerClosed(t, viewer, camerarelay.CloseCameraGone)
	if _, err := r.pool.Exec(testContext(t), `UPDATE printer_connector_assignments SET camera_streaming = true WHERE id = $1`, r.assignment); err != nil {
		t.Fatal(err)
	}

	// Moving the display outside without the setting ends it as forbidden.
	viewer = open()
	r.updateDisplay(true, false)
	expectViewerClosed(t, viewer, camerarelay.CloseForbidden)
	r.updateDisplay(false, false)

	// Republishing without the camera ends it as forbidden.
	viewer = open()
	r.showOnlyStatus()
	r.publish()
	expectViewerClosed(t, viewer, camerarelay.CloseForbidden)
	input := sceneInput("Relay camera", "full")
	input.Zones = map[string]json.RawMessage{"main": cameraWidget(r.machine)}
	if _, err := r.fixture.service.UpdateScene(testContext(t), r.fixture.admin, r.scene.ID, r.sceneVersion, input, nil); err != nil {
		t.Fatal(err)
	}
	r.sceneVersion++
	r.publish()

	// Revoking the display ends it as forbidden.
	viewer = open()
	r.expect(r.as(r.staff, http.MethodPost, "/signage/displays/"+r.displayID+"/revoke", map[string]any{
		"expectedVersion": r.displayVersion(r.staff, r.displayID),
	}), http.StatusOK)
	expectViewerClosed(t, viewer, camerarelay.CloseForbidden)
}

func TestCameraRelaySessionsAndControlBelongToTheirConnector(t *testing.T) {
	r := newRelayEnv(t)
	// A second connector with its own credential.
	_, otherConnector := r.bambuWithConnector("Other relay printer", "bambu_x1c", "192.168.1.97", "40000003")
	otherToken := r.enroll(otherConnector)

	// The control channel needs the bearer credential and a websocket upgrade.
	if _, status, _ := r.dial("/printer-connector/self/stream-control", nil); status != http.StatusUnauthorized {
		t.Fatalf("control without credential = %d", status)
	}
	if _, status, _ := r.dial("/printer-connector/self/stream-control", http.Header{"Authorization": {"Bearer nope"}}); status != http.StatusUnauthorized {
		t.Fatalf("control with a forged credential = %d", status)
	}
	r.expectCode(r.bearer(r.connectorToken, http.MethodGet, "/printer-connector/self/stream-control", nil), http.StatusBadRequest, "websocket_required")

	// A connector that never answers: the viewer gets 503 after the pending timeout.
	silent := r.startConnectorWithout(r.connectorToken)
	started := time.Now()
	r.expectViewerRefused(r.machine, http.StatusServiceUnavailable, "camera_unavailable")
	if time.Since(started) < relayTiming.PendingTimeout {
		t.Fatalf("gave up after %v", time.Since(started))
	}
	sessionID := <-silent

	// The expired session is gone, for its own connector too.
	path := "/printer-connector/self/stream-sessions/" + sessionID
	if _, status, code := r.dial(path, http.Header{"Authorization": {"Bearer " + r.connectorToken}}); status != http.StatusNotFound {
		t.Fatalf("expired session = %d %s", status, code)
	}

	// While a session is pending, another connector cannot take it.
	pending := r.startConnectorWithout(r.connectorToken)
	refused := make(chan int, 1)
	go func() {
		// Not through r.viewer: a goroutine must not fail the test itself.
		conn, response, err := websocket.DefaultDialer.Dial(
			r.wsURL(r.streamPath(r.machine)),
			http.Header{"X-Managed-Device-Token": {r.deviceToken}},
		)
		if response != nil {
			_ = response.Body.Close()
			refused <- response.StatusCode
		} else {
			refused <- 0
		}
		if err == nil {
			_ = conn.Close()
		}
	}()
	sessionID = <-pending
	path = "/printer-connector/self/stream-sessions/" + sessionID
	if _, status, code := r.dial(path, http.Header{"Authorization": {"Bearer " + otherToken}}); status != http.StatusNotFound {
		t.Fatalf("another connector's session = %d %s", status, code)
	}
	if _, status, _ := r.dial(path, nil); status != http.StatusUnauthorized {
		t.Fatalf("session without credential = %d", status)
	}
	// The rightful connector still can.
	data, status, code := r.dial(path, http.Header{"Authorization": {"Bearer " + r.connectorToken}})
	if status != http.StatusSwitchingProtocols {
		t.Fatalf("own session = %d %s", status, code)
	}
	_ = data.Close()
	if got := <-refused; got != http.StatusSwitchingProtocols {
		t.Fatalf("viewer = %d", got)
	}

	// A disabled connector may not open a control channel.
	if _, err := r.pool.Exec(testContext(t), `UPDATE printer_connectors SET lifecycle = 'disabled' WHERE id = $1`, otherConnector); err != nil {
		t.Fatal(err)
	}
	if _, status, code := r.dial("/printer-connector/self/stream-control", http.Header{"Authorization": {"Bearer " + otherToken}}); status != http.StatusForbidden {
		t.Fatalf("disabled connector control = %d %s", status, code)
	}
}

// startConnectorWithout opens a control channel that reports the session ids it is asked to open but never dials them.
func (r *relayEnv) startConnectorWithout(token string) chan string {
	r.t.Helper()
	control, status, code := r.dial("/printer-connector/self/stream-control", http.Header{"Authorization": {"Bearer " + token}})
	if status != http.StatusSwitchingProtocols {
		r.t.Fatalf("control channel = %d %s", status, code)
	}
	registered := make(chan struct{})
	var once sync.Once
	control.SetPingHandler(func(data string) error {
		once.Do(func() { close(registered) })
		return control.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(time.Second))
	})
	sessions := make(chan string, 16)
	go func() {
		for {
			_, raw, err := control.ReadMessage()
			if err != nil {
				return
			}
			var message struct{ Type, SessionID string }
			if json.Unmarshal(raw, &message) == nil && message.Type == "open" {
				sessions <- message.SessionID
			}
		}
	}()
	select {
	case <-registered:
	case <-time.After(5 * time.Second):
		r.t.Fatal("control channel never registered")
	}
	return sessions
}
