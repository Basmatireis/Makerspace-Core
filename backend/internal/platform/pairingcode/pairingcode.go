// Package pairingcode generates and checks the short codes an unregistered device shows on its screen so that staff
// can claim it in Core (signage displays and kiosks). The codes are stored only as digests.
package pairingcode

import (
	"crypto/rand"
	"crypto/sha256"
	"strings"
)

const (
	// Alphabet leaves out look-alike characters (0/O, 1/I).
	Alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	// Length is the number of characters of a pairing code.
	Length = 6
)

// Generate returns a random code over Alphabet. The alphabet has 32 characters, so masking a random byte to five
// bits is unbiased.
func Generate() (string, error) {
	raw := make([]byte, Length)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	code := make([]byte, Length)
	for index, value := range raw {
		code[index] = Alphabet[value&31]
	}
	return string(code), nil
}

// Normalize upper-cases the code and drops spaces and dashes; ok is false when the result is not a well-formed code.
func Normalize(raw string) (string, bool) {
	code := strings.ToUpper(strings.NewReplacer(" ", "", "-", "").Replace(raw))
	if len(code) != Length {
		return "", false
	}
	for _, character := range code {
		if !strings.ContainsRune(Alphabet, character) {
			return "", false
		}
	}
	return code, true
}

// Digest is what the database stores for a code. The purpose keeps the digests of different pairing flows apart.
func Digest(purpose, code string) []byte {
	sum := sha256.Sum256([]byte(purpose + ":" + code))
	return sum[:]
}
