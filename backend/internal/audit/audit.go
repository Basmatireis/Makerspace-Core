package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	auditdb "github.com/Basmatireis/Makerspace-Core/backend/internal/audit/db"
	"github.com/google/uuid"
)

type Event struct {
	ActorAccountID *uuid.UUID
	Action         string
	ResourceType   string
	ResourceID     *uuid.UUID
	RequestID      *uuid.UUID
	ChangedFields  []string
	Metadata       map[string]any
	Source         string
}

func Write(ctx context.Context, db auditdb.DBTX, event Event) error {
	return write(ctx, auditdb.New(db), event)
}

func write(ctx context.Context, queries auditdb.Querier, event Event) error {
	if strings.TrimSpace(event.Action) == "" || utf8.RuneCountInString(event.Action) > 128 {
		return fmt.Errorf("invalid audit action")
	}
	if strings.TrimSpace(event.ResourceType) == "" || utf8.RuneCountInString(event.ResourceType) > 64 {
		return fmt.Errorf("invalid audit resource type")
	}
	if event.Source == "" {
		event.Source = "http"
	}
	if event.Source != "http" && event.Source != "admin_cli" && event.Source != "system" {
		return fmt.Errorf("invalid audit source")
	}
	seenFields := make(map[string]struct{}, len(event.ChangedFields))
	for _, field := range event.ChangedFields {
		if strings.TrimSpace(field) == "" || utf8.RuneCountInString(field) > 100 {
			return fmt.Errorf("invalid changed field name")
		}
		if _, duplicate := seenFields[field]; duplicate {
			return fmt.Errorf("duplicate changed field name")
		}
		seenFields[field] = struct{}{}
	}
	changedFields := event.ChangedFields
	if changedFields == nil {
		changedFields = []string{}
	}
	metadata := event.Metadata
	if metadata == nil {
		metadata = map[string]any{}
	}
	for key, value := range metadata {
		if key != "roleId" {
			return fmt.Errorf("audit metadata key %q is not allowlisted", key)
		}
		text, ok := value.(string)
		if !ok || utf8.RuneCountInString(text) > 500 {
			return fmt.Errorf("invalid audit metadata value for %q", key)
		}
		if key == "roleId" {
			if _, err := uuid.Parse(text); err != nil {
				return fmt.Errorf("invalid audit roleId metadata")
			}
		}
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	_, err = queries.InsertAuditEvent(ctx, auditdb.InsertAuditEventParams{
		ID:             uuid.Must(uuid.NewV7()),
		ActorAccountID: event.ActorAccountID,
		Action:         event.Action,
		ResourceType:   event.ResourceType,
		ResourceID:     event.ResourceID,
		RequestID:      event.RequestID,
		ChangedFields:  changedFields,
		Metadata:       string(encoded),
		Source:         event.Source,
	})
	return err
}
