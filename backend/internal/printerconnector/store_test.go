package printerconnector

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
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
	connectorID := ids.New()
	credentialID := ids.New()
	assignmentID := ids.New()
	runID := ids.New()
	identity := Identity{
		ConnectorID:         connectorID,
		CredentialID:        credentialID,
		CredentialSecret:    "secret",
		CredentialExpiresAt: time.Now().UTC().Add(time.Hour),
		Enrolled:            true,
	}
	configuration := Configuration{
		Revision:        4,
		ProtocolVersion: 1,
		Assignments: []RuntimeAssignment{
			{
				ID:                   assignmentID.String(),
				MachineID:            ids.New().String(),
				AdapterKind:          "simulator",
				AdapterSchemaVersion: 1,
				ConfigurationVersion: 3,
				Settings:             map[string]any{},
				Enabled:              true,
			},
		},
	}
	if err = store.SaveIdentity(ctx, identity); err != nil {
		t.Fatal(err)
	}
	if err = store.SaveConfiguration(ctx, configuration); err != nil {
		t.Fatal(err)
	}
	first, err := store.Enqueue(
		ctx,
		assignmentID,
		3,
		"connectivity",
		json.RawMessage(`{"state":"online"}`),
		&runID,
		true,
		nil,
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Enqueue(
		ctx,
		assignmentID,
		3,
		"operational_state",
		json.RawMessage(`{"state":"idle"}`),
		nil,
		true,
		nil,
		nil,
	)
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
	if err = store.ApplyReceipts(
		ctx,
		[]EventReceipt{{EventID: first.EventID, Status: "accepted"}, {EventID: second.EventID, Status: "duplicate"}},
	); err != nil {
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
	event, err := store.Enqueue(
		ctx,
		ids.New(),
		1,
		"progress",
		json.RawMessage(`{"percent":20}`),
		nil,
		true,
		nil,
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	reason := "invalid_event"
	if err = store.ApplyReceipts(
		ctx,
		[]EventReceipt{{EventID: event.EventID, Status: "rejected", ReasonCode: &reason}},
	); err != nil {
		t.Fatal(err)
	}
	pending, quarantined, err := store.QueueCounts(ctx)
	if err != nil || pending != 0 || quarantined != 1 {
		t.Fatalf("unexpected queue counts: pending=%d quarantined=%d err=%v", pending, quarantined, err)
	}
}

func TestStoreRenumbersPendingEventsBehindCoreAfterLostState(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	// A fresh store numbers from 1 again while Core already holds 1–40.
	assignmentID, otherAssignmentID := ids.New(), ids.New()
	enqueue := func(assignment uuid.UUID) QueuedEvent {
		event, enqueueErr := store.Enqueue(
			ctx,
			assignment,
			1,
			"progress",
			json.RawMessage(`{"percent":20}`),
			nil,
			true,
			nil,
			nil,
		)
		if enqueueErr != nil {
			t.Fatal(enqueueErr)
		}
		return event
	}
	first, second, third := enqueue(assignmentID), enqueue(assignmentID), enqueue(assignmentID)
	other := enqueue(otherAssignmentID)
	if first.Sequence != 1 || third.Sequence != 3 || other.Sequence != 1 {
		t.Fatalf("unexpected initial sequences: %d %d %d", first.Sequence, third.Sequence, other.Sequence)
	}

	reason, next := sequenceConflictReason, int64(41)
	if err = store.ApplyReceipts(
		ctx,
		[]EventReceipt{
			{EventID: first.EventID, Status: ReceiptRejected, ReasonCode: &reason, NextSequence: &next},
			{EventID: second.EventID, Status: ReceiptRejected, ReasonCode: &reason, NextSequence: &next},
		},
	); err != nil {
		t.Fatal(err)
	}
	pending, quarantined, err := store.QueueCounts(ctx)
	if err != nil || pending != 4 || quarantined != 0 {
		t.Fatalf("conflicting events were not kept pending: pending=%d quarantined=%d err=%v", pending, quarantined, err)
	}
	events, err := store.Pending(ctx, 20)
	if err != nil {
		t.Fatal(err)
	}
	sequences := map[uuid.UUID]int64{}
	for _, event := range events {
		sequences[event.EventID] = event.Sequence
	}
	if sequences[first.EventID] != 41 || sequences[second.EventID] != 42 || sequences[third.EventID] != 43 ||
		sequences[other.EventID] != 1 {
		t.Fatalf("pending events were not renumbered from Core's next sequence: %v", sequences)
	}
	if event := enqueue(assignmentID); event.Sequence != 44 {
		t.Fatalf("new event sequence = %d, want 44", event.Sequence)
	}

	// A conflict without Core's next sequence is still quarantined.
	if err = store.ApplyReceipts(
		ctx,
		[]EventReceipt{{EventID: other.EventID, Status: ReceiptRejected, ReasonCode: &reason}},
	); err != nil {
		t.Fatal(err)
	}
	if _, quarantined, err = store.QueueCounts(ctx); err != nil || quarantined != 1 {
		t.Fatalf("conflict without next sequence was not quarantined: quarantined=%d err=%v", quarantined, err)
	}
}

func TestArtifactRetrievalPersistsAndRequiresStableCandidate(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	dir := t.TempDir()
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	assignmentID, runID := ids.New(), ids.New()
	if err = store.ScheduleArtifactRetrieval(
		ctx,
		assignmentID,
		runID,
		4,
		"plate.3mf",
		time.Now().UTC().Add(time.Hour),
	); err != nil {
		t.Fatal(err)
	}
	retrieval, err := store.PendingArtifactRetrieval(ctx, assignmentID)
	if err != nil || retrieval == nil || retrieval.ReportedPath != "plate.3mf" {
		t.Fatalf("unexpected retrieval: %#v err=%v", retrieval, err)
	}
	candidate := ArtifactCandidate{RemotePath: "/cache/plate.3mf", Name: "plate.3mf", Size: 1234}
	stable, err := store.ObserveArtifactCandidate(ctx, *retrieval, candidate)
	if err != nil || stable {
		t.Fatalf("first observation must not be stable: stable=%v err=%v", stable, err)
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if _, err = store.db.ExecContext(
		ctx,
		`UPDATE artifact_retrievals SET next_attempt_at=? WHERE assignment_id=? AND run_id=?`,
		time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano),
		assignmentID.String(),
		runID.String(),
	); err != nil {
		t.Fatal(err)
	}
	if deferred, pendingErr := store.PendingArtifactRetrieval(ctx, assignmentID); pendingErr != nil || deferred != nil {
		t.Fatalf("future retry was unexpectedly due: %#v err=%v", deferred, pendingErr)
	}
	if err = store.RetryPendingArtifactRetrievalsNow(ctx, assignmentID); err != nil {
		t.Fatal(err)
	}
	retrieval, err = store.PendingArtifactRetrieval(ctx, assignmentID)
	if err != nil || retrieval == nil {
		t.Fatalf("retrieval did not survive restart: %#v err=%v", retrieval, err)
	}
	stable, err = store.ObserveArtifactCandidate(ctx, *retrieval, candidate)
	if err != nil || !stable {
		t.Fatalf("matching observation should be stable: stable=%v err=%v", stable, err)
	}
}
