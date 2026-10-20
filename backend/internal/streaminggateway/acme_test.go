package streaminggateway

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"log/slog"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testCertificate(t *testing.T, domain string, notBefore, notAfter time.Time) (certPEM, keyPEM []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: domain},
		DNSNames: []string{domain}, NotBefore: notBefore, NotAfter: notAfter}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
}

type fakeObtainer struct {
	t         *testing.T
	domain    string
	validity  time.Duration
	err       error
	calls     int
	lastKey   []byte
	startedAt time.Time
}

func (f *fakeObtainer) Obtain(_ context.Context, domain string) ([]byte, []byte, error) {
	f.calls++
	if f.err != nil {
		return nil, nil, f.err
	}
	if domain != f.domain {
		f.t.Fatalf("obtain for %q, want %q", domain, f.domain)
	}
	certPEM, keyPEM := testCertificate(f.t, domain, f.startedAt.Add(-time.Hour), f.startedAt.Add(f.validity))
	f.lastKey = keyPEM
	return certPEM, keyPEM, nil
}

const testToken = "cf-token-SECRET-123"

func newTestManager(t *testing.T, obtainer CertObtainer, logs *bytes.Buffer) *CertManager {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(logs, nil))
	m, err := NewCertManager(filepath.Join(t.TempDir(), "acme"), "signage-gw.example.org", obtainer, logger, testToken)
	if err != nil {
		t.Fatal(err)
	}
	m.jitter = func(time.Duration) time.Duration { return 0 }
	return m
}

func TestACMEDomain(t *testing.T) {
	good := map[string]string{
		"signage-gw.example.org:8443": "signage-gw.example.org",
		"Signage-GW.Example.org":      "signage-gw.example.org",
		"gw.example.org.":             "gw.example.org",
	}
	for input, want := range good {
		if got, err := ACMEDomain(input); err != nil || got != want {
			t.Errorf("ACMEDomain(%q) = %q, %v; want %q", input, got, err, want)
		}
	}
	for _, input := range []string{"", "192.168.1.20", "192.168.1.20:8443", "[::1]:8443", "::1", "localhost", "localhost:8443",
		"*.example.org", "https://gw.example.org", "gw.example.org/path", "a b.example.org", "-x.example.org", "gw..example.org", "gw_x.example.org"} {
		if got, err := ACMEDomain(input); err == nil {
			t.Errorf("ACMEDomain(%q) = %q, want error", input, got)
		}
	}
}

