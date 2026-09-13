package auth

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
)

func TestValidateCSRFRequiresCookieHeaderAndStoredDigest(t *testing.T) {
	token := "csrf-token"
	authenticated := Authenticated{CSRFDigest: security.DigestToken(token)}

	if err := ValidateCSRF(authenticated, token, token); err != nil {
		t.Fatalf("valid CSRF token was rejected: %v", err)
	}
	for _, test := range []struct {
		cookie string
		header string
	}{
		{cookie: "", header: token},
		{cookie: token, header: ""},
		{cookie: token, header: "different"},
		{cookie: "different", header: "different"},
	} {
		if err := ValidateCSRF(authenticated, test.cookie, test.header); !apperror.IsCode(err, "csrf_invalid") {
			t.Fatalf("invalid CSRF tokens returned %v", err)
		}
	}
}

func TestLoginLimiterIsBoundedAndResetsAfterSuccess(t *testing.T) {
	limiter := newLoginLimiter()
	now := time.Now().UTC()
	for attempt := 1; attempt <= 10; attempt++ {
		if !limiter.Allow("source-and-email-digest", now) {
			t.Fatalf("attempt %d was blocked too early", attempt)
		}
	}
	if limiter.Allow("source-and-email-digest", now) {
		t.Fatal("eleventh attempt was not blocked")
	}
	limiter.Success("source-and-email-digest")
	if !limiter.Allow("source-and-email-digest", now) {
		t.Fatal("successful login did not reset throttling state")
	}
}
