package integration_test

import (
	"bytes"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/signage"
)

// countingBody is an endless body that records how much of it was consumed.
type countingBody struct{ read atomic.Int64 }

func (b *countingBody) Read(p []byte) (int, error) {
	b.read.Add(int64(len(p)))
	return len(p), nil
}
func (b *countingBody) Close() error { return nil }

// Raw binary upload routes must not be buffered by the OpenAPI validator before authentication.
func TestUnauthenticatedRawUploadsAreRejectedWithoutReadingTheBody(t *testing.T) {
	pool := migratedPool(t)
	cfg := integrationConfig(t)
	cfg.LocalStorageRoot = t.TempDir()
	handler, err := httpapi.NewHandler(pool, cfg, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	routes := []struct {
		method, path string
		headers      map[string]string
	}{
		{
			http.MethodPost,
			"/api/v1/signage/assets",
			map[string]string{"X-File-Name": "a.mp4", "X-File-Content-Type": "video/mp4"},
		},
		{
			http.MethodPost,
			"/api/v1/events/01a00000-0000-7000-8000-000000000001/files",
			map[string]string{
				"X-File-Name":             "a.bin",
				"X-File-Content-Type":     "application/pdf",
				"X-Event-File-Visibility": "internal",
			},
		},
		{
			http.MethodPut,
			"/api/v1/printer-connector/self/assignments/01a00000-0000-7000-8000-000000000001/artifact",
			map[string]string{
				"Authorization":           "Bearer nope",
				"X-Configuration-Version": "1",
				"X-Artifact-Filename":     "a.3mf",
				"X-Artifact-SHA256":       "00000000000000000000000000000000000000000000000000000000000000aa",
			},
		},
	}
	for _, route := range routes {
		body := &countingBody{}
		request := httptest.NewRequest(route.method, route.path, body)
		request.ContentLength = 150 << 20
		request.Header.Set("Content-Type", "application/octet-stream")
		request.Header.Set("Origin", cfg.PublicBaseURL.String())
		for name, value := range route.headers {
			request.Header.Set(name, value)
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code < 400 || recorder.Code >= 500 {
			t.Errorf("%s %s: status = %d, want a 4xx rejection", route.method, route.path, recorder.Code)
		}
		if read := body.read.Load(); read != 0 {
			t.Errorf("%s %s: %d body bytes were read before authentication", route.method, route.path, read)
		}
	}
}

// Header validation of raw uploads still runs for authenticated callers.
func TestSignageAssetUploadStillValidatesHeaders(t *testing.T) {
	e := newSignageEnv(t)
	staff := e.allStaff()
	image := signageJPEG(t, 64, 64)
	send := func(headers ...string) *http.Response {
		return e.doRaw(staff.client, staff.csrf, http.MethodPost, "/signage/assets", image, headers...)
	}
	e.expectCode(
		send("X-File-Name", "a.jpg", "X-File-Content-Type", "application/pdf"),
		http.StatusBadRequest,
		"invalid_request",
	)
	e.expectCode(send("X-File-Content-Type", "image/jpeg"), http.StatusBadRequest, "invalid_request")
	e.expect(send("X-File-Name", "a.jpg", "X-File-Content-Type", "image/jpeg"), http.StatusCreated)
}

func TestSignageImageDimensionCaps(t *testing.T) {
	f := newSignageFixture(t)
	ctx := testContext(t)
	for _, size := range [][2]int{{8193, 8}, {7000, 6000}} {
		_, err := f.service.UploadAsset(
			ctx,
			f.admin,
			signage.UploadInput{
				Name:        "big.jpg",
				ContentType: "image/jpeg",
				Body:        bytes.NewReader(signageJPEG(t, size[0], size[1])),
			},
			nil,
		)
		var appErr *apperror.Error
		if !errors.As(err, &appErr) || appErr.HTTPStatus != http.StatusUnprocessableEntity {
			t.Errorf("%v: err = %v, want 422", size, err)
		}
	}
}

func TestSignagePairingHardening(t *testing.T) {
	e := newSignageEnv(t)
	staff := e.allStaff()
	_, playlist := e.seedContent("Hardening")

	// A garbage cookie never reaches the database or the rate limiter.
	for i := 0; i < 80; i++ {
		if poll := e.expect(
			e.do(
				e.newPlayer(),
				"",
				http.MethodGet,
				"/public/signage/pairing",
				nil,
				"Cookie",
				signagePairingCookie+"=not-a-token",
			),
			http.StatusOK,
		); poll["status"] != "expired" {
			t.Fatalf("poll = %v", poll)
		}
	}

	// Restarting after the claim keeps the claimed request collectable.
	player := e.newPlayer()
	start := e.expect(e.do(player, "", http.MethodPost, "/public/signage/pairing", nil), http.StatusCreated)
	e.expect(e.as(staff, http.MethodPost, "/signage/displays", map[string]any{
		"code": start["code"], "name": "Restart", "location": "", "orientation": "landscape",
		"resolution": map[string]any{
			"width":  1920,
			"height": 1080,
		}, "visibleFromOutside": false, "defaultPlaylistId": playlist.ID.String(),
	}), http.StatusCreated)
	e.expectCode(
		e.do(player, "", http.MethodPost, "/public/signage/pairing", nil),
		http.StatusConflict,
		"pairing_claimed",
	)
	if poll := e.expect(
		e.do(player, "", http.MethodGet, "/public/signage/pairing", nil),
		http.StatusOK,
	); poll["status"] != "paired" {
		t.Fatalf("claimed request was lost by a restart: %v", poll)
	}

	// Per-IP poll limit: 60 per minute for a well-formed cookie.
	valid := e.newPlayer()
	e.expect(e.do(valid, "", http.MethodPost, "/public/signage/pairing", nil), http.StatusCreated)
	limited := 0
	for i := 0; i < 70; i++ {
		response := e.do(valid, "", http.MethodGet, "/public/signage/pairing", nil)
		if response.StatusCode == http.StatusTooManyRequests {
			limited++
		}
		response.Body.Close()
	}
	if limited == 0 {
		t.Fatal("pairing polls were never rate limited")
	}
}

func TestSignagePairingAllowedCIDRs(t *testing.T) {
	denied := newSignageEnvWith(t, func(c *config.Config) {
		c.SignagePairingAllowedCIDRs = []netip.Prefix{netip.MustParsePrefix("192.0.2.0/24")}
	})
	denied.expectCode(
		denied.do(denied.newPlayer(), "", http.MethodPost, "/public/signage/pairing", nil),
		http.StatusForbidden,
		"pairing_network_denied",
	)
	allowed := newSignageEnvWith(t, func(c *config.Config) {
		c.SignagePairingAllowedCIDRs = []netip.Prefix{
			netip.MustParsePrefix("127.0.0.0/8"),
			netip.MustParsePrefix("::1/128"),
		}
	})
	allowed.expect(
		allowed.do(allowed.newPlayer(), "", http.MethodPost, "/public/signage/pairing", nil),
		http.StatusCreated,
	)
}

func TestSignagePlayerRequestsAreRateLimitedPerDevice(t *testing.T) {
	e := newSignageEnv(t)
	staff := e.allStaff()
	_, playlist := e.seedContent("Rate")
	_, player := e.pair(staff, "Rate", playlist.ID)
	_, other := e.pair(staff, "Rate two", playlist.ID)
	statuses := map[int]int{}
	for i := 0; i < 125; i++ {
		response := e.do(player, "", http.MethodGet, "/signage/player/manifest", nil)
		statuses[response.StatusCode]++
		response.Body.Close()
	}
	if statuses[http.StatusTooManyRequests] != 5 {
		t.Fatalf("statuses = %v, want exactly 5 rate-limited requests", statuses)
	}
	response := e.do(other, "", http.MethodGet, "/signage/player/manifest", nil)
	defer response.Body.Close()
	if response.StatusCode == http.StatusTooManyRequests {
		t.Fatal("the limit must be per device")
	}
}

// A concurrent change to the display aborts the repeatable-read publish snapshot; that is a 409, not a 500.
func TestSignagePublishSerializationFailureIsStaleWrite(t *testing.T) {
	f := newSignageFixture(t)
	ctx := testContext(t)
	playlist := f.playlist(t, "Race", f.scene(t, "Race scene").ID)
	displayID := f.display(t, "Race display", playlist.ID)
	writer, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = writer.Rollback(ctx) }()
	if _, err := writer.Exec(
		ctx,
		`UPDATE signage_displays SET name = 'Renamed', version = version + 1 WHERE id = $1`,
		displayID,
	); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := f.service.PublishDisplay(ctx, f.admin, displayID, nil)
		result <- err
	}()
	time.Sleep(500 * time.Millisecond) // the publish is now waiting for the row lock
	if err := writer.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if !errors.Is(err, apperror.StaleWrite) {
			t.Fatalf("PublishDisplay error = %v, want stale_write", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("publish did not return")
	}
	if _, err := f.service.PublishDisplay(ctx, f.admin, displayID, nil); err != nil {
		t.Fatalf("publish after the change = %v", err)
	}
}

// doRaw sends raw bytes as an octet-stream with the same-origin and CSRF headers.
func (e *signageEnv) doRaw(
	client *http.Client,
	csrf, method, path string,
	body []byte,
	headers ...string,
) *http.Response {
	e.t.Helper()
	request, err := http.NewRequestWithContext(testContext(e.t), method, e.api+path, bytes.NewReader(body))
	if err != nil {
		e.t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/octet-stream")
	request.Header.Set("Origin", e.origin)
	request.Header.Set("X-CSRF-Token", csrf)
	for index := 0; index+1 < len(headers); index += 2 {
		request.Header.Set(headers[index], headers[index+1])
	}
	response, err := client.Do(request)
	if err != nil {
		e.t.Fatal(err)
	}
	return response
}
