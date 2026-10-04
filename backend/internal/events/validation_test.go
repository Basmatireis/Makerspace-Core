package events

import (
	"testing"
)

func TestNormalizePhone(t *testing.T) {
	t.Parallel()
	tests := []struct {
		raw, want string
		valid     bool
	}{
		{"+43 660 123-4567", "+436601234567", true},
		{"0043 (660) 1234567", "+436601234567", true},
		{"0316/123456", "0316123456", true},
		{"123", "", false},
		{"+12ABC345678", "", false},
	}
	for _, test := range tests {
		t.Run(test.raw, func(t *testing.T) {
			_, got, err := normalizePhone(test.raw)
			if test.valid && (err != nil || got != test.want) {
				t.Fatalf("normalizePhone(%q) = %q, %v; want %q", test.raw, got, err, test.want)
			}
			if !test.valid && err == nil {
				t.Fatalf("normalizePhone(%q) unexpectedly succeeded", test.raw)
			}
		})
	}
}

func TestLockKeysAreStableSortedAndDeduplicated(t *testing.T) {
	t.Parallel()
	a, b := "a@example.test", "+436601234567"
	got := lockKeys(&b, &a, &a, nil)
	if len(got) != 2 || got[0] >= got[1] {
		t.Fatalf("lockKeys returned %#v", got)
	}
}
