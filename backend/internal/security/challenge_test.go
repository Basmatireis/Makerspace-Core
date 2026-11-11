package security

import "testing"

func TestNewNumericCodeHasSixDigits(t *testing.T) {
	seen := map[string]struct{}{}
	for range 200 {
		code, err := NewNumericCode()
		if err != nil {
			t.Fatal(err)
		}
		if !IsNumericCode(code) {
			t.Fatalf("code %q is not six digits", code)
		}
		seen[code] = struct{}{}
	}
	if len(seen) < 190 {
		t.Fatalf("codes repeat too often: %d distinct of 200", len(seen))
	}
	for _, invalid := range []string{"", "12345", "1234567", "12345a", " 12345"} {
		if IsNumericCode(invalid) {
			t.Fatalf("%q accepted as a code", invalid)
		}
	}
}
