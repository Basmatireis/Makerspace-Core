package security

import (
	"encoding/base64"
	"fmt"
	"strings"
	"testing"

	"golang.org/x/crypto/argon2"
)

func TestPasswordHashRoundTrip(t *testing.T) {
	password := "a long passphrase with spaces"
	hash, err := HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	if hash == password || !VerifyPassword(hash, password) || VerifyPassword(hash, password+"x") {
		t.Fatal("password verification invariant failed")
	}
}

func TestPasswordPolicyAndEmailNormalization(t *testing.T) {
	if err := ValidatePassword("too short"); err == nil {
		t.Fatal("short password accepted")
	}
	display, normalized, err := NormalizeEmail(" Person@Example.COM ")
	if err != nil || display != "Person@Example.COM" || normalized != "person@example.com" {
		t.Fatalf("unexpected normalization: %q %q %v", display, normalized, err)
	}
}

func TestCommonPasswordIsRejected(t *testing.T) {
	if err := ValidatePassword("correcthorsebatterystaple"); err == nil {
		t.Fatal("common password accepted")
	}
}

func TestPasswordNeedsRehash(t *testing.T) {
	password := "a sufficiently long passphrase"
	current, err := HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	if PasswordNeedsRehash(current) {
		t.Fatal("current password parameters were marked stale")
	}

	salt := []byte("0123456789abcdef")
	legacyHash := argon2.IDKey([]byte(password), salt, 2, 32*1024, 1, 32)
	legacy := fmt.Sprintf("$argon2id$v=19$m=32768,t=2,p=1$%s$%s",
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(legacyHash))
	if !VerifyPassword(legacy, password) {
		t.Fatal("valid legacy password hash did not verify")
	}
	if !PasswordNeedsRehash(legacy) {
		t.Fatal("legacy password parameters were not marked stale")
	}
	if !PasswordNeedsRehash("not-a-password-hash") {
		t.Fatal("malformed password hash was not marked stale")
	}
	malformedParameters := strings.Replace(current, "p=1$", "p=1junk$", 1)
	if VerifyPassword(malformedParameters, password) || !PasswordNeedsRehash(malformedParameters) {
		t.Fatal("non-canonical Argon2 parameters were accepted")
	}
}
