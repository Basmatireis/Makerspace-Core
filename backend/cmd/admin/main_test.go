package main

import (
	"context"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
)

func TestResetPasswordRejectsArgumentsBeforeConfigurationOrDatabaseAccess(t *testing.T) {
	err := run(context.Background(), []string{"reset-password", "must-not-be-accepted"})
	if err == nil || !strings.Contains(err.Error(), "accepts no flags") {
		t.Fatalf("run error = %v, want reset-password argument refusal", err)
	}
}

func TestResetPasswordPromptRejectsPipedInput(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	original := os.Stdin
	os.Stdin = reader
	t.Cleanup(func() { os.Stdin = original })
	if _, _, err := promptExistingAccountPasswordReset(); err == nil ||
		!strings.Contains(err.Error(), "interactive terminal") {
		t.Fatalf("prompt error = %v, want interactive-terminal refusal", err)
	}
}

func TestAnonymizeForStagingRefusesWithoutConfirmationOrOnAPublicOrigin(t *testing.T) {
	loopback := config.Config{PublicBaseURL: &url.URL{Scheme: "http", Host: "localhost:8080"}}
	public := config.Config{PublicBaseURL: &url.URL{Scheme: "https", Host: "app.makerspace.example"}}
	confirm := "--" + anonymizeConfirmationFlag
	cases := []struct {
		name string
		args []string
		cfg  config.Config
		want string
	}{
		{"without confirmation", nil, loopback, "pass --" + anonymizeConfirmationFlag},
		{"with extra arguments", []string{confirm, "now"}, loopback, "accepts only"},
		{"on a public origin", []string{confirm}, public, "looks like production"},
		{"on loopback IPv6", []string{confirm}, config.Config{PublicBaseURL: &url.URL{Scheme: "http", Host: "[::1]:8080"}}, ""},
		{"on loopback", []string{confirm}, loopback, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := checkAnonymizeForStaging(tc.args, tc.cfg)
			if tc.want == "" {
				if err != nil {
					t.Fatalf("check error = %v, want none", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("check error = %v, want %q", err, tc.want)
			}
		})
	}
}
