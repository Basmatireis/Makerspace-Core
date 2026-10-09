package devicebridge

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testPairingKey = "01234567890123456789012345678901"

func TestServerRejectsUnpairedAndUnauthorizedOrigins(t *testing.T) {
	server, err := NewServer(ServerConfig{PairingKey: testPairingKey, AllowedOrigins: []string{"https://core.example.test"}}, NewBroker())
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name, origin, authorization string
		want                        int
	}{
		{name: "missing pairing", origin: "https://core.example.test", want: http.StatusUnauthorized},
		{name: "wrong pairing", origin: "https://core.example.test", authorization: "Pairing wrong", want: http.StatusUnauthorized},
		{name: "foreign origin", origin: "https://evil.example", authorization: "Pairing " + testPairingKey, want: http.StatusForbidden},
		{name: "allowed", origin: "https://core.example.test", authorization: "Pairing " + testPairingKey, want: http.StatusOK},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/v1/info", nil)
			request.Host = "127.0.0.1:17321"
			request.Header.Set("Origin", test.origin)
			request.Header.Set("Authorization", test.authorization)
			response := httptest.NewRecorder()
			server.Handler().ServeHTTP(response, request)
			if response.Code != test.want {
				t.Fatalf("status = %d, want %d: %s", response.Code, test.want, response.Body.String())
			}
			if test.want == http.StatusOK && response.Header().Get("Access-Control-Allow-Origin") != test.origin {
				t.Fatal("allowed response did not echo its exact origin")
			}
		})
	}
}

func TestServerRejectsDNSRebindingHostAndDoesNotUseWildcardCORS(t *testing.T) {
	server, _ := NewServer(ServerConfig{PairingKey: testPairingKey, AllowedOrigins: []string{"https://core.example.test"}}, NewBroker())
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/v1/info", nil)
	request.Host = "attacker.example"
	request.Header.Set("Origin", "https://core.example.test")
	request.Header.Set("Authorization", "Pairing "+testPairingKey)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || response.Header().Get("Access-Control-Allow-Origin") == "*" {
		t.Fatalf("unexpected rebinding response: status=%d cors=%q", response.Code, response.Header().Get("Access-Control-Allow-Origin"))
	}
}

func TestSimulatorUsesNormalEventStreamAndCanBeDisabled(t *testing.T) {
	broker := NewBroker()
	server, _ := NewServer(ServerConfig{PairingKey: testPairingKey, AllowedOrigins: []string{"https://core.example.test"}, Simulator: true}, broker)
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/v1/simulator/events", strings.NewReader(`{"action":"duplicate","uid":"04:a7"}`))
	request.Host = "localhost:17321"
	request.Header.Set("Authorization", "Pairing "+testPairingKey)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d: %s", response.Code, response.Body.String())
	}
	page := broker.Wait(request.Context(), 0, 0)
	if len(page.Events) != 2 || page.Events[0].NFC.UID != "04A7" || !page.Events[1].Duplicate {
		t.Fatalf("unexpected simulator events: %+v", page.Events)
	}

	disabled, _ := NewServer(ServerConfig{PairingKey: testPairingKey, AllowedOrigins: []string{"https://core.example.test"}}, NewBroker())
	disabledResponse := httptest.NewRecorder()
	disabled.Handler().ServeHTTP(disabledResponse, request.Clone(request.Context()))
	if disabledResponse.Code != http.StatusNotFound {
		t.Fatalf("disabled simulator status = %d", disabledResponse.Code)
	}
}

func TestInfoReturnsClearUnsupportedCapability(t *testing.T) {
	server, _ := NewServer(ServerConfig{PairingKey: testPairingKey, AllowedOrigins: []string{"https://core.example.test"}, Capabilities: func() []Capability {
		return []Capability{{ID: "nfc", Available: false, State: "unsupported"}}
	}}, NewBroker())
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/v1/info", nil)
	request.Host = "[::1]:17321"
	request.Header.Set("Authorization", "Pairing "+testPairingKey)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	var info DeviceInfo
	if err := json.NewDecoder(response.Body).Decode(&info); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || len(info.Capabilities) != 1 || info.Capabilities[0].State != "unsupported" {
		t.Fatalf("unexpected info response: status=%d info=%+v", response.Code, info)
	}
}
