package streaminggateway

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultACMEDirectory is the Let's Encrypt production directory. Use
	// https://acme-staging-v02.api.letsencrypt.org/directory (ACME_CA_DIR) to test without rate limits.
	DefaultACMEDirectory = "https://acme-v02.api.letsencrypt.org/directory"
	// DefaultACMEResolvers are the recursive resolvers used for the DNS-01 propagation checks, so they
	// never depend on the local resolver (which may refuse public names that point to private addresses).
	DefaultACMEResolvers = "1.1.1.1:53,1.0.0.1:53"

	acmeRenewBefore    = 30 * 24 * time.Hour
	acmeCheckInterval  = 12 * time.Hour
	acmeCheckJitter    = time.Hour
	acmeFirstBackoff   = 10 * time.Minute
	acmeMaxBackoff     = 6 * time.Hour
	acmeObtainTimeout  = 5 * time.Minute
	acmeFailingWarning = 14 * 24 * time.Hour
)

// ACMEOptions configure the built-in Let's Encrypt client (DNS-01 via Cloudflare).
type ACMEOptions struct {
	Domain, Email, CloudflareToken string
	// CADir is the ACME directory URL; empty means Let's Encrypt production.
	CADir string
	// Resolvers are recursive resolvers (host:port) for the propagation checks; empty means the defaults.
	Resolvers []string
	// PropagationWait, when set, replaces the DNS propagation check by a fixed wait before Let's Encrypt
	// validates (for networks whose router intercepts or caches DNS traffic on port 53).
	PropagationWait time.Duration
	// Obtainer replaces the Let's Encrypt client (tests).
	Obtainer CertObtainer
}

// TLSMode is how the gateway gets its certificate.
type TLSMode string

const (
	TLSModeFiles TLSMode = "files"
	TLSModeACME  TLSMode = "acme"
)

// TLSSelection is the result of SelectTLSMode.
type TLSSelection struct {
	Mode TLSMode
	// Domain is the DNS name of STREAM_PUBLIC_HOST (ACME mode only).
	Domain string
}

// SelectTLSMode decides between certificate files (they win when both exist) and ACME.
func SelectTLSMode(certFile, keyFile, publicHost, acmeEmail, cloudflareToken string) (TLSSelection, error) {
	certExists, keyExists := fileExists(certFile), fileExists(keyFile)
	switch {
	case certExists && keyExists:
		return TLSSelection{Mode: TLSModeFiles}, nil
	case certExists != keyExists:
		return TLSSelection{}, errors.New(
			"only one of the TLS certificate file and the TLS key file exists (STREAM_TLS_CERT_FILE, STREAM_TLS_KEY_FILE): provide both, or remove both to use ACME",
		)
	}
	email, token := strings.TrimSpace(acmeEmail), strings.TrimSpace(cloudflareToken)
	if email == "" && token == "" {
		return TLSSelection{}, errors.New("no TLS certificate configured. Choose one: " +
			"(1) simplest: set ACME_EMAIL and CLOUDFLARE_DNS_API_TOKEN (and STREAM_PUBLIC_HOST to a DNS name) to obtain a Let's Encrypt certificate automatically; " +
			"(2) provide certificate files: fullchain.pem and privkey.pem in ./certs (STREAM_TLS_CERT_FILE and STREAM_TLS_KEY_FILE)")
	}
	if email == "" || token == "" {
		return TLSSelection{}, errors.New(
			"ACME mode needs both ACME_EMAIL and CLOUDFLARE_DNS_API_TOKEN; one of them is missing",
		)
	}
	domain, err := ACMEDomain(publicHost)
	if err != nil {
		return TLSSelection{}, err
	}
	return TLSSelection{Mode: TLSModeACME, Domain: domain}, nil
}

func fileExists(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

// ACMEDomain extracts the DNS name from STREAM_PUBLIC_HOST ("name" or "name:port") and rejects IP
// addresses and anything that is not a fully qualified DNS name.
func ACMEDomain(publicHost string) (string, error) {
	host := strings.TrimSpace(publicHost)
	if host == "" {
		return "", errors.New("STREAM_PUBLIC_HOST is required for ACME")
	}
	if strings.ContainsAny(host, "/@?# ") {
		return "", fmt.Errorf("STREAM_PUBLIC_HOST must be hostname[:port], without scheme or path")
	}
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	} else if strings.HasPrefix(host, "[") {
		return "", errors.New("STREAM_PUBLIC_HOST is an IP address; ACME needs a DNS name")
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if _, err := netip.ParseAddr(strings.Trim(host, "[]")); err == nil {
		return "", errors.New("STREAM_PUBLIC_HOST is an IP address; ACME needs a DNS name")
	}
	if len(host) > 253 || !strings.Contains(host, ".") {
		return "", fmt.Errorf("STREAM_PUBLIC_HOST %q is not a fully qualified DNS name", host)
	}
	for _, label := range strings.Split(host, ".") {
		if !validDNSLabel(label) {
			return "", fmt.Errorf("STREAM_PUBLIC_HOST %q is not a valid DNS name (wildcards are not supported)", host)
		}
	}
	return host, nil
}

func validDNSLabel(label string) bool {
	if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
		return false
	}
	for _, r := range label {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' {
			return false
		}
	}
	return true
}

