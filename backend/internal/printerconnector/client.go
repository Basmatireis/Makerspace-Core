package printerconnector

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

type RuntimeAssignment struct {
	ID                   string            `json:"id"`
	MachineID            string            `json:"machineId"`
	MachineName          string            `json:"machineName"`
	AdapterKind          AdapterKind       `json:"adapterKind"`
	AdapterSchemaVersion int               `json:"adapterSchemaVersion"`
	ConfigurationVersion int64             `json:"configurationVersion"`
	Settings             map[string]any    `json:"settings"`
	Secrets              map[string]string `json:"secrets"`
	Enabled              bool              `json:"enabled"`
}

type Configuration struct {
	Revision        int64               `json:"revision"`
	ProtocolVersion int                 `json:"protocolVersion"`
	Assignments     []RuntimeAssignment `json:"assignments"`
}
type AssignmentHealth struct {
	AssignmentID                string      `json:"assignmentId"`
	AppliedConfigurationVersion int64       `json:"appliedConfigurationVersion"`
	State                       HealthState `json:"state"`
	ErrorCode                   *string     `json:"errorCode"`
}
type Heartbeat struct {
	SoftwareVersion              string             `json:"softwareVersion"`
	ProtocolVersion              int                `json:"protocolVersion"`
	AppliedConfigurationRevision int64              `json:"appliedConfigurationRevision"`
	HealthState                  HealthState        `json:"healthState"`
	HealthSummary                *string            `json:"healthSummary"`
	PendingEventCount            int64              `json:"pendingEventCount"`
	QuarantinedEventCount        int64              `json:"quarantinedEventCount"`
	Assignments                  []AssignmentHealth `json:"assignments"`
}
type EventReceipt struct {
	EventID     uuid.UUID     `json:"eventId"`
	CoreEventID *uuid.UUID    `json:"coreEventId"`
	Status      ReceiptStatus `json:"status"`
	ReasonCode  *string       `json:"reasonCode"`
	// NextSequence accompanies a sequence conflict: the first sequence Core has
	// not seen for the event's assignment.
	NextSequence *int64 `json:"nextSequence,omitempty"`
}

type ArtifactUploadResult struct {
	Artifact          json.RawMessage `json:"artifact"`
	Disposition       string          `json:"disposition"`
	RunID             uuid.UUID       `json:"runId"`
	AutoAttachedJobID *uuid.UUID      `json:"autoAttachedJobId"`
}

// CoreError is a non-2xx answer from Core.
type CoreError struct {
	Status int
	Code   string
}

func (e *CoreError) Error() string { return "core request failed: " + e.Code }

type Client struct {
	base *url.URL
	http *http.Client
}

func NewClient(rawURL string, allowHTTP bool) (*Client, error) {
	base, err := url.Parse(strings.TrimRight(rawURL, "/"))
	if err != nil || base.Host == "" {
		return nil, errors.New("CORE_URL must be an absolute URL")
	}
	if base.Scheme != "https" && (!allowHTTP || base.Scheme != "http") {
		return nil, errors.New("CORE_URL must use HTTPS outside explicit development mode")
	}
	client := &http.Client{
		Timeout:       25 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}
	return &Client{base: base, http: client}, nil
}

func (c *Client) do(ctx context.Context, method, path, token string, input, output any) error {
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.base.String()+"/api/v1"+path, body)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	limited := io.LimitReader(response.Body, 1<<20)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var apiError struct{ Code, Message string }
		_ = json.NewDecoder(limited).Decode(&apiError)
		if apiError.Code == "" {
			apiError.Code = response.Status
		}
		return &CoreError{Status: response.StatusCode, Code: apiError.Code}
	}
	if output != nil {
		if err = json.NewDecoder(limited).Decode(output); err != nil {
			return err
		}
	}
	return nil
}

func (c *Client) Enroll(
	ctx context.Context,
	enrollmentSecret string,
	identity Identity,
	version string,
) (Identity, error) {
	input := map[string]any{
		"credentialId":     identity.CredentialID,
		"credentialSecret": identity.CredentialSecret,
		"softwareVersion":  version,
		"protocolVersion":  1,
	}
	var output struct {
		ConnectorID         uuid.UUID `json:"connectorId"`
		CredentialID        uuid.UUID `json:"credentialId"`
		CredentialExpiresAt time.Time `json:"credentialExpiresAt"`
	}
	if err := c.do(ctx, http.MethodPost, "/printer-connector/enroll", enrollmentSecret, input, &output); err != nil {
		return identity, err
	}
	identity.ConnectorID = output.ConnectorID
	identity.CredentialExpiresAt = output.CredentialExpiresAt
	identity.Enrolled = true
	return identity, nil
}

func (c *Client) Configuration(ctx context.Context, token string) (Configuration, error) {
	var output Configuration
	err := c.do(ctx, http.MethodGet, "/printer-connector/self/configuration", token, nil, &output)
	return output, err
}

