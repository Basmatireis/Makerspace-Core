package events

import "testing"

func TestValidateEventFileContent(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name, declared string
		data           []byte
		valid          bool
	}{
		{"pdf", "application/pdf", []byte("%PDF-1.7\n"), true},
		{"plain text", "text/plain", []byte("volunteer notes\n"), true},
		{"html disguised as text", "text/plain", []byte("<!doctype html><script>alert(1)</script>"), false},
		{"svg disguised as text", "text/plain", []byte("<?xml version=\"1.0\"?><svg></svg>"), false},
		{"executable disguised as pdf", "application/pdf", []byte{'M', 'Z', 0, 0}, false},
		{"wrong pdf type", "application/pdf", []byte("plain text"), false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateEventFileContent(test.declared, test.data)
			if test.valid && err != nil {
				t.Fatalf("unexpected rejection: %v", err)
			}
			if !test.valid && err == nil {
				t.Fatal("unsafe file content was accepted")
			}
		})
	}
}
