package printerconnector

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	bambuCameraPort   = "322"
	bambuCameraUser   = "bblp"
	bambuCameraPath   = "/streaming/live/1"
	cameraStreamLabel = "cam-"
	// maxRestartAttempts bounds the retries of a failed go2rtc restart per configuration change.
	maxRestartAttempts = 3
)

// CameraOptions enable camera streaming. They come from the GO2RTC_* environment; streaming is
// optional, and a connector without them runs as before and reports no cameras.
type CameraOptions struct {
	// APIURL is where the connector reaches go2rtc's HTTP API (GO2RTC_API_URL).
	APIURL string
	// ConfigFile is the go2rtc configuration file the connector writes (GO2RTC_CONFIG_FILE).
	ConfigFile string
	// APIListen is the address go2rtc's API listens on, on the bundle's internal network (GO2RTC_API_LISTEN).
	APIListen string
	// LogLevel is go2rtc's log level (GO2RTC_LOG_LEVEL); only error and fatal are accepted.
	LogLevel LogLevel
}

// cameraStreamName is the local go2rtc stream of an assignment.
func cameraStreamName(assignmentID string) string { return cameraStreamLabel + assignmentID }

type cameraEntry struct {
	assignmentID string
	stream       string
}

// cameraService feeds the bundled go2rtc from the assignments with cameraStreaming and relays viewer
// sessions to Core.
type cameraService struct {
	store       *Store
	logger      *slog.Logger
	g2r         *go2rtcClient
	relay       *streamRelay
	configFile  string
	renderBase  go2rtcRenderOptions
	cameras     []cameraEntry
	appliedHash string
	loaded      bool

	mu              sync.Mutex
	pendingRestart  bool
	restartAttempts int
}

func newCameraService(
	ctx context.Context,
	store *Store,
	client *Client,
	token func() string,
	options CameraOptions,
	logger *slog.Logger,
) (*cameraService, error) {
	if options.ConfigFile == "" {
		return nil, errors.New("GO2RTC_CONFIG_FILE is required for camera streaming")
	}
	if options.LogLevel == "" {
		options.LogLevel = LogLevelError
	}
	if !ValidLogLevel(options.LogLevel) {
		return nil, errors.New("GO2RTC_LOG_LEVEL must be error or fatal: more verbose levels log camera access codes")
	}
	credentials, err := store.go2rtcCredentials(ctx)
	if err != nil {
		return nil, fmt.Errorf("go2rtc API credentials: %w", err)
	}
	g2r, err := newGo2RTCClient(options.APIURL, credentials.Username, credentials.Password)
	if err != nil {
		return nil, err
	}
	return &cameraService{
		store:      store,
		logger:     logger,
		g2r:        g2r,
		relay:      newStreamRelay(client, token, g2r, logger),
		configFile: options.ConfigFile,
		renderBase: go2rtcRenderOptions{
			APIListen:   options.APIListen,
			LogLevel:    options.LogLevel,
			APIUsername: credentials.Username,
			APIPassword: credentials.Password,
		},
	}, nil
}

// cameraSource builds the go2rtc source of a Bambu assignment from the settings and secrets the
// adapter already uses. The access code is percent-encoded into the URL userinfo.
func cameraSource(raw RuntimeAssignment) (camera, error) {
	if raw.AdapterKind != AdapterBambuH2D && raw.AdapterKind != AdapterBambuX1C {
		return camera{}, errors.New("camera streaming needs a Bambu adapter")
	}
	settings, secrets, err := parseBambuConfiguration(raw.AdapterKind, raw.Settings, raw.Secrets)
	if err != nil {
		return camera{}, err
	}
	source := url.URL{
		Scheme: "rtspx",
		User:   url.UserPassword(bambuCameraUser, secrets.LANAccessCode),
		Host:   net.JoinHostPort(settings.IPAddress.String(), bambuCameraPort),
		Path:   bambuCameraPath,
	}
	return camera{StreamName: cameraStreamName(raw.ID), SourceURL: source.String()}, nil
}

