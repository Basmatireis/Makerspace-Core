package security

import (
	"bytes"
	"testing"
)

func TestKeyringRotationAndPurposeBinding(t *testing.T) {
	oldKey, newKey := bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32)
	oldRing, err := NewKeyring([][]byte{oldKey})
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, err := oldRing.Encrypt([]byte("client secret"), "oidc-client-secret")
	if err != nil {
		t.Fatal(err)
	}
	rotated, err := NewKeyring([][]byte{newKey, oldKey})
	if err != nil {
		t.Fatal(err)
	}
	plaintext, err := rotated.Decrypt(ciphertext, "oidc-client-secret")
	if err != nil || string(plaintext) != "client secret" {
		t.Fatalf("decrypt = %q, %v", plaintext, err)
	}
	if !rotated.NeedsRotation(ciphertext) {
		t.Fatal("old ciphertext should require rotation")
	}
	if _, err := rotated.Decrypt(ciphertext, "wrong-purpose"); err == nil {
		t.Fatal("purpose must be authenticated")
	}
}
