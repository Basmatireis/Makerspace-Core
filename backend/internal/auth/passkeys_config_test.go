package auth

import (
	"net/url"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
)

// WebAuthn needs a domain as relying party; a stack served on an IP address (local E2E on 127.0.0.1) keeps
// running with passkeys unavailable instead of failing to start.
func TestNewWebAuthnNeedsADomain(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		base      string
		available bool
	}{
		{"http://127.0.0.1:55173", false},
		{"http://[::1]:5173", false},
		{"http://localhost:5173", true},
		{"https://makerspace.example.org", true},
	} {
		base, err := url.Parse(tc.base)
		if err != nil {
			t.Fatal(err)
		}
		relyingParty, err := newWebAuthn(config.Config{PublicBaseURL: base})
		if err != nil {
			t.Fatalf("%s: %v", tc.base, err)
		}
		if (relyingParty != nil) != tc.available {
			t.Errorf("%s: passkeys available = %v, want %v", tc.base, relyingParty != nil, tc.available)
		}
	}
}
