package streaminggateway

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/google/uuid"
)

const (
	// PollInterval is how often configuration is polled and a heartbeat is sent.
	PollInterval = 30 * time.Second
	// authFailuresBeforeShutdown is how many consecutive 401 answers from Core make the gateway stop
	// serving streams (credential revoked).
	authFailuresBeforeShutdown = 3
	maxRestartAttempts         = 3
	healthStaleAfter           = 2 * time.Minute
)

// Options configure the runtime.
type Options struct {
	DataDir string
	// EnrollmentSecret is STREAM_ENROLLMENT_SECRET, the one-time secret from Core. EnrollmentFile is
	// the legacy STREAM_ENROLLMENT_SECRET_FILE, used only when EnrollmentSecret is empty. Both are
	// ignored once the gateway is enrolled.
	EnrollmentSecret string
	EnrollmentFile   string
	// ConfigFile is where the go2rtc configuration is written (a volume shared with go2rtc).
	ConfigFile string
	Render     RenderOptions
	// ListenAddr, CertFile and KeyFile configure the HTTPS reverse proxy.
	ListenAddr, CertFile, KeyFile string
	// ACME, when set, replaces CertFile/KeyFile: the gateway obtains and renews its own certificate.
	ACME *ACMEOptions
	// AllowedOrigin is Core's public origin; browsers from any other origin are refused.
	AllowedOrigin string
	// ExpectedPublicHost (STREAM_PUBLIC_HOST) is only compared with Core's publicHost to warn about a mismatch.
	ExpectedPublicHost string
}

// Gateway is the daemon's state machine.
type Gateway struct {
	store   *Store
	core    Core
	g2r     Go2RTC
	options Options
	logger  *slog.Logger
	now     func() time.Time

	snapshot atomic.Pointer[Snapshot]

	mu              sync.Mutex
	current         *Configuration
	appliedHash     string
	appliedRevision int64
	pendingRestart  bool
	appliedEpoch    *int64
	restartAttempts int
	authFailures    int
	lastSyncOK      time.Time
	lastSyncError   string

	lastRejectedLog time.Time

	// certs is set in ACME mode only (nil with certificate files).
	certs atomic.Pointer[CertManager]
}

// New builds the gateway. The proxy serves nothing until a configuration is applied.
func New(store *Store, core Core, g2r Go2RTC, options Options, logger *slog.Logger) *Gateway {
	g := &Gateway{
		store:   store,
		core:    core,
		g2r:     g2r,
		options: options,
		logger:  logger,
		now:     func() time.Time { return time.Now().UTC() },
	}
	g.snapshot.Store(&Snapshot{Streams: map[string]struct{}{}})
	g.appliedEpoch = store.AppliedEpoch()
	return g
}

// Snapshot is the proxy's view of the current configuration.
func (g *Gateway) Snapshot() *Snapshot { return g.snapshot.Load() }

func newSecret() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func (g *Gateway) ensureIdentity(ctx context.Context) (Identity, error) {
	identity := g.store.Identity()
	if identity == nil {
		secret, err := newSecret()
		if err != nil {
			return Identity{}, err
		}
		value := Identity{CredentialID: ids.New(), CredentialSecret: secret}
		if err = g.store.SaveIdentity(value); err != nil {
			return Identity{}, err
		}
		identity = &value
	}
	if identity.Enrolled {
		return g.reenrollIfNewSecret(ctx, *identity), nil
	}
	enrollment, err := g.enrollmentSecret()
	if err != nil {
		return Identity{}, err
	}
	enrolled, err := g.core.Enroll(ctx, enrollment, *identity, Version)
	if err != nil {
		return Identity{}, err
	}
	enrolled.EnrollmentDigest = enrollmentDigest(enrollment)
	if err = g.store.SaveIdentity(enrolled); err != nil {
		return Identity{}, err
	}
	return enrolled, nil
}