func TestSelectTLSMode(t *testing.T) {
	dir := t.TempDir()
	cert, key := filepath.Join(dir, "fullchain.pem"), filepath.Join(dir, "privkey.pem")
	host := "gw.example.org:8443"

	// Neither files nor ACME settings: a message that lists both options.
	_, err := SelectTLSMode(cert, key, host, "", "")
	if err == nil || !strings.Contains(err.Error(), "ACME_EMAIL") || !strings.Contains(err.Error(), "fullchain.pem") {
		t.Fatalf("want message listing both options, got %v", err)
	}
	// Only one ACME setting.
	if _, err = SelectTLSMode(cert, key, host, "a@example.org", ""); err == nil || !strings.Contains(err.Error(), "CLOUDFLARE_DNS_API_TOKEN") {
		t.Fatalf("want error about the missing token, got %v", err)
	}
	// ACME mode.
	selection, err := SelectTLSMode(cert, key, host, "a@example.org", "token")
	if err != nil || selection.Mode != TLSModeACME || selection.Domain != "gw.example.org" {
		t.Fatalf("got %+v, %v", selection, err)
	}
	// ACME with an IP is refused.
	if _, err = SelectTLSMode(cert, key, "192.168.1.20:8443", "a@example.org", "token"); err == nil {
		t.Fatal("expected an error for an IP address")
	}
	// One file only.
	if err = os.WriteFile(cert, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err = SelectTLSMode(cert, key, host, "a@example.org", "token"); err == nil {
		t.Fatal("expected an error when only one file exists")
	}
	// Files win over ACME settings, even for an IP host.
	if err = os.WriteFile(key, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	selection, err = SelectTLSMode(cert, key, "192.168.1.20:8443", "a@example.org", "token")
	if err != nil || selection.Mode != TLSModeFiles {
		t.Fatalf("got %+v, %v", selection, err)
	}
}

func TestParseACMEResolversAndDirectory(t *testing.T) {
	got, err := ParseACMEResolvers("")
	if err != nil || len(got) != 2 || got[0] != "1.1.1.1:53" || got[1] != "1.0.0.1:53" {
		t.Fatalf("defaults: %v %v", got, err)
	}
	got, err = ParseACMEResolvers("9.9.9.9, 8.8.8.8:5353,[2606:4700:4700::1111]:53")
	if err != nil || len(got) != 3 || got[0] != "9.9.9.9:53" || got[1] != "8.8.8.8:5353" {
		t.Fatalf("custom: %v %v", got, err)
	}
	if _, err = ParseACMEResolvers("dns.example.org"); err == nil {
		t.Fatal("hostnames are refused: the resolver must not need DNS itself")
	}
	if value, err := ValidateACMEDirectory(""); err != nil || value != DefaultACMEDirectory {
		t.Fatalf("default directory: %q %v", value, err)
	}
	if _, err = ValidateACMEDirectory("http://acme.example.org/dir"); err == nil {
		t.Fatal("http directory must be refused")
	}
}

func TestCertManagerObtainsStoresAndHotSwaps(t *testing.T) {
	now := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	var logs bytes.Buffer
	obtainer := &fakeObtainer{t: t, domain: "signage-gw.example.org", validity: 90 * 24 * time.Hour, startedAt: now}
	m := newTestManager(t, obtainer, &logs)
	m.now = func() time.Time { return now }

	if _, err := m.GetCertificate(nil); err == nil || m.Status().Ready {
		t.Fatal("no certificate may be served before the first one is obtained")
	}
	wait := m.Step(context.Background())
	if obtainer.calls != 1 || !m.Status().Ready {
		t.Fatalf("calls=%d status=%+v", obtainer.calls, m.Status())
	}
	if wait < acmeCheckInterval || wait > acmeCheckInterval+acmeCheckJitter {
		t.Fatalf("next check in %v", wait)
	}
	first, err := m.GetCertificate(nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(logs.String(), "certificate obtained") {
		t.Fatalf("log lacks 'certificate obtained': %s", logs.String())
	}

	// Files are private.
	for _, name := range []string{"certificate.pem", "certificate-key.pem"} {
		info, statErr := os.Stat(filepath.Join(m.dir, name))
		if statErr != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("%s: %v %v", name, info, statErr)
		}
	}
	if info, _ := os.Stat(m.dir); info.Mode().Perm() != 0o700 {
		t.Fatalf("directory mode %v", info.Mode().Perm())
	}

	// 60 days later (30 left): not due yet at 31 days left, due below 30.
	now = now.Add(59 * 24 * time.Hour)
	m.Step(context.Background())
	if obtainer.calls != 1 {
		t.Fatalf("renewed too early: %d calls", obtainer.calls)
	}
	now = now.Add(2 * 24 * time.Hour)
	obtainer.startedAt = now
	m.Step(context.Background())
	if obtainer.calls != 2 {
		t.Fatalf("expected renewal, calls=%d", obtainer.calls)
	}
	second, _ := m.GetCertificate(nil)
	if second == first || !second.Leaf.NotAfter.After(first.Leaf.NotAfter) {
		t.Fatal("renewed certificate was not swapped in")
	}
}

func TestCertManagerReusesStoredCertificate(t *testing.T) {
	now := time.Now()
	var logs bytes.Buffer
	obtainer := &fakeObtainer{t: t, domain: "signage-gw.example.org", validity: 90 * 24 * time.Hour, startedAt: now}
	first := newTestManager(t, obtainer, &logs)
	first.Step(context.Background())

	// A new manager (restart) with the same directory serves immediately and does not obtain again.
	second, err := NewCertManager(first.dir, "signage-gw.example.org", obtainer, slog.New(slog.NewTextHandler(&logs, nil)))
	if err != nil {
		t.Fatal(err)
	}
	second.jitter = func(time.Duration) time.Duration { return 0 }
	if !second.Status().Ready {
		t.Fatal("stored certificate not loaded")
	}
	second.Step(context.Background())
	if obtainer.calls != 1 {
		t.Fatalf("obtained again: %d calls", obtainer.calls)
	}

	// A certificate for another domain is not reused.
	other, err := NewCertManager(first.dir, "other.example.org", obtainer, slog.New(slog.NewTextHandler(&logs, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if other.Status().Ready {
		t.Fatal("certificate for another domain must not be used")
	}
}

func TestCertManagerBackoffAndNoSecretsInLogs(t *testing.T) {
	now := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	var logs bytes.Buffer
	obtainer := &fakeObtainer{t: t, domain: "signage-gw.example.org", err: errors.New("cloudflare rejected token " + testToken)}
	m := newTestManager(t, obtainer, &logs)
	m.now = func() time.Time { return now }

	var waits []time.Duration
	for range 6 {
		waits = append(waits, m.Step(context.Background()))
	}
	want := []time.Duration{10 * time.Minute, 20 * time.Minute, 40 * time.Minute, 80 * time.Minute, 160 * time.Minute, 320 * time.Minute}
	for i := range want {
		if waits[i] != want[i] {
			t.Fatalf("backoff %d = %v, want %v", i, waits[i], want[i])
		}
	}
	if got := m.backoff(20); got != acmeMaxBackoff {
		t.Fatalf("backoff must be capped, got %v", got)
	}
	// At most two failed attempts per ~30 minutes: well below Let's Encrypt's 5 failures per hour.
	if waits[0]+waits[1]+waits[2] < time.Hour {
		t.Fatal("first three attempts must be spread over more than an hour")
	}
	if m.Status().Ready {
		t.Fatal("must not be ready after failures")
	}
	if strings.Contains(logs.String(), testToken) || !strings.Contains(logs.String(), "certificate request failed") {
		t.Fatalf("log must report the failure without the token: %s", logs.String())
	}

	// A later success resets the backoff.
	obtainer.err, obtainer.startedAt, obtainer.validity = nil, now, 90*24*time.Hour
	m.Step(context.Background())
	if !m.Status().Ready || m.failures != 0 {
		t.Fatalf("status=%+v failures=%d", m.Status(), m.failures)
	}
	if strings.Contains(logs.String(), string(obtainer.lastKey[:40])) {
		t.Fatal("private key leaked into the log")
	}
}

func TestCertManagerRenewalFailingStatus(t *testing.T) {
	now := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	var logs bytes.Buffer
	obtainer := &fakeObtainer{t: t, domain: "signage-gw.example.org", validity: 10 * 24 * time.Hour, startedAt: now}
	m := newTestManager(t, obtainer, &logs)
	m.now = func() time.Time { return now }
	m.Step(context.Background()) // obtains a certificate that is already within the renewal window
	obtainer.err = errors.New("dns failure")
	m.Step(context.Background())
	status := m.Status()
	if !status.Ready || !status.RenewalFailing {
		t.Fatalf("status=%+v", status)
	}
	// The old certificate keeps being served.
	if _, err := m.GetCertificate(nil); err != nil {
		t.Fatal(err)
	}
}

func TestCertManagerRunStopsWithContext(t *testing.T) {
	var logs bytes.Buffer
	obtainer := &fakeObtainer{t: t, domain: "signage-gw.example.org", validity: 90 * 24 * time.Hour, startedAt: time.Now()}
	m := newTestManager(t, obtainer, &logs)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { m.Run(ctx); close(done) }()
	deadline := time.After(5 * time.Second)
	for !m.Status().Ready {
		select {
		case <-deadline:
			t.Fatal("certificate not obtained")
		case <-time.After(10 * time.Millisecond):
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop")
	}
}

func TestLegoLoggerRedactsToken(t *testing.T) {
	var logs bytes.Buffer
	l := legoLogger{logger: slog.New(slog.NewTextHandler(&logs, nil)), secrets: []string{testToken}}
	l.Printf("[INFO] using %s", testToken)
	if strings.Contains(logs.String(), testToken) {
		t.Fatal("token in lego log")
	}
}

func TestACMEAccountIsReused(t *testing.T) {
	path := filepath.Join(t.TempDir(), "account.json")
	first, err := loadACMEAccount(path, "a@example.org", DefaultACMEDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
		t.Fatalf("account mode %v", info.Mode().Perm())
	}
	again, err := loadACMEAccount(path, "a@example.org", DefaultACMEDirectory)
	if err != nil || !again.key.Equal(first.key) {
		t.Fatalf("account key not reused: %v", err)
	}
	staging, err := loadACMEAccount(path, "a@example.org", "https://acme-staging-v02.api.letsencrypt.org/directory")
	if err != nil || staging.key.Equal(first.key) {
		t.Fatal("a different CA needs a new account")
	}
}

func TestHealthAndHeartbeatWaitingForCertificate(t *testing.T) {
	var logs bytes.Buffer
	obtainer := &fakeObtainer{t: t, domain: "signage-gw.example.org", err: errors.New("no")}
	m := newTestManager(t, obtainer, &logs)
	g := &Gateway{now: time.Now, options: Options{DataDir: t.TempDir()}}
	if g.tlsState() != "files" {
		t.Fatal("no manager means certificate files")
	}
	g.certs.Store(m)
	if g.tlsState() != "waiting" || !g.tlsWaiting() {
		t.Fatalf("state %q", g.tlsState())
	}
	if err := g.writeHealth("healthy"); err != nil {
		t.Fatal(err)
	}
	// The container stays healthy while waiting for the first certificate.
	if err := CheckHealth(g.options.DataDir); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(g.options.DataDir, "health.json"))
	if !strings.Contains(string(raw), `"tls":"waiting"`) {
		t.Fatalf("health file %s", raw)
	}
}

func TestParseACMEPropagationWait(t *testing.T) {
	for input, want := range map[string]time.Duration{"": 0, "0": 0, " 60s ": time.Minute, "2m": 2 * time.Minute} {
		if got, err := ParseACMEPropagationWait(input); err != nil || got != want {
			t.Fatalf("%q: got %v, %v", input, got, err)
		}
	}
	for _, input := range []string{"abc", "500ms", "11m", "-5s"} {
		if _, err := ParseACMEPropagationWait(input); err == nil {
			t.Fatalf("%q: expected an error", input)
		}
	}
}
