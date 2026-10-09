package main

import (
	"strings"
	"testing"
)

func TestReadSecretAcceptsOneBoundedLine(t *testing.T) {
	token := strings.Repeat("a", 43)
	value, err := readSecret(strings.NewReader(token + "\n"))
	if err != nil {
		t.Fatal(err)
	}
	if value != token {
		t.Fatal("credential read from standard input changed")
	}
}

func TestReadSecretRejectsEmptyAndOversizedInput(t *testing.T) {
	for _, value := range []string{"\n", strings.Repeat("a", 129)} {
		if _, err := readSecret(strings.NewReader(value)); err == nil {
			t.Fatal("invalid credential input was accepted")
		}
	}
}
