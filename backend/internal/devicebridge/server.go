package devicebridge

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

type ServerConfig struct {
	PairingKey     string
	AllowedOrigins []string
	Simulator      bool
	Capabilities   func() []Capability
}

type Server struct {
	config  ServerConfig
	broker  *Broker
	origins map[string]struct{}
	mu      sync.RWMutex
	core    coreState
}

type coreState struct {
	connected bool
	name      string
}

func NewServer(config ServerConfig, broker *Broker) (*Server, error) {
	if len(config.PairingKey) < 32 {
		return nil, errors.New("pairing key must contain at least 32 characters")
	}
	if len(config.AllowedOrigins) == 0 {
		return nil, errors.New("at least one allowed origin is required")
	}
	origins := make(map[string]struct{}, len(config.AllowedOrigins))
	for _, candidate := range config.AllowedOrigins {
		parsed, err := url.Parse(candidate)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
			return nil, fmt.Errorf("invalid allowed origin %q", candidate)
		}
		origin := parsed.Scheme + "://" + parsed.Host
		if origin != candidate || (parsed.Scheme != "https" && !isLoopbackHostname(parsed.Hostname())) {
			return nil, fmt.Errorf("allowed origin %q must use HTTPS unless it is loopback", candidate)
		}
		origins[origin] = struct{}{}
	}
	if config.Capabilities == nil {
		config.Capabilities = func() []Capability { return []Capability{} }
	}
	return &Server{config: config, broker: broker, origins: origins}, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("OPTIONS /v1/{path...}", s.options)
	mux.HandleFunc("GET /v1/info", s.protected(s.info))
	mux.HandleFunc("GET /v1/events", s.protected(s.events))
	mux.HandleFunc("POST /v1/simulator/events", s.protected(s.simulate))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if !validLoopbackHost(r.Host) {
			writeProblem(w, http.StatusForbidden, "invalid_host", "The bridge accepts only loopback Host headers")
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (s *Server) SetCoreState(connected bool, name string) {
	s.mu.Lock()
	s.core = coreState{connected: connected, name: name}
	s.mu.Unlock()
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) options(w http.ResponseWriter, r *http.Request) {
	if !s.allowOrigin(w, r) {
		writeProblem(w, http.StatusForbidden, "origin_denied", "Origin is not allowed")
		return
	}
	requested := strings.ToLower(r.Header.Get("Access-Control-Request-Headers"))
	for _, header := range strings.Split(requested, ",") {
		header = strings.TrimSpace(header)
		if header != "" && header != "authorization" && header != "content-type" {
			writeProblem(w, http.StatusForbidden, "header_denied", "Requested header is not allowed")
			return
		}
	}
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	if strings.EqualFold(r.Header.Get("Access-Control-Request-Private-Network"), "true") {
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) protected(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.allowOrigin(w, r) {
			writeProblem(w, http.StatusForbidden, "origin_denied", "Origin is not allowed")
			return
		}
		provided := ""
		if scheme, value, ok := strings.Cut(strings.TrimSpace(r.Header.Get("Authorization")), " "); ok && scheme == "Pairing" {
			provided = value
		}
		if len(provided) != len(s.config.PairingKey) || subtle.ConstantTimeCompare([]byte(provided), []byte(s.config.PairingKey)) != 1 {
			w.Header().Set("WWW-Authenticate", `Pairing realm="makerspace-device-bridge"`)
			writeProblem(w, http.StatusUnauthorized, "pairing_required", "Valid bridge pairing is required")
			return
		}
		next(w, r)
	}
}

func (s *Server) allowOrigin(w http.ResponseWriter, r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	if _, ok := s.origins[origin]; !ok {
		return false
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Add("Vary", "Origin")
	return true
}

func (s *Server) info(w http.ResponseWriter, _ *http.Request) {
	s.mu.RLock()
	core := s.core
	s.mu.RUnlock()
	writeJSON(w, http.StatusOK, DeviceInfo{ProtocolVersion: ProtocolVersion, BridgeVersion: BridgeVersion, Platform: "desktop",
		Capabilities: s.config.Capabilities(), LatestSequence: s.broker.LatestSequence(), CoreConnected: core.connected, DeviceName: core.name})
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	after, err := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)
	if r.URL.Query().Get("after") == "" {
		after = 0
		err = nil
	}
	if err != nil {
		writeProblem(w, http.StatusBadRequest, "invalid_cursor", "after must be an unsigned integer")
		return
	}
	wait := 25 * time.Second
	if value := r.URL.Query().Get("wait"); value != "" {
		parsed, parseErr := time.ParseDuration(value)
		if parseErr != nil || parsed < 0 || parsed > 25*time.Second {
			writeProblem(w, http.StatusBadRequest, "invalid_wait", "wait must be between 0s and 25s")
			return
		}
		wait = parsed
	}
	writeJSON(w, http.StatusOK, s.broker.Wait(r.Context(), after, wait))
}

type simulatorCommand struct {
	Action string `json:"action"`
	UID    string `json:"uid,omitempty"`
}

func (s *Server) simulate(w http.ResponseWriter, r *http.Request) {
	if !s.config.Simulator {
		writeProblem(w, http.StatusNotFound, "not_found", "Simulator is disabled")
		return
	}
	var command simulatorCommand
	reader := http.MaxBytesReader(w, r.Body, 4096)
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&command); err != nil {
		writeProblem(w, http.StatusBadRequest, "invalid_request", "Simulator command is invalid")
		return
	}
	if err := ensureJSONEOF(decoder); err != nil {
		writeProblem(w, http.StatusBadRequest, "invalid_request", "Simulator command is invalid")
		return
	}
	events, err := Simulate(s.broker, command.Action, command.UID)
	if err != nil {
		writeProblem(w, http.StatusUnprocessableEntity, "invalid_simulation", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"events": events})
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var value any
	if err := decoder.Decode(&value); !errors.Is(err, io.EOF) {
		return errors.New("multiple JSON values")
	}
	return nil
}

func validLoopbackHost(hostport string) bool {
	host := hostport
	if parsed, _, err := net.SplitHostPort(hostport); err == nil {
		host = parsed
	}
	return isLoopbackHostname(strings.Trim(host, "[]"))
}

func isLoopbackHostname(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeProblem(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"code": code, "message": message})
}
