package printerconnector

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

// reenrollCore accepts only the enrollment secrets listed in accepted; every other bearer gets 401.
type reenrollCore struct {
	mu       sync.Mutex
	accepted map[string]uuid.UUID
	tokens   []string
}

func (c *reenrollCore) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	c.mu.Lock()
	c.tokens = append(c.tokens, token)
	id, ok := c.accepted[token]
	c.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	if !ok {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{"code": "unauthenticated", "message": "bad token " + token})
		return
	}
	_ = json.NewEncoder(w).
		Encode(map[string]any{"connectorId": id, "credentialExpiresAt": time.Now().UTC().Add(30 * 24 * time.Hour)})
}

func newReenrollRuntime(
	t *testing.T,
	core *reenrollCore,
	dir string,
	enrollment Enrollment,
	logs *bytes.Buffer,
) (*Runtime, *Store) {
	t.Helper()
	server := httptest.NewServer(core)
	t.Cleanup(server.Close)
	client, err := NewClient(server.URL, true)
	if err != nil {
		t.Fatal(err)
	}
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return NewRuntime(store, client, dir, enrollment, slog.New(slog.NewTextHandler(logs, nil))), store
}

func TestNewEnrollmentSecretReplacesTheIdentity(t *testing.T) {
	first, second := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	core := &reenrollCore{accepted: map[string]uuid.UUID{"old-secret": first, "new-secret": second}}
	dir := filepath.Join(t.TempDir(), "data")
	var logs bytes.Buffer
	runtime, store := newReenrollRuntime(t, core, dir, Enrollment{Secret: "old-secret"}, &logs)
	before, err := runtime.ensureIdentity(context.Background())
	if err != nil || before.ConnectorID != first {
		t.Fatalf("%+v %v", before, err)
	}
	if err = store.SaveConfiguration(context.Background(), Configuration{Revision: 1}); err != nil {
		t.Fatal(err)
	}
	runtime.enrollment = Enrollment{Secret: "new-secret"}
	after, err := runtime.ensureIdentity(context.Background())
	if err != nil || after.ConnectorID != second || after.CredentialID == before.CredentialID ||
		after.CredentialSecret == before.CredentialSecret {
		t.Fatalf("identity not replaced: %+v %v", after, err)
	}
	stored, _ := store.Identity(context.Background())
	if stored.ConnectorID != second || stored.EnrollmentDigest != enrollmentDigest("new-secret") {
		t.Fatalf("stored identity %+v", stored)
	}
	if cached, _ := store.Configuration(context.Background()); cached != nil {
		t.Fatal("cached configuration of the old connector must be cleared")
	}
	// Same secret again: ignored.
	if _, err = runtime.ensureIdentity(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(core.tokens) != 2 {
		t.Fatalf("unchanged secret must not enroll again: %q", core.tokens)
	}
	for _, secret := range []string{"old-secret", "new-secret", enrollmentDigest("new-secret")} {
		if strings.Contains(logs.String(), secret) {
			t.Fatalf("log leaks %q: %s", secret, logs.String())
		}
	}
}

func TestSameEnrollmentSecretIsIgnored(t *testing.T) {
	core := &reenrollCore{accepted: map[string]uuid.UUID{"s": uuid.Must(uuid.NewV7())}}
	var logs bytes.Buffer
	runtime, _ := newReenrollRuntime(t, core, filepath.Join(t.TempDir(), "d"), Enrollment{Secret: " s\n"}, &logs)
	for range 3 {
		if _, err := runtime.ensureIdentity(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if len(core.tokens) != 1 || !strings.Contains(logs.String(), "is ignored and can be removed") {
		t.Fatalf("tokens %q logs %s", core.tokens, logs.String())
	}
}

func TestFailedReenrollmentKeepsTheOldIdentity(t *testing.T) {
	first := uuid.Must(uuid.NewV7())
	core := &reenrollCore{accepted: map[string]uuid.UUID{"old": first}}
	var logs bytes.Buffer
	runtime, store := newReenrollRuntime(t, core, filepath.Join(t.TempDir(), "d"), Enrollment{Secret: "old"}, &logs)
	before, err := runtime.ensureIdentity(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	runtime.enrollment = Enrollment{Secret: "bad-new-secret"}
	after, err := runtime.ensureIdentity(context.Background())
	if err != nil || after.ConnectorID != first || after.CredentialID != before.CredentialID {
		t.Fatalf("old identity must stay: %+v %v", after, err)
	}
	stored, _ := store.Identity(context.Background())
	if stored.CredentialID != before.CredentialID || stored.EnrollmentDigest != enrollmentDigest("old") {
		t.Fatalf("stored identity changed: %+v", stored)
	}
	out := logs.String()
	if !strings.Contains(out, "not accepted by Core") || !strings.Contains(out, "status=401") ||
		!strings.Contains(out, "code=unauthenticated") ||
		strings.Contains(out, "bad-new-secret") {
		t.Fatalf("unexpected log: %s", out)
	}
}

func TestLegacyIdentityWithoutDigestReenrollsWhenASecretIsSet(t *testing.T) {
	second := uuid.Must(uuid.NewV7())
	core := &reenrollCore{accepted: map[string]uuid.UUID{"fresh": second}}
	runtime, store := newReenrollRuntime(
		t,
		core,
		filepath.Join(t.TempDir(), "d"),
		Enrollment{Secret: "fresh"},
		&bytes.Buffer{},
	)
	legacy := Identity{
		ConnectorID:         uuid.Must(uuid.NewV7()),
		CredentialID:        uuid.Must(uuid.NewV7()),
		CredentialSecret:    "x",
		Enrolled:            true,
		CredentialExpiresAt: time.Now().Add(time.Hour),
	}
	if err := store.SaveIdentity(context.Background(), legacy); err != nil {
		t.Fatal(err)
	}
	identity, err := runtime.ensureIdentity(context.Background())
	if err != nil || identity.ConnectorID != second || identity.EnrollmentDigest == "" {
		t.Fatalf("%+v %v", identity, err)
	}
}

func TestEnrolledIdentityWithoutASecretIsLeftAlone(t *testing.T) {
	core := &reenrollCore{}
	runtime, store := newReenrollRuntime(t, core, filepath.Join(t.TempDir(), "d"), Enrollment{}, &bytes.Buffer{})
	legacy := Identity{
		ConnectorID:      uuid.Must(uuid.NewV7()),
		CredentialID:     uuid.Must(uuid.NewV7()),
		CredentialSecret: "x",
		Enrolled:         true,
	}
	_ = store.SaveIdentity(context.Background(), legacy)
	identity, err := runtime.ensureIdentity(context.Background())
	if err != nil || identity.CredentialID != legacy.CredentialID || len(core.tokens) != 0 {
		t.Fatalf("%+v %v", identity, err)
	}
}

func TestCoreErrorsLogStatusAndCodeAndRejectionIsRateLimited(t *testing.T) {
	var logs bytes.Buffer
	runtime, _ := newReenrollRuntime(t, &reenrollCore{}, filepath.Join(t.TempDir(), "d"), Enrollment{}, &logs)
	clock := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	runtime.now = func() time.Time { return clock }
	rejected := &CoreError{Status: 401, Code: "unauthenticated"}
	runtime.logFailure("configuration sync failed", rejected)
	runtime.logFailure("heartbeat failed", rejected)
	out := logs.String()
	if !strings.Contains(out, "status=401") || !strings.Contains(out, "code=unauthenticated") {
		t.Fatalf("missing safe fields: %s", out)
	}
	if n := strings.Count(out, "Core rejects this connector's credential"); n != 1 ||
		!strings.Contains(out, "CONNECTOR_ENROLLMENT_SECRET") {
		t.Fatalf("expected one actionable error, got %d: %s", n, out)
	}
	clock = clock.Add(6 * time.Minute)
	runtime.logFailure("heartbeat failed", rejected)
	if n := strings.Count(logs.String(), "Core rejects this connector's credential"); n != 2 {
		t.Fatalf("expected a repeat after the interval, got %d", n)
	}
	logs.Reset()
	runtime.logFailure("heartbeat failed", &CoreError{Status: 429, Code: "rate_limited"})
	runtime.logFailure("heartbeat failed", errors.New("dial tcp: secret-host"))
	if strings.Contains(logs.String(), "Core rejects") || !strings.Contains(logs.String(), "code=rate_limited") ||
		strings.Contains(logs.String(), "secret-host") {
		t.Fatalf("unexpected log: %s", logs.String())
	}
}
