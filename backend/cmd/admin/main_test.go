package main

import (
	"context"
	"os"
	"strings"
	"testing"
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
	if _, _, err := promptExistingAccountPasswordReset(); err == nil || !strings.Contains(err.Error(), "interactive terminal") {
		t.Fatalf("prompt error = %v, want interactive-terminal refusal", err)
	}
}
