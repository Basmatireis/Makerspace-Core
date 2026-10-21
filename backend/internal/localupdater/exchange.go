package localupdater

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/google/uuid"
)

// DefaultExchangeRoot is where the shared exchange volume is mounted in the services and the updater.
const DefaultExchangeRoot = "/var/lib/makerspace-updater"

// PresenceTTL is how long the updater's presence file counts as fresh. The updater rewrites it on
// every poll.
const PresenceTTL = 2 * time.Minute

// maxFileSize bounds every file read from the exchange; the files are a few hundred bytes.
const maxFileSize = 4096

const (
	requestFile  = "request.json"
	resultFile   = "result.json"
	presenceFile = "updater.json"
)

// Component is a service that hands update requests to the updater. Each has its own directory in
// the exchange volume.
type Component string

const (
	ComponentPrinterConnector Component = "printer-connector"
	ComponentStreamingGateway Component = "streaming-gateway"
)

// Valid reports whether c is a known component.
func (c Component) Valid() bool {
	return c == ComponentPrinterConnector || c == ComponentStreamingGateway
}

// Request asks the updater to install release Version. Core issues a new RequestID for every request;
// the updater handles each ID at most once.
type Request struct {
	RequestID uuid.UUID `json:"requestId"`
	Version   string    `json:"version"`
}

// ResultStatus is how far the updater got with a request.
type ResultStatus string

const (
	StatusInProgress ResultStatus = "in_progress"
	StatusSucceeded  ResultStatus = "succeeded"
	StatusFailed     ResultStatus = "failed"
)

// Reason codes of a result. They are short, fixed identifiers; command output is never reported.
const (
	ReasonInvalidRequest   = "invalid_request"
	ReasonDowngradeRefused = "downgrade_refused"
	ReasonAlreadyInstalled = "already_installed"
	ReasonEnvInvalid       = "env_invalid"
	ReasonEnvWriteFailed   = "env_write_failed"
	ReasonPullFailed       = "pull_failed"
	ReasonUpFailed         = "up_failed"
	ReasonInterrupted      = "interrupted"
)

var reasonPattern = regexp.MustCompile(`^[a-z0-9_]{1,64}$`)

// Result is the updater's answer to the request with RequestID.
type Result struct {
	RequestID uuid.UUID    `json:"requestId"`
	Version   string       `json:"version"`
	Status    ResultStatus `json:"status"`
	Reason    string       `json:"reason,omitempty"`
	UpdatedAt time.Time    `json:"updatedAt"`
}

func (r Result) valid() bool {
	return r.RequestID != uuid.Nil &&
		(r.Status == StatusInProgress || r.Status == StatusSucceeded || r.Status == StatusFailed) &&
		(r.Reason == "" || reasonPattern.MatchString(r.Reason))
}

// Presence tells the services that an updater watches the exchange.
type Presence struct {
	Version   string    `json:"version"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Offer is the "update" field of a configuration from Core. Present is true when Core sent the field
// at all (also as null): only such a Core understands the updater report in a heartbeat.
type Offer struct {
	Present bool
	Request *Request
}

// UnmarshalJSON records that the field was present.
func (o *Offer) UnmarshalJSON(data []byte) error {
	o.Present = true
	o.Request = nil
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return nil
	}
	var request Request
	if err := json.Unmarshal(data, &request); err != nil {
		return err
	}
	o.Request = &request
	return nil
}

// MarshalJSON writes the request or null.
func (o Offer) MarshalJSON() ([]byte, error) { return json.Marshal(o.Request) }

// Report is the updater part of a heartbeat.
type Report struct {
	Available bool          `json:"available"`
	Result    *ReportResult `json:"result"`
}

// ReportResult is the last result the updater wrote.
type ReportResult struct {
	RequestID uuid.UUID    `json:"requestId"`
	Status    ResultStatus `json:"status"`
	Reason    *string      `json:"reason"`
}

// Exchange is a service's side of the exchange directory.
type Exchange struct {
	dir string
	now func() time.Time
}

// NewExchange returns the exchange of component below root (normally DefaultExchangeRoot).
func NewExchange(root string, component Component) Exchange {
	return Exchange{dir: filepath.Join(root, string(component)), now: func() time.Time { return time.Now().UTC() }}
}

// Available reports whether an updater wrote its presence file recently.
func (e Exchange) Available() bool {
	var presence Presence
	if readJSON(filepath.Join(e.dir, presenceFile), &presence) != nil {
		return false
	}
	age := e.now().Sub(presence.UpdatedAt)
	return age < PresenceTTL && age > -PresenceTTL
}

// Result returns the updater's last result, or nil.
func (e Exchange) Result() *Result {
	var result Result
	if readJSON(filepath.Join(e.dir, resultFile), &result) != nil || !result.valid() {
		return nil
	}
	return &result
}

// Report is what the service sends to Core in its heartbeat.
func (e Exchange) Report() Report {
	report := Report{Available: e.Available()}
	if result := e.Result(); result != nil {
		report.Result = &ReportResult{RequestID: result.RequestID, Status: result.Status}
		if result.Reason != "" {
			reason := result.Reason
			report.Result.Reason = &reason
		}
	}
	return report
}

// Submit hands request to the updater. It does nothing when no updater is present, when the updater
// already answered the request, or when the same request is already waiting.
func (e Exchange) Submit(request Request) error {
	if request.RequestID == uuid.Nil || !ValidVersion(request.Version) {
		return errors.New("invalid update request")
	}
	if !e.Available() {
		return nil
	}
	if result := e.Result(); result != nil && result.RequestID == request.RequestID {
		return nil
	}
	var waiting Request
	if readJSON(filepath.Join(e.dir, requestFile), &waiting) == nil && waiting == request {
		return nil
	}
	return writeJSON(e.dir, requestFile, request, 0o644)
}

func readJSON(path string, target any) error {
	//nolint:gosec // the path is a fixed file name inside the configured exchange directory
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	data, err := io.ReadAll(io.LimitReader(file, maxFileSize+1))
	if err != nil {
		return err
	}
	if len(data) > maxFileSize {
		return errors.New("exchange file is too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

// writeJSON replaces dir/name atomically.
func writeJSON(dir, name string, value any, mode os.FileMode) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(dir, "."+name+".*")
	if err != nil {
		return fmt.Errorf("create %s: %w", name, err)
	}
	defer func() { _ = os.Remove(temporary.Name()) }()
	if _, err = temporary.Write(data); err == nil {
		err = temporary.Chmod(mode)
	}
	if err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("write %s: %w", name, err)
	}
	return os.Rename(temporary.Name(), filepath.Join(dir, name))
}
