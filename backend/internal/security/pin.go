package security

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
)

func ValidatePIN(pin string) error {
	if len(pin) < 6 || len(pin) > 12 {
		return errors.New("PIN must contain 6 to 12 digits")
	}
	for _, value := range []byte(pin) {
		if value < '0' || value > '9' {
			return errors.New("PIN must contain only digits")
		}
	}
	return nil
}

func HashPIN(pepper []byte, pin string) (string, error) {
	if err := ValidatePIN(pin); err != nil {
		return "", err
	}
	return HashPassword(pepperedPIN(pepper, pin))
}

func VerifyPIN(pepper []byte, encoded, pin string) bool {
	if ValidatePIN(pin) != nil {
		return false
	}
	return VerifyPassword(encoded, pepperedPIN(pepper, pin))
}

func pepperedPIN(pepper []byte, pin string) string {
	mac := hmac.New(sha256.New, pepper)
	_, _ = mac.Write([]byte(pin))
	return base64.RawStdEncoding.EncodeToString(mac.Sum(nil))
}
