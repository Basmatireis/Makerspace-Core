package devicebridge

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestCoreReportExcludesSimulatedCapabilities(t *testing.T) {
	var report struct {
		Capabilities []string `json:"capabilities"`
	}
	client, err := NewCoreClient("http://127.0.0.1:8080", strings.Repeat("a", 43))
	if err != nil {
		t.Fatal(err)
	}
	client.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/api/v1/managed-devices/self/hardware" || r.Header.Get("X-Managed-Device-Token") == "" {
			t.Errorf("unexpected registration request: path=%s token=%q", r.URL.Path, r.Header.Get("X-Managed-Device-Token"))
		}
		if err := json.NewDecoder(r.Body).Decode(&report); err != nil {
			t.Error(err)
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header),
			Body: io.NopCloser(strings.NewReader(`{"deviceId":"0199d263-cba8-7c06-98ff-244776840e79","deviceName":"Desktop"}`))}, nil
	})
	if _, err = client.Report(context.Background(), []Capability{
		{ID: "nfc", Available: true, State: "simulated"},
		{ID: "camera", Available: true, State: "ready"},
		{ID: "scale", Available: false, State: "disconnected"},
	}); err != nil {
		t.Fatal(err)
	}
	if len(report.Capabilities) != 1 || report.Capabilities[0] != "camera" {
		t.Fatalf("reported capabilities = %v, want physical camera only", report.Capabilities)
	}
}