// reenrollIfNewSecret enrolls again when the configured enrollment secret differs from the one the
// stored identity was enrolled with (or the identity predates that bookkeeping). The stored identity is
// replaced only after Core accepted the new secret; on any failure the gateway keeps running with the
// current identity.
func (g *Gateway) reenrollIfNewSecret(ctx context.Context, current Identity) Identity {
	if strings.TrimSpace(g.options.EnrollmentSecret) == "" && g.options.EnrollmentFile == "" {
		return current
	}
	secret, err := g.enrollmentSecret()
	if err != nil {
		g.logger.Error("enrollment secret could not be read; keeping the current identity", "error", err.Error())
		return current
	}
	digest := enrollmentDigest(secret)
	if current.EnrollmentDigest == digest {
		g.logger.Info("already enrolled; STREAM_ENROLLMENT_SECRET is ignored and can be removed")
		return current
	}
	credentialSecret, err := newSecret()
	if err != nil {
		g.logger.Error("re-enrollment skipped; keeping the current identity", "error_type", fmt.Sprintf("%T", err))
		return current
	}
	candidate := Identity{CredentialID: ids.New(), CredentialSecret: credentialSecret}
	enrolled, err := g.core.Enroll(ctx, secret, candidate, Version)
	if err != nil {
		attrs := []any{"reason", enrollmentFailureReason(err)}
		var coreErr *CoreError
		if errors.As(err, &coreErr) {
			attrs = append(attrs, "status", coreErr.Status, "code", safeCode(coreErr.Code))
		}
		g.logger.Error(
			"the new STREAM_ENROLLMENT_SECRET was not accepted by Core; continuing with the previously enrolled identity. Add a new gateway or issue a new enrollment secret in Core (Settings > Local services), update .env and restart",
			attrs...)
		return current
	}
	enrolled.EnrollmentDigest = digest
	if err = g.store.SaveIdentity(enrolled); err != nil {
		g.logger.Error(
			"re-enrollment succeeded but the new identity could not be saved; keeping the current identity",
			"error_type",
			fmt.Sprintf("%T", err),
		)
		return current
	}
	g.logger.Info(
		"enrolled with the new STREAM_ENROLLMENT_SECRET; the previous identity was replaced",
		"gateway_id",
		enrolled.GatewayID.String(),
	)
	return enrolled
}

// enrollmentSecret returns the trimmed one-time secret: STREAM_ENROLLMENT_SECRET, or the content of the
// legacy STREAM_ENROLLMENT_SECRET_FILE when the variable is empty. The value is never logged.
func (g *Gateway) enrollmentSecret() (string, error) {
	if secret := strings.TrimSpace(g.options.EnrollmentSecret); secret != "" {
		return secret, nil
	}
	if g.options.EnrollmentFile == "" {
		return "", errors.New(
			"not enrolled and STREAM_ENROLLMENT_SECRET is not set: in Makerspace Core open Settings > Local services, add a gateway, copy its one-time enrollment secret into STREAM_ENROLLMENT_SECRET in the .env file next to compose.yaml, then start the gateway again",
		)
	}
	raw, err := os.ReadFile(g.options.EnrollmentFile)
	if err != nil {
		return "", fmt.Errorf("read STREAM_ENROLLMENT_SECRET_FILE: %w", err)
	}
	secret := strings.TrimSpace(string(raw))
	if secret == "" {
		return "", errors.New("STREAM_ENROLLMENT_SECRET_FILE is empty")
	}
	return secret, nil
}

func (g *Gateway) rotateCredentialIfNeeded(ctx context.Context, identity Identity) (Identity, error) {
	if identity.NextCredentialID == nil && identity.CredentialExpiresAt.After(g.now().Add(7*24*time.Hour)) {
		return identity, nil
	}
	if identity.NextCredentialID == nil {
		secret, err := newSecret()
		if err != nil {
			return identity, err
		}
		// Persist the next credential before Core hears of it: if the answer is lost, the retry sends
		// the same credential (Core treats that as idempotent) instead of leaving an unknown one behind.
		next := ids.New()
		identity.NextCredentialID, identity.NextCredentialSecret = &next, secret
		if err = g.store.SaveIdentity(identity); err != nil {
			return identity, err
		}
	}
	candidate := identity
	candidate.CredentialID, candidate.CredentialSecret = *identity.NextCredentialID, identity.NextCredentialSecret
	rotated, err := g.core.RotateCredential(ctx, identity.CredentialSecret, candidate)
	if err != nil {
		return identity, err
	}
	rotated.NextCredentialID, rotated.NextCredentialSecret = nil, ""
	if err = g.store.SaveIdentity(rotated); err != nil {
		return identity, err
	}
	return rotated, nil
}

