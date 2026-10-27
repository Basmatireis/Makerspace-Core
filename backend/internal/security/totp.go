package security

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // RFC 6238 TOTP as implemented by authenticator apps uses HMAC-SHA-1
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
)

// TOTP parameters understood by every common authenticator app (RFC 6238 defaults).
const (
	TOTPDigits       = 6
	TOTPPeriod       = 30 * time.Second
	TOTPSecretBytes  = 20
	totpAllowedDrift = 1
)

var totpBase32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// NewTOTPSecret returns a random 160-bit shared secret, the size RFC 4226 recommends for HMAC-SHA-1.
func NewTOTPSecret() ([]byte, error) {
	secret := make([]byte, TOTPSecretBytes)
	if _, err := rand.Read(secret); err != nil {
		return nil, err
	}
	return secret, nil
}

// TOTPSecretText is the unpadded base32 form that users type into an authenticator app.
func TOTPSecretText(secret []byte) string { return totpBase32.EncodeToString(secret) }

// TOTPProvisioningURI is the otpauth:// URI encoded in the enrollment QR code.
func TOTPProvisioningURI(issuer, accountName string, secret []byte) string {
	label := url.PathEscape(issuer) + ":" + url.PathEscape(accountName)
	query := url.Values{}
	query.Set("secret", TOTPSecretText(secret))
	query.Set("issuer", issuer)
	query.Set("algorithm", "SHA1")
	query.Set("digits", fmt.Sprint(TOTPDigits))
	query.Set("period", fmt.Sprint(int(TOTPPeriod/time.Second)))
	return "otpauth://totp/" + label + "?" + query.Encode()
}

// TOTPStep is the RFC 6238 time step that contains now.
func TOTPStep(now time.Time) int64 {
	return now.Unix() / int64(TOTPPeriod/time.Second)
}

// HOTP computes the RFC 4226 one-time password of counter with the requested number of digits.
func HOTP(secret []byte, counter uint64, digits int) string {
	var message [8]byte
	binary.BigEndian.PutUint64(message[:], counter)
	mac := hmac.New(sha1.New, secret)
	_, _ = mac.Write(message[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff
	modulus := uint32(1)
	for range digits {
		modulus *= 10
	}
	return fmt.Sprintf("%0*d", digits, value%modulus)
}

// VerifyTOTP accepts a code of the current, previous, or next time step that is newer than lastUsedStep (nil
// when no code was accepted yet) and returns the matched step so the caller can store it. Every candidate step is
// compared so the timing does not reveal which one matched.
func VerifyTOTP(secret []byte, code string, now time.Time, lastUsedStep *int64) (int64, bool) {
	code = strings.TrimSpace(code)
	if len(code) != TOTPDigits {
		return 0, false
	}
	current := TOTPStep(now)
	matched := int64(-1)
	for step := current - totpAllowedDrift; step <= current+totpAllowedDrift; step++ {
		if step < 0 {
			continue
		}
		expected := HOTP(secret, uint64(step), TOTPDigits)
		if subtle.ConstantTimeCompare([]byte(expected), []byte(code)) == 1 && matched < 0 {
			matched = step
		}
	}
	if matched < 0 || (lastUsedStep != nil && matched <= *lastUsedStep) {
		return 0, false
	}
	return matched, true
}

// RecoveryCodeCount is how many single-use recovery codes one generation issues.
const RecoveryCodeCount = 10

// NewRecoveryCode returns a ten-character code from the unambiguous challenge alphabet, shown as two groups of
// five (about 49 bits of entropy; verification is throttled per account).
func NewRecoveryCode() (string, error) {
	first, err := NewChallengeCode()
	if err != nil {
		return "", err
	}
	second, err := NewChallengeCode()
	if err != nil {
		return "", err
	}
	raw := first + second
	return raw[:5] + "-" + raw[5:10], nil
}

// NormalizeRecoveryCode removes separators and whitespace and upper-cases a typed recovery code.
func NormalizeRecoveryCode(code string) string {
	var builder strings.Builder
	for _, r := range strings.ToUpper(code) {
		if r == '-' || r == ' ' || r == '\t' {
			continue
		}
		builder.WriteRune(r)
	}
	return builder.String()
}

// RecoveryCodeDigest is the keyed digest stored for a recovery code; the code itself is never stored.
func RecoveryCodeDigest(key []byte, accountID uuid.UUID, code string) []byte {
	return ChallengeDigest(key, "mfa_recovery_code", accountID, NormalizeRecoveryCode(code))
}
