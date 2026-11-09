package pairingcode

import (
	"bytes"
	"strings"
	"testing"
)

func TestGenerateUsesAlphabetAndLength(t *testing.T) {
	seen := map[string]struct{}{}
	for i := 0; i < 500; i++ {
		code, err := Generate()
		if err != nil {
			t.Fatal(err)
		}
		if len(code) != Length {
			t.Fatalf("code %q has length %d", code, len(code))
		}
		for _, character := range code {
			if !strings.ContainsRune(Alphabet, character) {
				t.Fatalf("code %q contains %q outside the alphabet", code, character)
			}
		}
		seen[code] = struct{}{}
	}
	if len(seen) < 490 {
		t.Fatalf("only %d distinct codes in 500 draws", len(seen))
	}
	for _, ambiguous := range "01OI" {
		if strings.ContainsRune(Alphabet, ambiguous) {
			t.Fatalf("alphabet contains look-alike %q", ambiguous)
		}
	}
}

func TestNormalizeForgivesCaseAndSeparatorsOnly(t *testing.T) {
	for raw, want := range map[string]string{"abc234": "ABC234", " abc-234 ": "ABC234", "ABC 234": "ABC234"} {
		got, ok := Normalize(raw)
		if !ok || got != want {
			t.Errorf("Normalize(%q) = %q, %v; want %q", raw, got, ok, want)
		}
	}
	for _, raw := range []string{"", "ABC23", "ABC2345", "ABC10O", "ABC23!", "ÄBC234"} {
		if _, ok := Normalize(raw); ok {
			t.Errorf("Normalize(%q) accepted a malformed code", raw)
		}
	}
}

func TestDigestSeparatesPurposesAndHidesTheCode(t *testing.T) {
	signage := Digest("signage-pairing-code", "ABC234")
	device := Digest("managed-device-pairing-code", "ABC234")
	if bytes.Equal(signage, device) {
		t.Fatal("digests of different purposes must differ")
	}
	if len(device) != 32 || bytes.Contains(device, []byte("ABC234")) {
		t.Fatal("digest must be a 32-byte hash that does not contain the code")
	}
}