// Apply makes a configuration current: the proxy snapshot switches immediately, the go2rtc
// configuration file is rewritten when its content changed, and go2rtc is restarted to read it.
func (g *Gateway) Apply(ctx context.Context, configuration Configuration) {
	rendered := RenderGo2RTC(configuration.Cameras, g.options.Render)
	hash := ConfigHash(rendered)
	g.snapshot.Store(NewSnapshot(configuration))

	g.mu.Lock()
	defer g.mu.Unlock()
	g.current = &configuration
	g.appliedRevision = configuration.Revision
	if hash != g.appliedHash {
		if err := WriteFileAtomic(g.options.ConfigFile, rendered); err != nil {
			if errors.Is(err, fs.ErrPermission) {
				g.logger.Error(
					"go2rtc configuration could not be written: permission denied; the go2rtc configuration volume must belong to uid 10001 (the go2rtc-config-init service sets this)",
					"path",
					filepath.Dir(g.options.ConfigFile),
				)
			} else {
				g.logger.Error("go2rtc configuration could not be written", "error_type", fmt.Sprintf("%T", err))
			}
			return
		}
		g.appliedHash, g.pendingRestart, g.restartAttempts = hash, true, 0
	}
	// A changed session epoch means running camera sessions must end (display revoked, camera
	// removed from a display, ...). WebRTC media bypasses the proxy, so restarting go2rtc is the only
	// way to cut it; players reconnect with fresh tickets. Retried until it succeeded.
	epochPending := g.appliedEpoch == nil || *g.appliedEpoch != configuration.SessionEpoch
	if epochPending && !g.pendingRestart {
		g.pendingRestart, g.restartAttempts = true, 0
	}
	if g.pendingRestart {
		err := g.g2r.Restart(ctx)
		switch {
		case err == nil, errors.Is(err, ErrGo2RTCDown):
			// A go2rtc that is not running reads the file when it starts.
			g.pendingRestart = false
			if epochPending {
				epoch := configuration.SessionEpoch
				if saveErr := g.store.SaveAppliedEpoch(epoch); saveErr != nil {
					g.logger.Warn("session epoch could not be saved", "error_type", fmt.Sprintf("%T", saveErr))
				}
				g.appliedEpoch = &epoch
			}
		default:
			g.restartAttempts++
			g.logger.Warn("go2rtc restart failed", "attempt", g.restartAttempts, "error_type", fmt.Sprintf("%T", err))
			if g.restartAttempts >= maxRestartAttempts {
				g.pendingRestart = false
			}
		}
	}
}

// Sync fetches the configuration from Core. While Core is unreachable (or answers with an error) the
// last configuration stays in force; only repeated 401 answers, meaning the credential was revoked,
// switch streaming off.
func (g *Gateway) Sync(ctx context.Context, identity Identity) error {
	configuration, err := g.core.Configuration(ctx, identity.CredentialSecret)
	if err != nil {
		g.mu.Lock()
		g.lastSyncError = "core_unreachable"
		var coreErr *CoreError
		if errors.As(err, &coreErr) {
			g.lastSyncError = "core_error"
			if coreErr.Status == http.StatusUnauthorized {
				g.authFailures++
			}
		}
		revoked := g.authFailures >= authFailuresBeforeShutdown
		g.mu.Unlock()
		if revoked {
			g.logger.Error("core rejected the gateway credential; streaming is switched off")
			g.shutOff(ctx)
		}
		return err
	}
	if configuration.ProtocolVersion != ProtocolVersion {
		return fmt.Errorf("unsupported configuration protocol version %d", configuration.ProtocolVersion)
	}
	if g.options.ExpectedPublicHost != "" &&
		!strings.EqualFold(g.options.ExpectedPublicHost, configuration.PublicHost) {
		g.logger.Warn("STREAM_PUBLIC_HOST differs from the public host configured in Core")
	}
	g.mu.Lock()
	g.authFailures, g.lastSyncOK, g.lastSyncError = 0, g.now(), ""
	previous := g.current
	g.mu.Unlock()
	if previous == nil || !sameConfiguration(*previous, configuration) {
		if err = g.store.SaveConfiguration(configuration); err != nil {
			return fmt.Errorf("persist configuration: %w", err)
		}
	}
	g.Apply(ctx, configuration)
	return nil
}

func sameConfiguration(a, b Configuration) bool {
	left, _ := json.Marshal(a)
	right, _ := json.Marshal(b)
	return string(left) == string(right)
}

