package streaminggateway

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func newReenrollGateway(t *testing.T, secret string) (*Gateway, *fakeCore, *bytes.Buffer) {
	t.Helper()
	g, core, _, _ := newTestGateway(t)
	logs := &bytes.Buffer{}
	g.logger = slog.New(slog.NewTextHandler(logs, nil))
	g.options.EnrollmentSecret = secret
	return g, core, logs
}

func TestNewEnrollmentSecretReplacesTheIdentity(t *testing.T) {
	g, core, logs := newReenrollGateway(t, "old-secret")
	before, err := g.ensureIdentity(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	g.options.EnrollmentSecret = "new-secret"
	after, err := g.ensureIdentity(context.Background())
	if err != nil || after.GatewayID == before.GatewayID || after.CredentialID == before.CredentialID ||
		after.CredentialSecret == before.CredentialSecret {
		t.Fatalf("identity not replaced: %+v %v", after, err)
	}
	if stored := g.store.Identity(); stored.GatewayID != after.GatewayID ||
		stored.EnrollmentDigest != enrollmentDigest("new-secret") {
		t.Fatalf("stored %+v", stored)
	}
	if _, err = g.ensureIdentity(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(core.enrollSecrets) != 2 || core.enrollSecrets[1] != "new-secret" {
		t.Fatalf("enrollments %q", core.enrollSecrets)
	}
	for _, leaked := range []string{"old-secret", "new-secret", enrollmentDigest("new-secret")} {
		if strings.Contains(logs.String(), leaked) {
			t.Fatalf("log leaks %q", leaked)
		}
	}
}

func TestSameEnrollmentSecretIsIgnored(t *testing.T) {
	g, core, logs := newReenrollGateway(t, "s")
	for range 3 {
		if _, err := g.ensureIdentity(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if len(core.enrollSecrets) != 1 || !strings.Contains(logs.String(), "is ignored and can be removed") {
		t.Fatalf("%q %s", core.enrollSecrets, logs)
	}
}

func TestFailedReenrollmentKeepsTheOldIdentity(t *testing.T) {
	g, core, logs := newReenrollGateway(t, "old")
	before, err := g.ensureIdentity(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	g.options.EnrollmentSecret = "bad-new-secret"
	core.enrollErr = &CoreError{Status: 401, Code: "unauthenticated"}
	after, err := g.ensureIdentity(context.Background())
	if err != nil || after.CredentialID != before.CredentialID || after.GatewayID != before.GatewayID {
		t.Fatalf("old identity must stay: %+v %v", after, err)
	}
	if stored := g.store.Identity(); stored.CredentialID != before.CredentialID ||
		stored.EnrollmentDigest != enrollmentDigest("old") {
		t.Fatalf("stored %+v", stored)
	}
	out := logs.String()
	if !strings.Contains(out, "not accepted by Core") || !strings.Contains(out, "status=401") ||
		!strings.Contains(out, "code=unauthenticated") ||
		strings.Contains(out, "bad-new-secret") {
		t.Fatalf("log: %s", out)
	}
}

func TestLegacyIdentityWithoutDigestReenrollsWhenASecretIsSet(t *testing.T) {
	g, core, _ := newReenrollGateway(t, "fresh")
	legacy := Identity{
		GatewayID:        uuid.Must(uuid.NewV7()),
		CredentialID:     uuid.Must(uuid.NewV7()),
		CredentialSecret: "x",
		Enrolled:         true,
	}
	if err := g.store.SaveIdentity(legacy); err != nil {
		t.Fatal(err)
	}
	identity, err := g.ensureIdentity(context.Background())
	if err != nil || identity.CredentialID == legacy.CredentialID || identity.EnrollmentDigest == "" ||
		len(core.enrollSecrets) != 1 {
		t.Fatalf("%+v %v", identity, err)
	}
}

func TestCoreErrorsLogStatusAndCodeAndRejectionIsRateLimited(t *testing.T) {
	g, _, logs := newReenrollGateway(t, "")
	clock := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	g.now = func() time.Time { return clock }
	rejected := &CoreError{Status: 401, Code: "unauthenticated"}
	g.logFailure("configuration sync failed", rejected)
	g.logFailure("heartbeat failed", rejected)
	out := logs.String()
	if !strings.Contains(out, "status=401") || !strings.Contains(out, "code=unauthenticated") {
		t.Fatalf("missing fields: %s", out)
	}
	if n := strings.Count(out, "Core rejects this gateway's credential"); n != 1 ||
		!strings.Contains(out, "STREAM_ENROLLMENT_SECRET") ||
		!strings.Contains(out, "Settings > Local services") {
		t.Fatalf("got %d: %s", n, out)
	}
	clock = clock.Add(6 * time.Minute)
	g.logFailure("heartbeat failed", rejected)
	if n := strings.Count(logs.String(), "Core rejects this gateway's credential"); n != 2 {
		t.Fatalf("got %d", n)
	}
	logs.Reset()
	g.logFailure("heartbeat failed", &CoreError{Status: 429, Code: "rate_limited"})
	g.logFailure("heartbeat failed", errors.New("dial tcp: secret-host"))
	if strings.Contains(logs.String(), "Core rejects") || !strings.Contains(logs.String(), "code=rate_limited") ||
		strings.Contains(logs.String(), "secret-host") {
		t.Fatalf("log: %s", logs)
	}
}
