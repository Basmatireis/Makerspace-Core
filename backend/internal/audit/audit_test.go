package audit

import (
	"context"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	auditdb "github.com/Basmatireis/Makerspace-Core/backend/internal/audit/db"
)

type recordingAuditQueries struct {
	inserted *auditdb.InsertAuditEventParams
}

func (q *recordingAuditQueries) DeleteAuditEventsBefore(context.Context, time.Time) (int64, error) {
	return 0, nil
}

func (q *recordingAuditQueries) InsertAuditEvent(
	_ context.Context,
	params auditdb.InsertAuditEventParams,
) (auditdb.AuditEvent, error) {
	q.inserted = &params
	return auditdb.AuditEvent{}, nil
}

func (q *recordingAuditQueries) ListAuditEvents(
	context.Context,
	auditdb.ListAuditEventsParams,
) ([]auditdb.ListAuditEventsRow, error) {
	return nil, nil
}

func TestWriteRejectsMetadataOutsidePrivacyAllowlist(t *testing.T) {
	queries := &recordingAuditQueries{}
	err := write(context.Background(), queries, Event{
		Action:       "role.assigned",
		ResourceType: "account",
		Metadata:     map[string]any{"email": "private@example.test"},
	})
	if err == nil {
		t.Fatal("non-allowlisted audit metadata was accepted")
	}
	if queries.inserted != nil {
		t.Fatal("invalid audit event reached persistence")
	}
}

func TestWriteAcceptsOpaqueRoleIDAndDefaultsHTTPSource(t *testing.T) {
	queries := &recordingAuditQueries{}
	roleID := ids.New()
	err := write(context.Background(), queries, Event{
		Action:       "person.role_assigned",
		ResourceType: "person",
		Metadata:     map[string]any{"roleId": roleID.String()},
	})
	if err != nil {
		t.Fatal(err)
	}
	if queries.inserted == nil || queries.inserted.Source != "http" {
		t.Fatal("valid audit event was not inserted with the default source")
	}
	if queries.inserted.ActorType != "system" {
		t.Fatalf("actor type = %q, want system", queries.inserted.ActorType)
	}
	if queries.inserted.ChangedFields == nil {
		t.Fatal("nil changed fields would violate the database not-null constraint")
	}
}

func TestWriteDerivesUserActorType(t *testing.T) {
	queries := &recordingAuditQueries{}
	actorID := ids.New()
	if err := write(context.Background(), queries, Event{
		ActorAccountID: &actorID,
		Action:         "person.updated",
		ResourceType:   "person",
	}); err != nil {
		t.Fatal(err)
	}
	if queries.inserted == nil || queries.inserted.ActorType != "user" {
		t.Fatalf("inserted actor type = %#v, want user", queries.inserted)
	}
}

func TestWriteRejectsInconsistentActorTypeAndNonUUIDMetadata(t *testing.T) {
	actorID := ids.New()
	tests := []Event{
		{ActorType: "user", Action: "person.updated", ResourceType: "person"},
		{ActorType: "system", ActorAccountID: &actorID, Action: "person.updated", ResourceType: "person"},
		{ActorType: "unknown", ActorAccountID: &actorID, Action: "person.updated", ResourceType: "person"},
		{
			Action:       "open_day.assignment.created",
			ResourceType: "open_day_assignment",
			Metadata:     map[string]any{"personId": "not-a-uuid"},
		},
	}
	for _, event := range tests {
		queries := &recordingAuditQueries{}
		if err := write(context.Background(), queries, event); err == nil {
			t.Fatalf("invalid event was accepted: %#v", event)
		}
		if queries.inserted != nil {
			t.Fatal("invalid audit event reached persistence")
		}
	}
}

func TestWriteAcceptsOnlyNumericCountMetadata(t *testing.T) {
	queries := &recordingAuditQueries{}
	if err := write(context.Background(), queries, Event{
		Action:       "person.merged",
		ResourceType: "person",
		Metadata:     map[string]any{"countMergedPeople": "2", "countVisits": "17"},
	}); err != nil {
		t.Fatal(err)
	}
	for _, metadata := range []map[string]any{
		{"countVisits": "Ada Lovelace"},
		{"countVisits": "-1"},
		{"countvisits": "1"},
		{"countVisits2": "1"},
		{"countVisits": 3},
	} {
		if err := write(context.Background(), &recordingAuditQueries{}, Event{
			Action: "person.merged", ResourceType: "person", Metadata: metadata,
		}); err == nil {
			t.Fatalf("metadata %v was accepted", metadata)
		}
	}
}
