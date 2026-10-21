package localupdater

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
)

// PollInterval is how often the updater looks for requests and renews its presence file.
const PollInterval = 10 * time.Second

const (
	pullTimeout = 20 * time.Minute
	upTimeout   = 10 * time.Minute
	// maxEnvSize bounds the .env file the updater reads and rewrites.
	maxEnvSize   = 64 << 10
	maxLogOutput = 4096
)

var servicePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,62}$`)

// ValidService reports whether name is a plain Compose service name.
func ValidService(name string) bool { return servicePattern.MatchString(name) }

// Runner runs the docker CLI with args in dir and returns its combined output.
type Runner interface {
	Run(ctx context.Context, dir string, args ...string) ([]byte, error)
}

// DockerRunner runs the docker binary with a minimal environment, so no variable of the updater's
// own container overrides a value of the bundle's .env file.
type DockerRunner struct{}

// Run implements Runner.
func (DockerRunner) Run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	//nolint:gosec // fixed binary; arguments are validated service names and fixed subcommands
	command := exec.CommandContext(ctx, "docker", args...)
	command.Dir = dir
	command.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp", "DOCKER_CONFIG=/tmp/docker-config"}
	if host := os.Getenv("DOCKER_HOST"); strings.HasPrefix(host, "unix://") {
		command.Env = append(command.Env, "DOCKER_HOST="+host)
	}
	return command.CombinedOutput()
}

// Config configures the updater.
type Config struct {
	// ExchangeRoot is where the exchange volume is mounted.
	ExchangeRoot string
	// Components are the services of the bundle that hand over requests.
	Components []Component
	// Services are the Compose services the updater pulls and recreates. Its own service is never
	// among them: it would stop itself halfway.
	Services []string
	// ProjectDir is the bundle directory as Compose on the host knows it; the updater runs Compose
	// there so relative paths in compose.yaml keep their meaning.
	ProjectDir string
	// Version is the updater's own release, written into its presence file.
	Version string
}

// Updater handles the update requests of one bundle.
type Updater struct {
	config Config
	runner Runner
	logger *slog.Logger
	now    func() time.Time
	// handled holds the requests of this run, so a result that could not be written never leads to
	// a second attempt.
	handled map[uuid.UUID]struct{}
}

// New validates config.
func New(config Config, runner Runner, logger *slog.Logger) (*Updater, error) {
	if len(config.Components) == 0 {
		return nil, errors.New("no components configured")
	}
	for _, component := range config.Components {
		if !component.Valid() {
			return nil, fmt.Errorf("unknown component %q", component)
		}
	}
	if len(config.Services) == 0 {
		return nil, errors.New("no services configured")
	}
	for _, service := range config.Services {
		if !ValidService(service) {
			return nil, fmt.Errorf("invalid service name %q", service)
		}
	}
	if !filepath.IsAbs(config.ProjectDir) || filepath.Clean(config.ProjectDir) != config.ProjectDir {
		return nil, errors.New("the project directory must be a clean absolute path")
	}
	return &Updater{
		config:  config,
		runner:  runner,
		logger:  logger,
		now:     func() time.Time { return time.Now().UTC() },
		handled: map[uuid.UUID]struct{}{},
	}, nil
}

func (u *Updater) dir(component Component) string {
	return filepath.Join(u.config.ExchangeRoot, string(component))
}

// Prepare creates the components' exchange directories and fails requests a previous run left in
// progress; an interrupted update is never resumed or retried.
func (u *Updater) Prepare() error {
	for _, component := range u.config.Components {
		dir := u.dir(component)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		// The services run as other, unprivileged users. They may create files (their request) but,
		// with the sticky bit, not replace the updater's result or presence files.
		if err := os.Chmod(dir, os.ModePerm|os.ModeSticky); err != nil {
			return err
		}
		var result Result
		if readJSON(filepath.Join(dir, resultFile), &result) == nil && result.Status == StatusInProgress {
			result.Status, result.Reason, result.UpdatedAt = StatusFailed, ReasonInterrupted, u.now()
			if err := writeJSON(dir, resultFile, result, 0o644); err != nil {
				return err
			}
		}
	}
	return nil
}

// Poll renews the presence files and handles at most one new request.
func (u *Updater) Poll(ctx context.Context) {
	for _, component := range u.config.Components {
		if err := writeJSON(
			u.dir(component),
			presenceFile,
			Presence{Version: u.config.Version, UpdatedAt: u.now()},
			0o644,
		); err != nil {
			u.logger.Error("presence file could not be written", "component", string(component), "error", err.Error())
		}
	}
	for _, component := range u.config.Components {
		dir := u.dir(component)
		var request Request
		if err := readJSON(filepath.Join(dir, requestFile), &request); err != nil {
			continue
		}
		var last Result
		if readJSON(filepath.Join(dir, resultFile), &last) == nil && last.RequestID == request.RequestID {
			continue
		}
		if _, done := u.handled[request.RequestID]; done {
			continue
		}
		u.handled[request.RequestID] = struct{}{}
		result := u.handle(ctx, component, request)
		if err := writeJSON(dir, resultFile, result, 0o644); err != nil {
			u.logger.Error("update result could not be written", "component", string(component), "error", err.Error())
		}
		return
	}
}

func (u *Updater) handle(ctx context.Context, component Component, request Request) Result {
	result := Result{RequestID: request.RequestID, Version: request.Version, UpdatedAt: u.now()}
	fail := func(reason string) Result {
		result.Status, result.Reason, result.UpdatedAt = StatusFailed, reason, u.now()
		u.logger.Warn("update failed", "component", string(component), "version", request.Version, "reason", reason)
		return result
	}
	if request.RequestID == uuid.Nil || !ValidVersion(request.Version) {
		return fail(ReasonInvalidRequest)
	}
	envPath := filepath.Join(u.config.ProjectDir, ".env")
	original, info, err := readEnv(envPath)
	if err != nil {
		return fail(ReasonEnvInvalid)
	}
	current, err := EnvVersion(original)
	if err != nil {
		return fail(ReasonEnvInvalid)
	}
	switch comparison, _ := CompareVersions(request.Version, current); {
	case comparison < 0:
		return fail(ReasonDowngradeRefused)
	case comparison == 0:
		result.Status, result.Reason = StatusSucceeded, ReasonAlreadyInstalled
		return result
	}
	rewritten, err := RewriteEnv(original, request.Version)
	if err != nil {
		return fail(ReasonEnvInvalid)
	}
	result.Status = StatusInProgress
	if err = writeJSON(u.dir(component), resultFile, result, 0o644); err != nil {
		return fail(ReasonEnvWriteFailed)
	}
	u.logger.Info("updating", "component", string(component), "from", current, "to", request.Version)
	if err = replaceEnv(envPath, rewritten, info); err != nil {
		return fail(ReasonEnvWriteFailed)
	}
	restore := func() {
		if restoreErr := replaceEnv(envPath, original, info); restoreErr != nil {
			u.logger.Error("the previous .env could not be restored", "error", restoreErr.Error())
		}
	}
	if err = u.compose(ctx, pullTimeout, "pull"); err != nil {
		restore()
		return fail(ReasonPullFailed)
	}
	if err = u.compose(ctx, upTimeout, "up", "-d", "--no-build"); err != nil {
		restore()
		// Bring the previous release back up; its images are still present.
		_ = u.compose(ctx, upTimeout, "up", "-d", "--no-build")
		return fail(ReasonUpFailed)
	}
	result.Status, result.UpdatedAt = StatusSucceeded, u.now()
	u.logger.Info("update installed", "component", string(component), "version", request.Version)
	return result
}

func (u *Updater) compose(ctx context.Context, timeout time.Duration, args ...string) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	arguments := append(append([]string{"compose"}, args...), u.config.Services...)
	output, err := u.runner.Run(ctx, u.config.ProjectDir, arguments...)
	if len(output) > maxLogOutput {
		output = output[len(output)-maxLogOutput:]
	}
	if err != nil {
		u.logger.Error("docker compose failed", "command", args[0], "output", string(output))
	}
	return err
}

func readEnv(path string) (string, os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", nil, err
	}
	// A symlinked .env would be replaced by a regular file; leave such setups to the operator.
	if !info.Mode().IsRegular() || info.Size() > maxEnvSize {
		return "", nil, errors.New(".env must be a regular file of at most 64 KiB")
	}
	//nolint:gosec // fixed file name inside the bundle directory
	file, err := os.Open(path)
	if err != nil {
		return "", nil, err
	}
	defer func() { _ = file.Close() }()
	data, err := io.ReadAll(io.LimitReader(file, maxEnvSize+1))
	if err != nil || len(data) > maxEnvSize {
		return "", nil, errors.New("read .env")
	}
	return string(data), info, nil
}

// replaceEnv atomically replaces path with content, keeping the file's mode and owner so the operator
// can still edit it.
func replaceEnv(path, content string, info os.FileInfo) error {
	temporary, err := os.CreateTemp(filepath.Dir(path), ".env.local-updater.*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(temporary.Name()) }()
	if _, err = temporary.WriteString(content); err == nil {
		err = temporary.Chmod(info.Mode().Perm())
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && err == nil {
		err = temporary.Chown(int(stat.Uid), int(stat.Gid))
	}
	if err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(temporary.Name(), path)
}

// ProjectDirectory finds the host directory mounted at mountPoint in container containerID (the
// updater's own container) and makes the same path resolve to mountPoint inside the container.
// Compose must run in the host path: it resolves relative bind mounts such as ./certs against the
// project directory, and the Docker engine reads them on the host.
func ProjectDirectory(ctx context.Context, runner Runner, containerID, mountPoint string) (string, error) {
	if !regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`).MatchString(containerID) {
		return "", errors.New("invalid container id")
	}
	output, err := runner.Run(ctx, "/", "inspect", "--type", "container", "--format", "{{json .Mounts}}", containerID)
	if err != nil {
		return "", fmt.Errorf("inspect own container: %w", err)
	}
	var mounts []struct {
		Type        string `json:"Type"`
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
	}
	if err = json.Unmarshal(output, &mounts); err != nil {
		return "", fmt.Errorf("decode mounts: %w", err)
	}
	source := ""
	for _, mount := range mounts {
		if mount.Destination == mountPoint && mount.Type == "bind" {
			source = mount.Source
		}
	}
	if source == "" || !filepath.IsAbs(source) || filepath.Clean(source) != source {
		return "", fmt.Errorf("%s is not a bind mount of the bundle directory", mountPoint)
	}
	if source == mountPoint {
		return source, nil
	}
	if target, linkErr := os.Readlink(source); linkErr == nil {
		if target == mountPoint {
			return source, nil
		}
		return "", fmt.Errorf("%s already exists in the updater container", source)
	}
	if _, statErr := os.Lstat(source); statErr == nil {
		return "", fmt.Errorf("%s already exists in the updater container", source)
	}
	if err = os.MkdirAll(filepath.Dir(source), 0o755); err != nil {
		return "", err
	}
	if err = os.Symlink(mountPoint, source); err != nil {
		return "", err
	}
	return source, nil
}
