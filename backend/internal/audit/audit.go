package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	auditdb "github.com/Basmatireis/Makerspace-Core/backend/internal/audit/db"
	"github.com/google/uuid"
)

type Event struct {
	ActorType      ActorType
	ActorAccountID *uuid.UUID
	Action         string
	ResourceType   string
	ResourceID     *uuid.UUID
	RequestID      *uuid.UUID
	ChangedFields  []string
	Metadata       map[string]any
	Source         Source
}

func Write(ctx context.Context, db auditdb.DBTX, event Event) error {
	return write(ctx, auditdb.New(db), event)
}

func write(ctx context.Context, queries auditdb.Querier, event Event) error {
	actorType := event.ActorType
	if actorType == "" {
		if event.ActorAccountID != nil {
			actorType = ActorUser
		} else {
			actorType = ActorSystem
		}
	}
	switch actorType {
	case ActorUser:
		if event.ActorAccountID == nil {
			return fmt.Errorf("user audit actor requires an account ID")
		}
	case ActorSystem:
		if event.ActorAccountID != nil {
			return fmt.Errorf("system audit actor cannot have an account ID")
		}
	case ActorUnknown:
		if event.ActorAccountID != nil {
			return fmt.Errorf("unknown audit actor cannot have an account ID")
		}
	default:
		return fmt.Errorf("invalid audit actor type")
	}
	if strings.TrimSpace(event.Action) == "" || utf8.RuneCountInString(event.Action) > 128 {
		return fmt.Errorf("invalid audit action")
	}
	if strings.TrimSpace(event.ResourceType) == "" || utf8.RuneCountInString(event.ResourceType) > 64 {
		return fmt.Errorf("invalid audit resource type")
	}
	if event.Source == "" {
		event.Source = SourceHTTP
	}
	if event.Source != SourceHTTP && event.Source != SourceAdminCLI && event.Source != SourceSystem {
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
		if key != "orderId" && key != "paymentId" && key != "replacementOrderId" && key != "externalInvoiceRequestId" &&
			key != "roleId" &&
			key != "personId" &&
			key != "openDayId" &&
			key != "eventId" &&
			key != "shiftId" &&
			key != "connectorId" &&
			key != "assignmentId" &&
			key != "runId" &&
			key != "jobId" &&
			key != "artifactId" &&
			key != "trainingId" {
			return fmt.Errorf("audit metadata key %q is not allowlisted", key)
		}
		text, ok := value.(string)
		if !ok || utf8.RuneCountInString(text) > 500 {
			return fmt.Errorf("invalid audit metadata value for %q", key)
		}
		if _, err := uuid.Parse(text); err != nil {
			return fmt.Errorf("invalid audit %s metadata", key)
		}
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	_, err = queries.InsertAuditEvent(ctx, auditdb.InsertAuditEventParams{
		ID:             ids.New(),
		ActorType:      string(actorType),
		ActorAccountID: event.ActorAccountID,
		Action:         event.Action,
		ResourceType:   event.ResourceType,
		ResourceID:     event.ResourceID,
		RequestID:      event.RequestID,
		ChangedFields:  changedFields,
		Metadata:       string(encoded),
		Source:         string(event.Source),
	})
	return err
}
