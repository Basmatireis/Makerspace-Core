package printerconnector

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/localupdater"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
)

func newEnrollmentRuntime(t *testing.T, enrollment Enrollment, logs io.Writer) (*Runtime, *[]string) {
	t.Helper()
	var tokens []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tokens = append(tokens, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).
			Encode(map[string]any{
				"connectorId":         ids.New(),
				"credentialExpiresAt": time.Now().UTC().Add(30 * 24 * time.Hour),
			})
	}))
	t.Cleanup(server.Close)
	client, err := NewClient(server.URL, true)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "data")
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return NewRuntime(store, client, dir, enrollment, localupdater.Exchange{}, slog.New(slog.NewTextHandler(logs, nil))), &tokens
}

func TestEnrollmentUsesTheTrimmedEnvironmentSecret(t *testing.T) {
	file := filepath.Join(t.TempDir(), "legacy")
	if err := os.WriteFile(file, []byte("from-file"), 0o600); err != nil {
		t.Fatal(err)
	}
	runtime, tokens := newEnrollmentRuntime(t, Enrollment{Secret: " from-env\n", File: file}, io.Discard)
	identity, err := runtime.ensureIdentity(context.Background())
	if err != nil || !identity.Enrolled {
		t.Fatalf("identity %+v err %v", identity, err)
	}
	if len(*tokens) != 1 || (*tokens)[0] != "from-env" {
		t.Fatalf("enrollment must send the trimmed environment secret, got %q", *tokens)
	}
}

func TestEnrollmentFallsBackToTheLegacyFile(t *testing.T) {
	file := filepath.Join(t.TempDir(), "legacy")
	if err := os.WriteFile(file, []byte("  from-file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runtime, tokens := newEnrollmentRuntime(t, Enrollment{File: file}, io.Discard)
	if _, err := runtime.ensureIdentity(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(*tokens) != 1 || (*tokens)[0] != "from-file" {
		t.Fatalf("got %q", *tokens)
	}
}

func TestEnrollmentWithoutAnySecretExplainsWhatToDo(t *testing.T) {
	runtime, tokens := newEnrollmentRuntime(t, Enrollment{}, io.Discard)
	_, err := runtime.ensureIdentity(context.Background())
	if err == nil || !strings.Contains(err.Error(), "CONNECTOR_ENROLLMENT_SECRET") ||
		!strings.Contains(err.Error(), "Settings > Local services > Printer connectors") {
		t.Fatalf("expected an actionable error, got %v", err)
	}
	if len(*tokens) != 0 {
		t.Fatal("must not call Core without a secret")
	}
}

func TestEnrollmentRejectsAnEmptyLegacyFile(t *testing.T) {
	file := filepath.Join(t.TempDir(), "legacy")
	if err := os.WriteFile(file, []byte(" \n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runtime, _ := newEnrollmentRuntime(t, Enrollment{File: file}, io.Discard)
	if _, err := runtime.ensureIdentity(context.Background()); err == nil {
		t.Fatal("an empty legacy file must fail")
	}
}

func TestEnrolledConnectorIgnoresTheSecretAndNeverLogsIt(t *testing.T) {
	var logs bytes.Buffer
	runtime, tokens := newEnrollmentRuntime(t, Enrollment{Secret: "very-secret-value"}, &logs)
	for range 2 {
		if _, err := runtime.ensureIdentity(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if len(*tokens) != 1 {
		t.Fatalf("an enrolled connector must not enroll again, got %d calls", len(*tokens))
	}
	if !strings.Contains(logs.String(), "already enrolled; CONNECTOR_ENROLLMENT_SECRET is ignored and can be removed") {
		t.Fatalf("missing info message: %s", logs.String())
	}
	if strings.Contains(logs.String(), "very-secret-value") {
		t.Fatal("the enrollment secret must never be logged")
	}
}
