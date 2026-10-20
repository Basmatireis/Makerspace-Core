// Package streaminggateway is the headless local daemon that restreams printer cameras to digital
// signage players: it enrolls with Makerspace Core, polls its configuration, drives a bundled go2rtc
// and exposes only ticket-protected WebRTC/MSE endpoints over HTTPS.
package streaminggateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Version is set at build time.
var Version = "dev"

// ProtocolVersion is the gateway protocol this daemon speaks.
const ProtocolVersion = 1

// TicketKey is a public ticket verification key from Core's configuration.
type TicketKey struct {
	KeyID      string     `json:"kid"`
	PublicKey  string     `json:"publicKey"`
	ValidUntil *time.Time `json:"validUntil"`
}

// Camera is one camera of the configuration. SourceURL embeds the printer's LAN access code and is
// never logged.
type Camera struct {
	MachineID  string `json:"machineId"`
	Name       string `json:"name"`
	StreamName string `json:"streamName"`
	SourceURL  string `json:"sourceUrl"`
}

// Configuration is Core's gateway configuration document.
type Configuration struct {
	Revision         int64       `json:"revision"`
	ProtocolVersion  int         `json:"protocolVersion"`
	PublicHost       string      `json:"publicHost"`
	TicketPublicKeys []TicketKey `json:"ticketPublicKeys"`
	Cameras          []Camera    `json:"cameras"`
	// SessionEpoch changes when running camera sessions must be dropped; go2rtc is restarted then.
	SessionEpoch int64 `json:"sessionEpoch"`
	// RevokedDisplayIDs are displays whose tickets are refused.
	RevokedDisplayIDs []uuid.UUID `json:"revokedDisplayIds"`
}

// CameraHealth is the per-camera part of a heartbeat.
type CameraHealth struct {
	MachineID string   `json:"machineId"`
	Health    string   `json:"health"`
	Viewers   int      `json:"viewers"`
	Codec     *string  `json:"codec"`
	Width     *int     `json:"width"`
	Height    *int     `json:"height"`
	FPS       *float64 `json:"fps"`
}

// Heartbeat is the body of POST /streaming-gateway/heartbeat.
type Heartbeat struct {
	SoftwareVersion              string         `json:"softwareVersion"`
	ProtocolVersion              int            `json:"protocolVersion"`
	AppliedConfigurationRevision int64          `json:"appliedConfigurationRevision"`
	HealthState                  string         `json:"healthState"`
	HealthSummary                *string        `json:"healthSummary"`
	Cameras                      []CameraHealth `json:"cameras"`
}

// CoreError is a non-2xx answer from Core.
type CoreError struct {
	Status int
	Code   string
}

func (e *CoreError) Error() string { return "core request failed: " + e.Code }

// Core is what the runtime needs from Makerspace Core.
type Core interface {
	Enroll(ctx context.Context, enrollmentSecret string, identity Identity, version string) (Identity, error)
	Configuration(ctx context.Context, token string) (Configuration, error)
	Heartbeat(ctx context.Context, token string, input Heartbeat) (int64, error)
	RotateCredential(ctx context.Context, token string, identity Identity) (Identity, error)
}

// Client talks to Core over HTTPS.
type Client struct {
	base *url.URL
	http *http.Client
}

// NewClient validates the Core URL. Plain HTTP is accepted only with allowHTTP (local development).
func NewClient(rawURL string, allowHTTP bool) (*Client, error) {
	base, err := url.Parse(strings.TrimRight(rawURL, "/"))
	if err != nil || base.Host == "" {
		return nil, errors.New("CORE_URL must be an absolute URL")
	}
	if base.Scheme != "https" && (!allowHTTP || base.Scheme != "http") {
		return nil, errors.New("CORE_URL must use HTTPS outside explicit development mode")
	}
	return &Client{
		base: base,
		http: &http.Client{
			Timeout:       25 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}, nil
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
	limited := io.LimitReader(response.Body, 4<<20)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var apiError struct{ Code, Message string }
		_ = json.NewDecoder(limited).Decode(&apiError)
		if apiError.Code == "" {
			apiError.Code = response.Status
		}
		return &CoreError{Status: response.StatusCode, Code: apiError.Code}
	}
	if output != nil {
		return json.NewDecoder(limited).Decode(output)
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
		"protocolVersion":  ProtocolVersion,
	}
	var output struct {
		GatewayID           uuid.UUID `json:"gatewayId"`
		CredentialExpiresAt time.Time `json:"credentialExpiresAt"`
	}
	if err := c.do(ctx, http.MethodPost, "/streaming-gateway/enroll", enrollmentSecret, input, &output); err != nil {
		return identity, err
	}
	identity.GatewayID, identity.CredentialExpiresAt, identity.Enrolled = output.GatewayID, output.CredentialExpiresAt, true
	return identity, nil
}

func (c *Client) Configuration(ctx context.Context, token string) (Configuration, error) {
	var output Configuration
	err := c.do(ctx, http.MethodGet, "/streaming-gateway/configuration", token, nil, &output)
	return output, err
}

// Heartbeat reports health and returns the gateway's configuration revision in Core.
func (c *Client) Heartbeat(ctx context.Context, token string, input Heartbeat) (int64, error) {
	var output struct {
		ConfigurationRevision int64 `json:"configurationRevision"`
	}
	err := c.do(ctx, http.MethodPost, "/streaming-gateway/heartbeat", token, input, &output)
	return output.ConfigurationRevision, err
}

func (c *Client) RotateCredential(ctx context.Context, token string, identity Identity) (Identity, error) {
	var output struct {
		CredentialExpiresAt time.Time `json:"credentialExpiresAt"`
	}
	input := map[string]any{"credentialId": identity.CredentialID, "credentialSecret": identity.CredentialSecret}
	if err := c.do(ctx, http.MethodPost, "/streaming-gateway/credential-rotation", token, input, &output); err != nil {
		return identity, err
	}
	identity.CredentialExpiresAt = output.CredentialExpiresAt
	return identity, nil
}
