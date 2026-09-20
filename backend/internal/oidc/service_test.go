package oidc

import (
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"golang.org/x/oauth2"
)

func TestPKCEChallengeMatchesOAuthS256(t *testing.T) {
	verifier := "0123456789012345678901234567890123456789012"
	if got, want := PKCEChallenge(verifier), oauth2.S256ChallengeFromVerifier(verifier); got != want {
		t.Fatalf("PKCE challenge = %q, want %q", got, want)
	}
}

func TestAssuranceForClaimsUsesOnlyExactTrustedACR(t *testing.T) {
	encoded := []byte(`{"urn:example:mfa":"strong_mfa","urn:example:strong":"strong"}`)
	tests := []struct {
		acr  string
		want authorization.Assurance
	}{
		{"urn:example:mfa", authorization.AssuranceStrongMFA},
		{"urn:example:strong", authorization.AssuranceStrong},
		{"URN:EXAMPLE:MFA", authorization.AssuranceNormal},
		{"", authorization.AssuranceNormal},
		{"untrusted", authorization.AssuranceNormal},
	}
	for _, test := range tests {
		got, err := assuranceForClaims(encoded, test.acr)
		if err != nil {
			t.Fatal(err)
		}
		if got != test.want {
			t.Fatalf("assurance for %q = %q, want %q", test.acr, got, test.want)
		}
	}
}

func TestJITRequiresVerifiedEmailOrPhone(t *testing.T) {
	if _, _, _, _, err := jitPersonFields(tokenClaims{Email: "unverified@example.test", Name: "No Contact"}); err == nil {
		t.Fatal("expected unverified email-only claims to be rejected")
	}
	first, last, email, phone, err := jitPersonFields(tokenClaims{Email: "verified@example.test", EmailVerified: true, GivenName: "Ada", FamilyName: "Lovelace"})
	if err != nil {
		t.Fatal(err)
	}
	if first != "Ada" || last != "Lovelace" || email == nil || *email != "verified@example.test" || phone != nil {
		t.Fatalf("unexpected JIT fields: %q %q email=%v phone=%v", first, last, email, phone)
	}
}

func TestProviderValidationRejectsLowAssuranceMapping(t *testing.T) {
	secret := "secret"
	_, _, err := validateProviderInput(ProviderInput{
		Slug: "example-provider", DisplayName: "Example", Issuer: "https://id.example.test/",
		ClientID: "client", ClientSecret: &secret,
		ACRAssuranceMappings: map[string]authorization.Assurance{"weak": authorization.AssuranceLow},
	}, true)
	if err == nil {
		t.Fatal("expected low ACR mapping to be rejected")
	}
}