// ParseACMEResolvers parses ACME_DNS_RESOLVERS: comma-separated IP[:port] entries (port 53 by default).
func ParseACMEResolvers(value string) ([]string, error) {
	if strings.TrimSpace(value) == "" {
		value = DefaultACMEResolvers
	}
	var out []string
	for _, entry := range strings.Split(value, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		hostPort := entry
		if _, _, err := net.SplitHostPort(entry); err != nil {
			hostPort = net.JoinHostPort(strings.Trim(entry, "[]"), "53")
		}
		host, port, err := net.SplitHostPort(hostPort)
		if err != nil || port == "" {
			return nil, fmt.Errorf("ACME_DNS_RESOLVERS entry %q must be IP[:port]", entry)
		}
		if _, err = netip.ParseAddr(host); err != nil {
			return nil, fmt.Errorf("ACME_DNS_RESOLVERS entry %q must be an IP address with an optional port", entry)
		}
		out = append(out, hostPort)
	}
	if len(out) == 0 {
		return nil, errors.New("ACME_DNS_RESOLVERS has no usable entry")
	}
	return out, nil
}

// ValidateACMEDirectory checks ACME_CA_DIR (an https URL).
func ValidateACMEDirectory(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return DefaultACMEDirectory, nil
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return "", errors.New(
			"ACME_CA_DIR must be an https URL, for example https://acme-staging-v02.api.letsencrypt.org/directory",
		)
	}
	return value, nil
}

// CertObtainer requests a certificate for a domain and returns PEM encoded chain and private key.
type CertObtainer interface {
	Obtain(ctx context.Context, domain string) (certPEM, keyPEM []byte, err error)
}

// CertManager keeps the certificate of ACME mode: it reuses the stored one, obtains the first one,
// renews it before it expires and hands it to the TLS listener.
type CertManager struct {
	dir      string
	domain   string
	obtainer CertObtainer
	logger   *slog.Logger
	secrets  []string

	now    func() time.Time
	jitter func(max time.Duration) time.Duration

	mu       sync.Mutex
	cert     *tls.Certificate
	notAfter time.Time
	failures int
	lastErr  string
}

// CertStatus is what the heartbeat and the health file report.
type CertStatus struct {
	Ready bool
	// RenewalFailing: a certificate exists, is close to expiry, and renewing keeps failing.
	RenewalFailing bool
	NotAfter       time.Time
}

// NewCertManager prepares the 0700 directory and loads a stored certificate for the domain, if any.
// secrets are values that must never appear in log output.
func NewCertManager(
	dir, domain string,
	obtainer CertObtainer,
	logger *slog.Logger,
	secrets ...string,
) (*CertManager, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create ACME directory: %w", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil { //nolint:gosec // directories need the owner execute bit; 0700 is the strictest usable mode
		return nil, fmt.Errorf("protect ACME directory: %w", err)
	}
	m := &CertManager{
		dir: dir, domain: domain, obtainer: obtainer, logger: logger, secrets: secrets,
		now:    func() time.Time { return time.Now() },
		jitter: func(max time.Duration) time.Duration { return rand.N(max + 1) }, //nolint:gosec // renewal jitter needs no cryptographic randomness
	}
	m.loadStored()
	return m, nil
}

func (m *CertManager) certPath() string { return filepath.Join(m.dir, "certificate.pem") }
func (m *CertManager) keyPath() string  { return filepath.Join(m.dir, "certificate-key.pem") }

func (m *CertManager) loadStored() {
	pair, err := tls.LoadX509KeyPair(m.certPath(), m.keyPath())
	if err != nil {
		return
	}
	if err = m.accept(&pair); err != nil {
		m.logger.Info("stored certificate is not used", "reason", err.Error())
		return
	}
	m.logger.Info("using stored certificate", "domain", m.domain, "expires", m.notAfter.UTC().Format(time.RFC3339))
}

// accept checks the certificate covers the domain and is not expired, then installs it.
func (m *CertManager) accept(pair *tls.Certificate) error {
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return err
	}
	if err = leaf.VerifyHostname(m.domain); err != nil {
		return fmt.Errorf("certificate does not cover %s", m.domain)
	}
	if !leaf.NotAfter.After(m.now()) {
		return errors.New("certificate is expired")
	}
	pair.Leaf = leaf
	m.mu.Lock()
	m.cert, m.notAfter = pair, leaf.NotAfter
	m.mu.Unlock()
	return nil
}

