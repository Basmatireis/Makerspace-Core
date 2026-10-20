package auth

import (
	"fmt"
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

func TestLoginLimitsBlockOneIdentifierAndResetAfterSuccess(t *testing.T) {
	limits := newLoginLimits()
	now := time.Now().UTC()
	var key string
	for attempt := 1; attempt <= loginAttemptsPerKey; attempt++ {
		var allowed bool
		if key, allowed = limits.take("password", "192.0.2.1", "a@example.org", now); !allowed {
			t.Fatalf("attempt %d was blocked too early", attempt)
		}
	}
	if _, allowed := limits.take("password", "192.0.2.1", "a@example.org", now); allowed {
		t.Fatal("attempt beyond the per-identifier limit was not blocked")
	}
	if _, allowed := limits.take("password", "192.0.2.2", "a@example.org", now); !allowed {
		t.Fatal("another source was blocked by a different client's failures")
	}
	limits.succeeded(key)
	if _, allowed := limits.take("password", "192.0.2.1", "a@example.org", now); !allowed {
		t.Fatal("successful login did not reset throttling state")
	}
}

func TestLoginLimitsStopOneSourceMintingIdentifiersWithoutLockingOthersOut(t *testing.T) {
	limits := newLoginLimits()
	now := time.Now().UTC()
	blocked := false
	for index := 0; index < 5000; index++ {
		if _, allowed := limits.take(
			"password",
			"198.51.100.7",
			fmt.Sprintf("user-%d@example.org", index),
			now,
		); !allowed {
			blocked = true
			if index != loginAttemptsPerSource {
				t.Fatalf("source was blocked after %d identifiers, want %d", index, loginAttemptsPerSource)
			}
			break
		}
	}
	if !blocked {
		t.Fatal("one source could try unlimited identifiers")
	}
	for index := 0; index < 5000; index++ {
		source := fmt.Sprintf("10.%d.%d.1", index/250, index%250)
		if _, allowed := limits.take("password", source, "victim@example.org", now); !allowed && index < 10 {
			t.Fatalf("unrelated source %s was locked out", source)
		}
	}
	if _, allowed := limits.take("password", "203.0.113.9", "someone@example.org", now); !allowed {
		t.Fatal("a full limiter table locked out a new client")
	}
}

func TestLoginLimitsWithoutSourceDoNotShareOneGlobalBucket(t *testing.T) {
	limits := newLoginLimits()
	now := time.Now().UTC()
	for index := 0; index < loginAttemptsPerSource+10; index++ {
		if _, allowed := limits.take("reauthentication", "", fmt.Sprintf("account-%d", index), now); !allowed {
			t.Fatalf("account %d was throttled by other accounts' reauthentication", index)
		}
	}
}
