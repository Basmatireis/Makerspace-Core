package streaminggateway

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/streamticket"
)

const (
	webrtcPath      = "/api/webrtc"
	websocketPath   = "/api/ws"
	maxOfferBytes   = 64 << 10
	preflightMaxAge = "600"
)

// KeyEntry is a ticket verification key with its optional end of validity.
type KeyEntry struct {
	KeyID      string
	Public     ed25519.PublicKey
	ValidUntil *time.Time
}

// Snapshot is what the proxy needs from the current configuration: the streams it may expose and
// the keys that may sign tickets.
type Snapshot struct {
	Streams map[string]struct{}
	Keys    []KeyEntry
}

// NewSnapshot derives the proxy view of a configuration. Malformed keys are skipped.
func NewSnapshot(configuration Configuration) *Snapshot {
	snapshot := &Snapshot{Streams: make(map[string]struct{}, len(configuration.Cameras))}
	for _, camera := range configuration.Cameras {
		snapshot.Streams[camera.StreamName] = struct{}{}
	}
	for _, key := range configuration.TicketPublicKeys {
		raw, err := base64.RawURLEncoding.DecodeString(key.PublicKey)
		if err != nil || len(raw) != ed25519.PublicKeySize || key.KeyID == "" {
			continue
		}
		snapshot.Keys = append(snapshot.Keys, KeyEntry{KeyID: key.KeyID, Public: raw, ValidUntil: key.ValidUntil})
	}
	return snapshot
}

// verificationKeys returns the keys valid at now, so a retired key stops working even while Core is
// unreachable and the configuration is not refreshed.
func (s *Snapshot) verificationKeys(now time.Time) streamticket.Keys {
	keys := make(streamticket.Keys, len(s.Keys))
	for _, key := range s.Keys {
		if key.ValidUntil != nil && now.After(*key.ValidUntil) {
			continue
		}
		keys[key.KeyID] = key.Public
	}
	return keys
}

type originKey struct{}

// Proxy exposes only go2rtc's WebRTC offer endpoint and MSE websocket, for configured streams and
// with a valid ticket. Everything else is a 404.
type Proxy struct {
	snapshot      func() *Snapshot
	allowedOrigin string
	now           func() time.Time
	reverse       *httputil.ReverseProxy
}

// NewProxy builds the proxy. allowedOrigin is the Core origin (scheme://host[:port]) browsers send
// as Origin; requests from any other origin are refused.
func NewProxy(snapshot func() *Snapshot, target *url.URL, allowedOrigin string, now func() time.Time) *Proxy {
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	p := &Proxy{snapshot: snapshot, allowedOrigin: allowedOrigin, now: now}
	p.reverse = &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			src := r.In.URL.Query().Get("src")
			r.SetURL(target)
			// Forward exactly the stream selector: the ticket, any other parameter and every
			// credential-bearing header stay behind.
			r.Out.URL.RawQuery = url.Values{"src": {src}}.Encode()
			r.Out.Host = target.Host
			for _, header := range []string{"Authorization", "Cookie", "Origin", "Referer", "Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto"} {
				r.Out.Header.Del(header)
			}
		},
		ModifyResponse: func(response *http.Response) error {
			// go2rtc's own CORS answer (if any) is replaced by the gateway's origin policy.
			for _, header := range []string{"Access-Control-Allow-Origin", "Access-Control-Allow-Methods", "Access-Control-Allow-Headers", "Access-Control-Allow-Credentials", "Access-Control-Expose-Headers"} {
				response.Header.Del(header)
			}
			response.Header.Set("Cache-Control", "no-store")
			if origin, _ := response.Request.Context().Value(originKey{}).(string); origin != "" {
				response.Header.Set("Access-Control-Allow-Origin", origin)
				response.Header.Add("Vary", "Origin")
			}
			return nil
		},
		ErrorLog: log.New(io.Discard, "", 0),
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "stream backend unavailable", http.StatusBadGateway)
		},
	}
	return p
}

func notFound(w http.ResponseWriter) { http.Error(w, "not found", http.StatusNotFound) }

func (p *Proxy) setCORS(w http.ResponseWriter, origin string) {
	if origin == "" {
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Add("Vary", "Origin")
}

func bearerTicket(r *http.Request) string {
	if ticket := r.URL.Query().Get("ticket"); ticket != "" {
		return ticket
	}
	scheme, token, found := strings.Cut(strings.TrimSpace(r.Header.Get("Authorization")), " ")
	if found && strings.EqualFold(scheme, "Bearer") {
		return strings.TrimSpace(token)
	}
	return ""
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	isWebRTC := r.URL.Path == webrtcPath
	isWebSocket := r.URL.Path == websocketPath
	if !isWebRTC && !isWebSocket {
		notFound(w)
		return
	}
	sources := r.URL.Query()["src"]
	if len(sources) != 1 || sources[0] == "" || len(sources[0]) > 128 {
		notFound(w)
		return
	}
	src := sources[0]
	origin := r.Header.Get("Origin")
	if origin != "" && origin != p.allowedOrigin {
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	snapshot := p.snapshot()
	if snapshot == nil {
		notFound(w)
		return
	}
	if r.Method == http.MethodOptions && isWebRTC {
		// CORS preflight. It carries no credentials by design; it only reveals the origin policy
		// for streams that exist.
		if _, ok := snapshot.Streams[src]; !ok || origin == "" {
			notFound(w)
			return
		}
		p.setCORS(w, origin)
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Max-Age", preflightMaxAge)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if (isWebRTC && r.Method != http.MethodPost) || (isWebSocket && (r.Method != http.MethodGet || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket"))) {
		w.Header().Set("Allow", map[bool]string{true: "POST, OPTIONS", false: "GET"}[isWebRTC])
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ticket := bearerTicket(r)
	if ticket == "" {
		p.setCORS(w, origin)
		w.Header().Set("WWW-Authenticate", "Bearer")
		http.Error(w, "stream ticket required", http.StatusUnauthorized)
		return
	}
	if _, err := streamticket.VerifyForStream(ticket, snapshot.verificationKeys(p.now()), src, p.now()); err != nil {
		p.setCORS(w, origin)
		http.Error(w, "stream ticket rejected", http.StatusUnauthorized)
		return
	}
	if _, ok := snapshot.Streams[src]; !ok {
		notFound(w)
		return
	}
	if isWebRTC {
		r.Body = http.MaxBytesReader(w, r.Body, maxOfferBytes)
	}
	// Tell ModifyResponse which origin to allow without keeping per-request state in the proxy.
	p.reverse.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), originKey{}, origin)))
}
