package audit

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	auditdb "github.com/Basmatireis/Makerspace-Core/backend/internal/audit/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Filter struct {
	Limit          int
	Cursor         string
	ActorType      *string
	ActorSearch    string
	Action         *string
	ResourceType   *string
	ResourceID     *uuid.UUID
	ActorAccountID *uuid.UUID
	OccurredFrom   *time.Time
	OccurredTo     *time.Time
}

type AuditEvent struct {
	ID                  uuid.UUID
	ActorType           string
	ActorAccountID      *uuid.UUID
	ActorDisplayName    *string
	Action              string
	ResourceType        string
	ResourceID          *uuid.UUID
	OccurredAt          time.Time
	RequestID           *string
	ChangedFields       []string
	Metadata            map[string]string
	ResolvedMetadata    map[string]string
	ResourceDisplayName *string
	Source              string
}

type Page struct {
	Items      []AuditEvent
	NextCursor *string
}

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func (s *Service) List(ctx context.Context, principal authorization.Principal, filter Filter) (Page, error) {
	if !principal.Has(authorization.AuditRead) {
		return Page{}, apperror.PermissionDenied
	}
	if filter.Limit < 1 || filter.Limit > 100 {
		return Page{}, invalidRequest("limit must be between 1 and 100")
	}
	if len(filter.Cursor) > 500 {
		return Page{}, invalidRequest("cursor is invalid")
	}
	if filter.Action != nil && len([]rune(*filter.Action)) > 128 {
		return Page{}, invalidRequest("action is limited to 128 characters")
	}
	if filter.ResourceType != nil && len([]rune(*filter.ResourceType)) > 64 {
		return Page{}, invalidRequest("resourceType is limited to 64 characters")
	}
	if filter.ActorType != nil && *filter.ActorType != "user" && *filter.ActorType != "system" && *filter.ActorType != "unknown" {
		return Page{}, invalidRequest("actorType is invalid")
	}
	filter.ActorSearch = strings.TrimSpace(filter.ActorSearch)
	if len([]rune(filter.ActorSearch)) > 100 {
		return Page{}, invalidRequest("actorSearch is limited to 100 characters")
	}
	if filter.OccurredFrom != nil && filter.OccurredTo != nil && filter.OccurredFrom.After(*filter.OccurredTo) {
		return Page{}, invalidRequest("occurredFrom must not be after occurredTo")
	}
	var beforeTime *time.Time
	var beforeID *uuid.UUID
	if filter.Cursor != "" {
		decoded, err := base64.RawURLEncoding.DecodeString(filter.Cursor)
		if err != nil {
			return Page{}, invalidRequest("cursor is invalid")
		}
		parts := strings.Split(string(decoded), "|")
		if len(parts) != 2 {
			return Page{}, invalidRequest("cursor is invalid")
		}
		parsedTime, err := time.Parse(time.RFC3339Nano, parts[0])
		if err != nil {
			return Page{}, invalidRequest("cursor is invalid")
		}
		parsedID, err := uuid.Parse(parts[1])
		if err != nil {
			return Page{}, invalidRequest("cursor is invalid")
		}
		beforeTime, beforeID = &parsedTime, &parsedID
	}
	rows, err := auditdb.New(s.pool).ListAuditEvents(ctx, auditdb.ListAuditEventsParams{
		BeforeTime: nullableTime(beforeTime), BeforeID: beforeID, ActorAccountID: filter.ActorAccountID,
		ActorType: filter.ActorType, ActorSearch: filter.ActorSearch,
		Action: filter.Action, ResourceType: filter.ResourceType, ResourceID: filter.ResourceID,
		OccurredFrom: nullableTime(filter.OccurredFrom), OccurredTo: nullableTime(filter.OccurredTo), PageLimit: int32(filter.Limit + 1),
	})
	if err != nil {
		return Page{}, err
	}
	hasMore := len(rows) > filter.Limit
	if hasMore {
		rows = rows[:filter.Limit]
	}
	items := make([]AuditEvent, 0, len(rows))
	for _, row := range rows {
		metadata := map[string]string{}
		if err := json.Unmarshal(row.Metadata, &metadata); err != nil {
			return Page{}, fmt.Errorf("decode audit metadata: %w", err)
		}
		resolvedMetadata := map[string]string{}
		if err := json.Unmarshal(row.ResolvedMetadata, &resolvedMetadata); err != nil {
			return Page{}, fmt.Errorf("decode resolved audit metadata: %w", err)
		}
		var requestID *string
		if row.RequestID != nil {
			value := row.RequestID.String()
			requestID = &value
		}
		items = append(items, AuditEvent{ID: row.ID, ActorType: row.ActorType, ActorAccountID: row.ActorAccountID,
			ActorDisplayName: nonEmptyPointer(row.ActorDisplayName), ResourceDisplayName: nonEmptyPointer(row.ResourceDisplayName),
			Action: row.Action, ResourceType: row.ResourceType, ResourceID: row.ResourceID, OccurredAt: row.OccurredAt,
			RequestID: requestID, ChangedFields: row.ChangedFields, Metadata: metadata, ResolvedMetadata: resolvedMetadata, Source: row.Source})
	}
	var next *string
	if hasMore && len(items) > 0 {
		last := items[len(items)-1]
		value := base64.RawURLEncoding.EncodeToString([]byte(last.OccurredAt.Format(time.RFC3339Nano) + "|" + last.ID.String()))
		next = &value
	}
	return Page{Items: items, NextCursor: next}, nil
}

func nonEmptyPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func nullableTime(value *time.Time) pgtype.Timestamptz {
	if value == nil {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: value.UTC(), Valid: true}
}

func (s *Service) DeleteBefore(ctx context.Context, before time.Time) (int64, error) {
	return auditdb.New(s.pool).DeleteAuditEventsBefore(ctx, before)
}

func invalidRequest(reason string) *apperror.Error {
	err := apperror.New(400, "invalid_request", "Request is invalid")
	err.Details["reason"] = reason
	return err
}
