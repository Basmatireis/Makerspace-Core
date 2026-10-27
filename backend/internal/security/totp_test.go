package security

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// RFC 6238 appendix B test vectors for HMAC-SHA-1 with the ASCII secret "12345678901234567890".
func TestHOTPMatchesRFC6238SHA1Vectors(t *testing.T) {
	secret := []byte("12345678901234567890")
	vectors := []struct {
		unix int64
		code string
	}{
		{59, "94287082"},
		{1111111109, "07081804"},
		{1111111111, "14050471"},
		{1234567890, "89005924"},
		{2000000000, "69279037"},
		{20000000000, "65353130"},
	}
	for _, vector := range vectors {
		step := TOTPStep(time.Unix(vector.unix, 0))
		if got := HOTP(secret, uint64(step), 8); got != vector.code {
			t.Fatalf("T=%d: code %s, want %s", vector.unix, got, vector.code)
		}
		if got := HOTP(secret, uint64(step), 6); got != vector.code[2:] {
			t.Fatalf("T=%d: six-digit code %s, want %s", vector.unix, got, vector.code[2:])
		}
	}
}

func TestVerifyTOTPAllowsOneStepDriftAndRejectsReplay(t *testing.T) {
	secret := []byte("12345678901234567890")
	now := time.Unix(1111111111, 0)
	current := TOTPStep(now)
	for _, step := range []int64{current - 1, current, current + 1} {
		code := HOTP(secret, uint64(step), TOTPDigits)
		matched, ok := VerifyTOTP(secret, code, now, nil)
		if !ok || matched != step {
			t.Fatalf("step %d: ok=%v matched=%d", step, ok, matched)
		}
	}
	for _, step := range []int64{current - 2, current + 2} {
		if _, ok := VerifyTOTP(secret, HOTP(secret, uint64(step), TOTPDigits), now, nil); ok {
			t.Fatalf("step %d outside the drift window was accepted", step)
		}
	}
	code := HOTP(secret, uint64(current), TOTPDigits)
	used := current
	if _, ok := VerifyTOTP(secret, code, now, &used); ok {
		t.Fatal("a code of an already used step was accepted again")
	}
	older := current - 1
	if _, ok := VerifyTOTP(secret, HOTP(secret, uint64(current-1), TOTPDigits), now, &older); ok {
		t.Fatal("a code of an already used older step was accepted")
	}
	if matched, ok := VerifyTOTP(secret, code, now, &older); !ok || matched != current {
		t.Fatal("a newer step than the last used one was rejected")
	}
	for _, malformed := range []string{"", "12345", "1234567", "abcdef"} {
		if _, ok := VerifyTOTP(secret, malformed, now, nil); ok {
			t.Fatalf("malformed code %q was accepted", malformed)
		}
	}
}

func TestTOTPProvisioningURICarriesParameters(t *testing.T) {
	secret := []byte("12345678901234567890")
	uri := TOTPProvisioningURI("Maker Space", "ada@example.test", secret)
	for _, part := range []string{
		"otpauth://totp/Maker%20Space:ada@example.test?", "secret=" + TOTPSecretText(secret),
		"issuer=Maker+Space", "algorithm=SHA1", "digits=6", "period=30",
	} {
		if !strings.Contains(uri, part) {
			t.Fatalf("URI %s lacks %s", uri, part)
		}
	}
	if TOTPSecretText(secret) != "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" {
		t.Fatalf("unexpected base32 secret %s", TOTPSecretText(secret))
	}
}

func TestRecoveryCodesAreUniqueAndDigestIgnoresFormatting(t *testing.T) {
	key := []byte("recovery-code-test-key-32-bytes!")
	account := uuid.New()
	seen := map[string]struct{}{}
	for range 50 {
		code, err := NewRecoveryCode()
		if err != nil {
			t.Fatal(err)
		}
		if len(code) != 11 || code[5] != '-' {
			t.Fatalf("unexpected recovery code format %q", code)
		}
		if _, ok := seen[code]; ok {
			t.Fatalf("duplicate recovery code %q", code)
		}
		seen[code] = struct{}{}
		digest := RecoveryCodeDigest(key, account, code)
		lower := strings.ToLower(strings.ReplaceAll(code, "-", " "))
		if string(digest) != string(RecoveryCodeDigest(key, account, lower)) {
			t.Fatal("digest depends on case or separators")
		}
		if string(digest) == string(RecoveryCodeDigest(key, uuid.New(), code)) {
			t.Fatal("digest is not bound to the account")
		}
	}
}
