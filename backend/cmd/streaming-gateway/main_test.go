package main

import (
	"net/url"
	"testing"
)

func TestPlayerOriginDefaultsToCore(t *testing.T) {
	core, _ := url.Parse("https://makerspace.example.org")
	got, err := playerOrigin(core, "")
	if err != nil || got != "https://makerspace.example.org" {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestPlayerOriginOverride(t *testing.T) {
	core, _ := url.Parse("http://host.docker.internal:8080")
	for _, input := range []string{"http://localhost:5173", "http://localhost:5173/"} {
		got, err := playerOrigin(core, input)
		if err != nil || got != "http://localhost:5173" {
			t.Fatalf("%q: got %q, %v", input, got, err)
		}
	}
	for _, input := range []string{"localhost:5173", "ftp://localhost", "http://", "http://localhost/player", "http://user@localhost", "http://localhost?x=1"} {
		if _, err := playerOrigin(core, input); err == nil {
			t.Fatalf("%q: expected an error", input)
		}
	}
}
