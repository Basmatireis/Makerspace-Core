package security

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"io"
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

func ChallengeDigest(key []byte, kind string, accountID uuid.UUID, code string) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = io.WriteString(mac, kind)
	_, _ = mac.Write([]byte{0})
	_, _ = io.WriteString(mac, accountID.String())
	_, _ = mac.Write([]byte{0})
	_, _ = io.WriteString(mac, strings.ToUpper(strings.TrimSpace(code)))
	return mac.Sum(nil)
}