// Apply makes a configuration current: the go2rtc configuration file is rewritten when its content
// changed and go2rtc is restarted to read it; the relay only serves streams that are configured.
func (c *cameraService) Apply(ctx context.Context, assignments []RuntimeAssignment) {
	var sources []camera
	var entries []cameraEntry
	for _, raw := range assignments {
		if !raw.Enabled || !raw.CameraStreaming {
			continue
		}
		if id, err := uuid.Parse(raw.ID); err != nil || id.String() != raw.ID {
			continue
		}
		source, err := cameraSource(raw)
		if err != nil {
			c.logger.Warn("camera streaming skipped: the assignment has no usable camera source",
				"assignment_id", raw.ID, "error_type", fmt.Sprintf("%T", err))
			continue
		}
		sources = append(sources, source)
		entries = append(entries, cameraEntry{assignmentID: raw.ID, stream: source.StreamName})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].stream < entries[j].stream })
	rendered, err := renderGo2RTC(sources, c.renderBase)
	if err != nil {
		c.logger.Error("go2rtc configuration could not be rendered", "error_type", fmt.Sprintf("%T", err))
		return
	}
	streams := make([]string, len(entries))
	for i, entry := range entries {
		streams[i] = entry.stream
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	c.cameras = entries
	c.relay.SetStreams(streams)
	if !c.loaded {
		c.loaded = true
		if existing, readErr := os.ReadFile(c.configFile); readErr == nil {
			c.appliedHash = configHash(string(existing))
		}
	}
	if hash := configHash(rendered); hash != c.appliedHash {
		if err = writeFileAtomic(c.configFile, rendered); err != nil {
			if errors.Is(err, fs.ErrPermission) {
				c.logger.Error(
					"go2rtc configuration could not be written: permission denied; the go2rtc configuration volume must be writable by the connector",
					"path", filepath.Dir(c.configFile),
				)
			} else {
				c.logger.Error("go2rtc configuration could not be written", "error_type", fmt.Sprintf("%T", err))
			}
			return
		}
		c.appliedHash, c.pendingRestart, c.restartAttempts = hash, true, 0
	}
	c.restartLocked(ctx)
}

// Reconcile retries a failed go2rtc restart.
func (c *cameraService) Reconcile(ctx context.Context) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.restartLocked(ctx)
}

func (c *cameraService) restartLocked(ctx context.Context) {
	if !c.pendingRestart {
		return
	}
	err := c.g2r.restart(ctx)
	switch {
	case err == nil, errors.Is(err, errGo2RTCDown):
		// A go2rtc that is not running reads the file when it starts.
		c.pendingRestart = false
	default:
		c.restartAttempts++
		c.logger.Warn("go2rtc restart failed", "attempt", c.restartAttempts, "error_type", fmt.Sprintf("%T", err))
		if c.restartAttempts >= maxRestartAttempts {
			c.pendingRestart = false
		}
	}
}

// Health reports every configured camera. It is nil when no camera is configured, so the heartbeat
// carries no cameras field.
func (c *cameraService) Health(ctx context.Context) []CameraHealth {
	c.mu.Lock()
	entries := append([]cameraEntry(nil), c.cameras...)
	c.mu.Unlock()
	if len(entries) == 0 {
		return nil
	}
	probe, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	streams, err := c.g2r.streams(probe)
	if err != nil && !errors.Is(err, errGo2RTCDown) {
		c.logger.Warn("go2rtc stream list unavailable", "error_type", fmt.Sprintf("%T", err))
	}
	result := make([]CameraHealth, 0, len(entries))
	for _, entry := range entries {
		status, known := streams[entry.stream]
		health := CameraUnavailable
		if err == nil {
			health = cameraHealthFor(status, known)
		}
		result = append(result, CameraHealth{
			AssignmentID: entry.assignmentID,
			Health:       health,
			Viewers:      c.relay.Viewers(entry.stream),
		})
	}
	return result
}