// GetCertificate is the tls.Config callback. Before the first certificate exists the handshake fails.
func (m *CertManager) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cert == nil {
		return nil, errors.New("tls: waiting for certificate")
	}
	return m.cert, nil
}

func (m *CertManager) tlsConfig() *tls.Config {
	return &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: m.GetCertificate}
}

// Status reports the certificate state.
func (m *CertManager) Status() CertStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cert == nil {
		return CertStatus{}
	}
	left := m.notAfter.Sub(m.now())
	return CertStatus{Ready: true, NotAfter: m.notAfter, RenewalFailing: m.failures > 0 && left < acmeFailingWarning}
}

func (m *CertManager) needsRenewal() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.cert == nil || m.notAfter.Sub(m.now()) < acmeRenewBefore
}

// backoff is the wait after the n-th consecutive failure: 10 minutes, doubling, at most 6 hours, plus
// up to 10% jitter. Let's Encrypt allows five failed validations per hostname and hour.
func (m *CertManager) backoff(failures int) time.Duration {
	delay := acmeFirstBackoff
	for i := 1; i < failures && delay < acmeMaxBackoff; i++ {
		delay *= 2
	}
	if delay > acmeMaxBackoff {
		delay = acmeMaxBackoff
	}
	return delay + m.jitter(delay/10)
}

// Step obtains or renews a certificate when needed and returns how long to wait until the next step.
func (m *CertManager) Step(ctx context.Context) time.Duration {
	if !m.needsRenewal() {
		return acmeCheckInterval + m.jitter(acmeCheckJitter)
	}
	m.logger.Info("requesting certificate", "domain", m.domain)
	attempt, cancel := context.WithTimeout(ctx, acmeObtainTimeout)
	defer cancel()
	certPEM, keyPEM, err := m.obtainer.Obtain(attempt, m.domain)
	if err == nil {
		err = m.install(certPEM, keyPEM)
	}
	if err != nil {
		m.mu.Lock()
		m.failures++
		failures := m.failures
		m.lastErr = m.redact(err.Error())
		m.mu.Unlock()
		wait := m.backoff(failures)
		m.logger.Warn(
			"certificate request failed",
			"domain",
			m.domain,
			"error",
			m.redact(err.Error()),
			"attempt",
			failures,
			"retry_in",
			wait.Round(time.Second).String(),
		)
		return wait
	}
	m.mu.Lock()
	m.failures, m.lastErr = 0, ""
	notAfter := m.notAfter
	m.mu.Unlock()
	m.logger.Info("certificate obtained", "domain", m.domain, "expires", notAfter.UTC().Format(time.RFC3339))
	return acmeCheckInterval + m.jitter(acmeCheckJitter)
}

func (m *CertManager) install(certPEM, keyPEM []byte) error {
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return fmt.Errorf("issued certificate is unusable: %w", err)
	}
	if err = m.accept(&pair); err != nil {
		return fmt.Errorf("issued certificate rejected: %w", err)
	}
	if err = writeFileAtomic(m.keyPath(), keyPEM); err != nil {
		return fmt.Errorf("store certificate key: %w", err)
	}
	if err = writeFileAtomic(m.certPath(), certPEM); err != nil {
		return fmt.Errorf("store certificate: %w", err)
	}
	return nil
}

func (m *CertManager) redact(text string) string {
	for _, secret := range m.secrets {
		if secret != "" {
			text = strings.ReplaceAll(text, secret, "[redacted]")
		}
	}
	return text
}

// Run loops until ctx ends: obtain, renew when less than 30 days remain (checked every 12 hours with
// jitter), back off exponentially after failures.
func (m *CertManager) Run(ctx context.Context) {
	for {
		wait := m.Step(ctx)
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func writeFileAtomic(path string, data []byte) error {
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

// MaxACMEPropagationWait bounds ACME_DNS_PROPAGATION_WAIT.
const MaxACMEPropagationWait = 10 * time.Minute

// ParseACMEPropagationWait parses ACME_DNS_PROPAGATION_WAIT ("" or "0" = check propagation, as by
// default; otherwise a duration such as "60s" between 1 s and 10 min that is waited instead).
func ParseACMEPropagationWait(value string) (time.Duration, error) {
	value = strings.TrimSpace(value)
	if value == "" || value == "0" {
		return 0, nil
	}
	wait, err := time.ParseDuration(value)
	if err != nil || wait < time.Second || wait > MaxACMEPropagationWait {
		return 0, fmt.Errorf("ACME_DNS_PROPAGATION_WAIT must be a duration between 1s and 10m, for example 60s")
	}
	return wait, nil
}