// Heartbeat reports health and returns the connector's current configuration
// revision in Core, so a newer revision can be fetched immediately.
func (c *Client) Heartbeat(ctx context.Context, token string, input Heartbeat) (int64, error) {
	var output struct {
		ConfigurationRevision int64 `json:"configurationRevision"`
	}
	err := c.do(ctx, http.MethodPost, "/printer-connector/self/heartbeat", token, input, &output)
	return output.ConfigurationRevision, err
}

// PutLiveStatus replaces the latest live status snapshot of one assignment.
func (c *Client) PutLiveStatus(
	ctx context.Context,
	token string,
	assignmentID uuid.UUID,
	configurationVersion int64,
	observedAt time.Time,
	snapshot json.RawMessage,
) error {
	body := map[string]any{
		"protocolVersion":      1,
		"configurationVersion": configurationVersion,
		"observedAt":           observedAt.UTC(),
		"status":               snapshot,
	}
	return c.do(
		ctx,
		http.MethodPut,
		"/printer-connector/self/assignments/"+assignmentID.String()+"/status",
		token,
		body,
		nil,
	)
}
func (c *Client) Send(ctx context.Context, token string, events []QueuedEvent) ([]EventReceipt, error) {
	var output struct {
		Receipts []EventReceipt `json:"receipts"`
	}
	err := c.do(
		ctx,
		http.MethodPost,
		"/printer-connector/self/events",
		token,
		map[string]any{"protocolVersion": 1, "events": events},
		&output,
	)
	return output.Receipts, err
}

func (c *Client) RotateCredential(ctx context.Context, token string, identity Identity) (Identity, error) {
	var output struct {
		ConnectorID         uuid.UUID `json:"connectorId"`
		CredentialID        uuid.UUID `json:"credentialId"`
		CredentialExpiresAt time.Time `json:"credentialExpiresAt"`
	}
	input := map[string]any{"credentialId": identity.CredentialID, "credentialSecret": identity.CredentialSecret}
	if err := c.do(
		ctx,
		http.MethodPost,
		"/printer-connector/self/credential-rotation",
		token,
		input,
		&output,
	); err != nil {
		return identity, err
	}
	identity.ConnectorID = output.ConnectorID
	identity.CredentialExpiresAt = output.CredentialExpiresAt
	return identity, nil
}

func (c *Client) UploadArtifact(
	ctx context.Context,
	token string,
	transfer ArtifactTransfer,
) (ArtifactUploadResult, error) {
	if transfer.AssignmentID == uuid.Nil || transfer.RunID == uuid.Nil || transfer.ConfigurationVersion < 1 ||
		transfer.SizeBytes < 1 ||
		len(transfer.SHA256) != 64 {
		return ArtifactUploadResult{}, errors.New("invalid queued artifact transfer")
	}
	file, err := os.Open(transfer.StagedPath)
	if err != nil {
		return ArtifactUploadResult{}, err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return ArtifactUploadResult{}, err
	}
	if info.Size() != transfer.SizeBytes {
		return ArtifactUploadResult{}, errors.New("staged artifact size changed")
	}
	requestPath := fmt.Sprintf(
		"/api/v1/printer-connector/self/assignments/%s/runs/%s/artifact",
		transfer.AssignmentID,
		transfer.RunID,
	)
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, c.base.String()+requestPath, file)
	if err != nil {
		return ArtifactUploadResult{}, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/octet-stream")
	request.Header.Set("X-Configuration-Version", strconv.FormatInt(transfer.ConfigurationVersion, 10))
	request.Header.Set("X-Artifact-Filename", transfer.FileName)
	request.Header.Set("X-Artifact-SHA256", transfer.SHA256)
	request.ContentLength = transfer.SizeBytes
	response, err := c.http.Do(request)
	if err != nil {
		return ArtifactUploadResult{}, err
	}
	defer func() { _ = response.Body.Close() }()
	limited := io.LimitReader(response.Body, 1<<20)
	if response.StatusCode != http.StatusCreated && response.StatusCode != http.StatusOK {
		var apiError struct{ Code, Message string }
		_ = json.NewDecoder(limited).Decode(&apiError)
		if apiError.Code == "" {
			apiError.Code = response.Status
		}
		return ArtifactUploadResult{}, &CoreError{Status: response.StatusCode, Code: apiError.Code}
	}
	var result ArtifactUploadResult
	if err = json.NewDecoder(limited).Decode(&result); err != nil {
		return ArtifactUploadResult{}, err
	}
	if (response.StatusCode == http.StatusCreated && result.Disposition != "created") ||
		(response.StatusCode == http.StatusOK && result.Disposition != "deduplicated") ||
		result.RunID != transfer.RunID {
		return ArtifactUploadResult{}, errors.New("core artifact upload returned an invalid receipt")
	}
	return result, nil
}
