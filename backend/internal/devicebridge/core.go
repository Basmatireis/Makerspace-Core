package devicebridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type CoreClient struct {
	baseURL, token string
	client         *http.Client
}

type CoreIdentity struct {
	DeviceID   string `json:"deviceId"`
	DeviceName string `json:"deviceName"`
}

func NewCoreClient(baseURL, token string) (*CoreClient, error) {
	parsed, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("Core URL is invalid")
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && isLoopbackHostname(parsed.Hostname())) {
		return nil, errors.New("Core URL must use HTTPS unless it is loopback")
	}
	if len(strings.TrimSpace(token)) != 43 {
		return nil, errors.New("managed-device token is invalid")
	}
	return &CoreClient{baseURL: strings.TrimRight(baseURL, "/"), token: strings.TrimSpace(token), client: &http.Client{Timeout: 15 * time.Second}}, nil
}

func (c *CoreClient) Report(ctx context.Context, capabilities []Capability) (CoreIdentity, error) {
	available := make([]string, 0, len(capabilities))
	for _, capability := range capabilities {
		if capability.Available && capability.State != "simulated" {
			available = append(available, capability.ID)
		}
	}
	body, err := json.Marshal(map[string]any{"platform": "desktop", "bridgeVersion": BridgeVersion, "capabilities": available})
	if err != nil {
		return CoreIdentity{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, c.baseURL+"/api/v1/managed-devices/self/hardware", bytes.NewReader(body))
	if err != nil {
		return CoreIdentity{}, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Managed-Device-Token", c.token)
	response, err := c.client.Do(request)
	if err != nil {
		var networkError net.Error
		if errors.As(err, &networkError) {
			return CoreIdentity{}, fmt.Errorf("connect to Makerspace Core: %w", networkError)
		}
		return CoreIdentity{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return CoreIdentity{}, fmt.Errorf("Makerspace Core rejected the device report with status %d", response.StatusCode)
	}
	var identity CoreIdentity
	decoder := json.NewDecoder(io.LimitReader(response.Body, 64<<10))
	if err = decoder.Decode(&identity); err != nil {
		return CoreIdentity{}, errors.New("Makerspace Core returned an invalid device response")
	}
	return identity, nil
}
