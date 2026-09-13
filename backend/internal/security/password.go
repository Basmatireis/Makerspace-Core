package security

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"errors"
	"fmt"
	"net/mail"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

//go:embed common-passwords.txt
var passwordAssets embed.FS

var commonPasswords = func() map[string]struct{} {
	data, err := passwordAssets.ReadFile("common-passwords.txt")
	if err != nil {
		panic(err)
	}
	result := make(map[string]struct{})
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			result[strings.ToLower(line)] = struct{}{}
		}
	}
	return result
}()

const (
	argonMemory      = 64 * 1024
	argonIterations  = 3
	argonParallelism = 1
	argonSaltLength  = 16
	argonKeyLength   = 32
	minPasswordRunes = 12
	maxPasswordRunes = 128
	maxPasswordBytes = 1024
)

func ValidatePassword(password string) error {
	runes := utf8.RuneCountInString(password)
	if !utf8.ValidString(password) || runes < minPasswordRunes || runes > maxPasswordRunes || len(password) > maxPasswordBytes {
		return fmt.Errorf("password must contain between %d and %d valid Unicode characters", minPasswordRunes, maxPasswordRunes)
	}
	if _, blocked := commonPasswords[strings.ToLower(password)]; blocked {
		return errors.New("password is too common")
	}
	return nil
}

func HashPassword(password string) (string, error) {
	if err := ValidatePassword(password); err != nil {
		return "", err
	}
	salt := make([]byte, argonSaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate password salt: %w", err)
	}
	hash := argon2.IDKey([]byte(password), salt, argonIterations, argonMemory, argonParallelism, argonKeyLength)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s", argonMemory, argonIterations, argonParallelism,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(hash)), nil
}

func VerifyPassword(encoded, password string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" || parts[2] != "v=19" {
		return false
	}
	var memory uint32
	var iterations uint32
	var parallelism uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &iterations, &parallelism); err != nil {
		return false
	}
	if parts[3] != fmt.Sprintf("m=%d,t=%d,p=%d", memory, iterations, parallelism) {
		return false
	}
	if memory > 256*1024 || iterations > 10 || parallelism > 8 || memory == 0 || iterations == 0 || parallelism == 0 {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil || len(salt) < 8 || len(salt) > 64 {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(want) < 16 || len(want) > 64 {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, iterations, memory, parallelism, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// PasswordNeedsRehash reports whether a successfully verified Argon2id hash
// should be upgraded to the application's current parameters. Callers must
// still verify the password before replacing a stored credential.
func PasswordNeedsRehash(encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" || parts[2] != "v=19" {
		return true
	}
	var memory uint32
	var iterations uint32
	var parallelism uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &iterations, &parallelism); err != nil {
		return true
	}
	if parts[3] != fmt.Sprintf("m=%d,t=%d,p=%d", memory, iterations, parallelism) {
		return true
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return true
	}
	hash, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return true
	}
	return memory != argonMemory || iterations != argonIterations || parallelism != argonParallelism ||
		len(salt) != argonSaltLength || len(hash) != argonKeyLength
}

func NormalizeEmail(raw string) (display string, normalized string, err error) {
	display = strings.TrimSpace(raw)
	if display == "" || len(display) > 254 {
		return "", "", errors.New("email is required")
	}
	parsed, parseErr := mail.ParseAddress(display)
	if parseErr != nil || parsed.Address != display || !strings.Contains(display, "@") {
		return "", "", errors.New("email is invalid")
	}
	return display, strings.ToLower(display), nil
}

func NewOpaqueToken() (raw string, digest []byte, err error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", nil, fmt.Errorf("generate token: %w", err)
	}
	raw = base64.RawURLEncoding.EncodeToString(value)
	sum := sha256.Sum256([]byte(raw))
	return raw, sum[:], nil
}

func DigestToken(raw string) []byte {
	sum := sha256.Sum256([]byte(raw))
	return sum[:]
}

func ParsePositiveInt(raw string, fallback int) int {
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}
