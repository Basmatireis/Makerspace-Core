package security

import "testing"

func TestPINValidationAndPepperedHashing(t *testing.T) {
	pepper := []byte("test-pin-pepper-that-is-long-enough")
	hash, err := HashPIN(pepper, "123456")
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPIN(pepper, hash, "123456") || VerifyPIN(pepper, hash, "654321") || VerifyPIN([]byte("another-pepper-that-is-long-enough"), hash, "123456") {
		t.Fatal("PIN verification did not bind both PIN and pepper")
	}
	for _, invalid := range []string{"12345", "1234567890123", "12345a", "１２３４５６"} {
		if ValidatePIN(invalid) == nil {
			t.Fatalf("invalid PIN %q was accepted", invalid)
		}
	}
}
