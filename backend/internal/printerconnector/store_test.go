package printerconnector

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestStorePersistsIdentityConfigurationAndOutboxAcrossRestart(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	dir := t.TempDir()
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	connectorID := uuid.Must(uuid.NewV7())
	credentialID := uuid.Must(uuid.NewV7())
	assignmentID := uuid.Must(uuid.NewV7())
	runID := uuid.Must(uuid.NewV7())
	identity := Identity{ConnectorID: connectorID, CredentialID: credentialID, CredentialSecret: "secret", CredentialExpiresAt: time.Now().UTC().Add(time.Hour), Enrolled: true}
	configuration := Configuration{Revision: 4, ProtocolVersion: 1, Assignments: []RuntimeAssignment{{ID: assignmentID.String(), MachineID: uuid.Must(uuid.NewV7()).String(), AdapterKind: "simulator", AdapterSchemaVersion: 1, ConfigurationVersion: 3, Settings: map[string]any{}, Enabled: true}}}
	if err = store.SaveIdentity(ctx, identity); err != nil {
		t.Fatal(err)
	}
	if err = store.SaveConfiguration(ctx, configuration); err != nil {
		t.Fatal(err)
	}
	first, err := store.Enqueue(ctx, assignmentID, 3, "connectivity", json.RawMessage(`{"state":"online"}`), &runID, true, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Enqueue(ctx, assignmentID, 3, "operational_state", json.RawMessage(`{"state":"idle"}`), nil, true, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.Sequence != 1 || second.Sequence != 2 {
		t.Fatalf("unexpected sequences: %d, %d", first.Sequence, second.Sequence)
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}

	store, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	loadedIdentity, err := store.Identity(ctx)
	if err != nil || loadedIdentity == nil || *loadedIdentity != identity {
		t.Fatalf("identity did not survive restart: %#v, %v", loadedIdentity, err)
	}
	loadedConfiguration, err := store.Configuration(ctx)
	if err != nil || loadedConfiguration == nil || loadedConfiguration.Revision != configuration.Revision {
		t.Fatalf("configuration did not survive restart: %#v, %v", loadedConfiguration, err)
	}
	pending, err := store.Pending(ctx, 20)
	if err != nil || len(pending) != 2 {
		t.Fatalf("outbox did not survive restart: %#v, %v", pending, err)
	}
	if pending[0].RunID == nil || *pending[0].RunID != runID {
		t.Fatalf("run identifier did not survive restart: %#v", pending[0].RunID)
	}
	if err = store.ApplyReceipts(ctx, []EventReceipt{{EventID: first.EventID, Status: "accepted"}, {EventID: second.EventID, Status: "duplicate"}}); err != nil {
		t.Fatal(err)
	}
	pendingCount, quarantinedCount, err := store.QueueCounts(ctx)
	if err != nil || pendingCount != 0 || quarantinedCount != 0 {
		t.Fatalf("unexpected queue counts: pending=%d quarantined=%d err=%v", pendingCount, quarantinedCount, err)
	}
}

func TestStoreQuarantinesRejectedEventsAndLocksDataDirectory(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	dir := t.TempDir()
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if duplicate, openErr := OpenStore(dir); openErr == nil {
		_ = duplicate.Close()
		t.Fatal("expected a second process lock to fail")
	}
	event, err := store.Enqueue(ctx, uuid.Must(uuid.NewV7()), 1, "progress", json.RawMessage(`{"percent":20}`), nil, true, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	reason := "invalid_event"
	if err = store.ApplyReceipts(ctx, []EventReceipt{{EventID: event.EventID, Status: "rejected", ReasonCode: &reason}}); err != nil {
		t.Fatal(err)
	}
	pending, quarantined, err := store.QueueCounts(ctx)
	if err != nil || pending != 0 || quarantined != 1 {
		t.Fatalf("unexpected queue counts: pending=%d quarantined=%d err=%v", pending, quarantined, err)
	}
}