func (g *Gateway) shutOff(ctx context.Context) {
	empty := Configuration{
		ProtocolVersion:   ProtocolVersion,
		Cameras:           []Camera{},
		TicketPublicKeys:  []TicketKey{},
		RevokedDisplayIDs: []uuid.UUID{},
	}
	g.mu.Lock()
	if g.current != nil {
		empty.SessionEpoch = g.current.SessionEpoch
	}
	g.mu.Unlock()
	_ = g.store.SaveConfiguration(empty)
	g.Apply(ctx, empty)
}

// BuildHeartbeat assembles the heartbeat from go2rtc's view of the configured cameras.
func (g *Gateway) BuildHeartbeat(ctx context.Context) Heartbeat {
	g.mu.Lock()
	var cameras []Camera
	if g.current != nil {
		cameras = append(cameras, g.current.Cameras...)
	}
	revision, pending, syncError := g.appliedRevision, g.pendingRestart, g.lastSyncError
	g.mu.Unlock()
	sort.Slice(cameras, func(i, j int) bool { return cameras[i].StreamName < cameras[j].StreamName })

	statuses, streamsErr := g.g2r.Streams(ctx)
	heartbeat := Heartbeat{
		SoftwareVersion:              Version,
		ProtocolVersion:              ProtocolVersion,
		AppliedConfigurationRevision: revision,
		HealthState:                  "connected",
		Cameras:                      []CameraHealth{},
	}
	var summary string
	switch {
	case streamsErr != nil:
		heartbeat.HealthState, summary = "degraded", "go2rtc_unreachable"
	case pending:
		heartbeat.HealthState, summary = "degraded", "go2rtc_restart_pending"
	case g.tlsWaiting():
		heartbeat.HealthState, summary = "degraded", "tls: waiting for certificate"
	case syncError != "":
		heartbeat.HealthState, summary = "degraded", syncError
	case g.tlsRenewalFailing():
		heartbeat.HealthState, summary = "degraded", "tls: certificate renewal failing"
	}
	if summary != "" {
		heartbeat.HealthSummary = &summary
	}
	for _, camera := range cameras {
		status, known := statuses[camera.StreamName]
		if streamsErr != nil {
			known = false
		}
		entry := CameraHealth{
			MachineID: camera.MachineID,
			Health:    HealthFor(status, known),
			Viewers:   status.Consumers,
			Codec:     status.Codec,
			Width:     status.Width,
			Height:    status.Height,
			FPS:       status.FPS,
		}
		heartbeat.Cameras = append(heartbeat.Cameras, entry)
	}
	return heartbeat
}

// tlsState is "files" (certificate files), "waiting" (ACME, no certificate yet) or "ready".
func (g *Gateway) tlsState() string {
	certs := g.certs.Load()
	switch {
	case certs == nil:
		return "files"
	case certs.Status().Ready:
		return "ready"
	default:
		return "waiting"
	}
}

func (g *Gateway) tlsWaiting() bool { return g.tlsState() == "waiting" }

func (g *Gateway) tlsRenewalFailing() bool {
	certs := g.certs.Load()
	return certs != nil && certs.Status().RenewalFailing
}

