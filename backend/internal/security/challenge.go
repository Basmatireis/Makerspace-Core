package security

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"io"
	"math/big"
	"strings"

	"github.com/google/uuid"
)

const challengeAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

func NewChallengeCode() (string, error) {
	result := make([]byte, 8)
	random := make([]byte, 1)
	for index := range result {
		for {
			if _, err := rand.Read(random); err != nil {
				return "", err
			}
			limit := 256 - (256 % len(challengeAlphabet))
			if int(random[0]) < limit {
				result[index] = challengeAlphabet[int(random[0])%len(challengeAlphabet)]
				break
			}
		}
	}
	return string(result), nil
}

// EmailCodeDigits is the length of the numeric one-time codes mailed for signing in and verifying an address.
const EmailCodeDigits = 6

// NewNumericCode returns a uniformly random code of EmailCodeDigits decimal digits (leading zeros kept), short enough
// to type from a mail on a kiosk. Callers bound the attempts per code.
func NewNumericCode() (string, error) {
	limit := big.NewInt(1_000_000)
	value, err := rand.Int(rand.Reader, limit)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%0*d", EmailCodeDigits, value.Int64()), nil
}

// IsNumericCode reports whether code has the shape of a NewNumericCode value.
func IsNumericCode(code string) bool {
	if len(code) != EmailCodeDigits {
		return false
	}
	for _, digit := range code {
		if digit < '0' || digit > '9' {
			return false
		}
	}
	return true
}

func ChallengeDigest(key []byte, kind string, accountID uuid.UUID, code string) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = io.WriteString(mac, kind)
	_, _ = mac.Write([]byte{0})
	_, _ = io.WriteString(mac, accountID.String())
	_, _ = mac.Write([]byte{0})
	_, _ = io.WriteString(mac, strings.ToUpper(strings.TrimSpace(code)))
	return mac.Sum(nil)
}