// writeHealth records that the main loop is alive and Core sync runs. The certificate state is
// reported next to it, but a gateway that still waits for its first certificate is healthy: it
// keeps polling and sending heartbeats, and restarting it would not help.
func (g *Gateway) writeHealth(status string) error {
	value, _ := json.Marshal(map[string]any{"status": status, "tls": g.tlsState(), "updatedAt": g.now()})
	path := filepath.Join(g.options.DataDir, "health.json")
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, value, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

// CheckHealth is the container healthcheck: the main loop must have refreshed the health file recently.
func CheckHealth(dataDir string) error {
	//nolint:gosec // path is the fixed health file name inside the operator-configured data directory
	value, err := os.ReadFile(filepath.Join(dataDir, "health.json"))
	if err != nil {
		return err
	}
	var status struct {
		Status    string    `json:"status"`
		UpdatedAt time.Time `json:"updatedAt"`
	}
	if json.Unmarshal(value, &status) != nil || status.Status != "healthy" ||
		time.Since(status.UpdatedAt) > healthStaleAfter {
		return errors.New("gateway health is stale")
	}
	return nil
}

// Run enrolls if needed, serves the proxy and runs the polling loop until ctx ends.
func (g *Gateway) Run(ctx context.Context) error {
	identity, err := g.ensureIdentity(ctx)
	if err != nil {
		return err
	}
	if rotated, rotateErr := g.rotateCredentialIfNeeded(ctx, identity); rotateErr != nil {
		g.logFailure("credential rotation failed", rotateErr)
	} else {
		identity = rotated
	}
	credentials, err := g.store.Go2RTCCredentials()
	if err != nil {
		return fmt.Errorf("go2rtc API credentials: %w", err)
	}
	g.options.Render.APIUsername, g.options.Render.APIPassword = credentials.Username, credentials.Password
	if c, ok := g.g2r.(interface {
		SetCredentials(username, password string)
	}); ok {
		c.SetCredentials(credentials.Username, credentials.Password)
	}
	// The file on disk tells whether go2rtc already runs the cached configuration.
	if existing, readErr := os.ReadFile(g.options.ConfigFile); readErr == nil {
		g.appliedHash = ConfigHash(string(existing))
	}
	cached := g.store.Configuration()
	if cached == nil {
		cached = &Configuration{ProtocolVersion: ProtocolVersion, Cameras: []Camera{}, TicketPublicKeys: []TicketKey{}}
	}
	g.Apply(ctx, *cached)

	var tlsConfig *tls.Config
	if acme := g.options.ACME; acme != nil {
		if acme.CADir == "" {
			acme.CADir = DefaultACMEDirectory
		}
		obtainer := acme.Obtainer
		// One directory per CA, so switching to or from the staging CA never reuses the other's certificate.
		caDigest := sha256.Sum256([]byte(acme.CADir))
		directory := filepath.Join(g.options.DataDir, "acme", hex.EncodeToString(caDigest[:4]))
		if obtainer == nil {
			obtainer = newLegoObtainer(directory, *acme, g.logger)
		}
		manager, managerErr := NewCertManager(directory, acme.Domain, obtainer, g.logger, acme.CloudflareToken)
		if managerErr != nil {
			return managerErr
		}
		g.certs.Store(manager)
		tlsConfig = manager.tlsConfig()
		if !manager.Status().Ready {
			g.logger.Info("tls: waiting for certificate", "domain", acme.Domain)
		}
		go manager.Run(ctx)
	} else {
		reloader, reloadErr := newCertReloader(g.options.CertFile, g.options.KeyFile)
		if reloadErr != nil {
			return fmt.Errorf("load TLS certificate: %w", reloadErr)
		}
		tlsConfig = reloader.tlsConfig()
	}
	origin := g.options.AllowedOrigin
	server := &http.Server{
		Addr: g.options.ListenAddr,
		Handler: NewProxy(
			g.Snapshot,
			g.go2rtcURL(),
			origin,
			UpstreamAuth(credentials),
			g.now,
		),
		TLSConfig:         tlsConfig,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    16 << 10,
		ErrorLog:          log.New(io.Discard, "", 0),
	}
	listener, err := net.Listen("tcp", g.options.ListenAddr)
	if err != nil {
		return err
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.ServeTLS(listener, "", "") }()
	defer func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	if err = g.writeHealth("healthy"); err != nil {
		return err
	}

	ticker := time.NewTicker(PollInterval)
	defer ticker.Stop()
	tick := func() {
		var rotateErr error
		if identity, rotateErr = g.rotateCredentialIfNeeded(ctx, identity); rotateErr != nil {
			g.logFailure("credential rotation failed", rotateErr)
		}
		if syncErr := g.Sync(ctx, identity); syncErr != nil {
			g.logFailure("configuration sync failed", syncErr)
		}
		if _, beatErr := g.core.Heartbeat(ctx, identity.CredentialSecret, g.BuildHeartbeat(ctx)); beatErr != nil {
			g.logFailure("heartbeat failed", beatErr)
		}
		_ = g.writeHealth("healthy")
	}
	tick()
	for {
		select {
		case <-ctx.Done():
			return nil
		case err = <-serveErr:
			if errors.Is(err, http.ErrServerClosed) {
				return nil
			}
			return fmt.Errorf("https server stopped: %w", err)
		case <-ticker.C:
			tick()
		}
	}
}

func (g *Gateway) go2rtcURL() *url.URL {
	if c, ok := g.g2r.(*Go2RTCClient); ok {
		return c.BaseURL()
	}
	return &url.URL{Scheme: "http", Host: "go2rtc:1984"}
}
