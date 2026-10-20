// Package signage owns digital-signage content: layouts, media assets, scenes, playlists,
// announcement templates and announcements. Displays, pairing, rules, publications and the player
// API build on the same tables in a later phase.
package signage

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ratelimit"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Service implements the signage content use cases. Every method checks the exact permission it
// needs; mutations write their audit event in the same transaction.
type Service struct {
	pool     *pgxpool.Pool
	files    *files.Service
	location *time.Location
	now      func() time.Time
	calendar PublicCalendar
	streams  StreamIssuer

	pairingRequests *ratelimit.Limiter // pairing codes handed out per client IP
	claimFailures   *ratelimit.Limiter // wrong pairing codes entered per staff account
	pairingPolls    *ratelimit.Limiter // pairing polls per client IP

	sweepMu        sync.Mutex
	lastAnnounceGC time.Time
}

// Option customises the service at construction.
type Option func(*Service)

// WithPublicCalendar supplies the already-public open days and events for the player live data.
// Without it those lists stay empty.
func WithPublicCalendar(calendar PublicCalendar) Option {
	return func(s *Service) { s.calendar = calendar }
}

// WithStreamIssuer supplies the camera stream tickets for the player live data. Without it the
// live data carries no streams.
func WithStreamIssuer(issuer StreamIssuer) Option {
	return func(s *Service) { s.streams = issuer }
}

// NewService builds the service. Announcement times are rendered in the makerspace time zone.
func NewService(
	pool *pgxpool.Pool,
	cfg config.Config,
	fileService *files.Service,
	options ...Option,
) (*Service, error) {
	timeZone := cfg.MakerspaceTimeZone
	if timeZone == "" {
		timeZone = "Europe/Vienna"
	}
	location, err := time.LoadLocation(timeZone)
	if err != nil {
		return nil, fmt.Errorf("load makerspace timezone: %w", err)
	}
	service := &Service{
		pool: pool, files: fileService, location: location, now: func() time.Time { return time.Now().UTC() },
		pairingRequests: ratelimit.New(pairingRequestsPerWindow, pairingRequestWindow),
		claimFailures:   ratelimit.New(claimFailuresPerWindow, claimFailureWindow),
		pairingPolls:    ratelimit.New(pairingPollsPerWindow, pairingPollWindow),
	}
	for _, option := range options {
		option(service)
	}
	return service, nil
}

// Reference names one entity that blocks a deletion.
type Reference struct {
	Kind ReferenceKind
	ID   uuid.UUID
	Name string
}

func requireRead(principal authorization.Principal) error {
	if !principal.Has(authorization.SignageRead) {
		return apperror.PermissionDenied
	}
	return nil
}

func requireContentManage(principal authorization.Principal) error {
	if !principal.Has(authorization.SignageContentManage) {
		return apperror.PermissionDenied
	}
	return nil
}

func requireOverride(principal authorization.Principal) error {
	if !principal.Has(authorization.SignageOverride) {
		return apperror.PermissionDenied
	}
	return nil
}

func validation(format string, args ...any) error {
	return apperror.New(http.StatusUnprocessableEntity, "validation_failed", fmt.Sprintf(format, args...))
}

// inUse reports the references that block a deletion as 409 signage_in_use.
func inUse(what string, references []Reference) error {
	listed := make([]map[string]any, 0, len(references))
	for _, reference := range references {
		listed = append(
			listed,
			map[string]any{"kind": reference.Kind, "id": reference.ID.String(), "name": reference.Name},
		)
	}
	result := apperror.New(http.StatusConflict, "signage_in_use", what+" is still in use")
	result.Details["references"] = listed
	return result
}

func databaseError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) &&
		(pgErr.Code == "23505" || pgErr.Code == "23503" || pgErr.Code == "23514" || pgErr.Code == "23001") {
		return apperror.Conflict
	}
	return err
}

func writeAudit(
	ctx context.Context,
	tx pgx.Tx,
	principal authorization.Principal,
	action, resource string,
	id uuid.UUID,
	requestID *uuid.UUID,
	fields []string,
) error {
	actor := principal.AccountID
	return audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         action,
			ResourceType:   resource,
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  fields,
		},
	)
}

func requireExpected(expected int64) error {
	if expected < 1 {
		return validation("expectedVersion must be positive")
	}
	return nil
}

// cleanName trims and validates a display name.
func cleanName(value, label string, max int) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || utf8.RuneCountInString(trimmed) > max || !plainText(trimmed, max, false) {
		return "", validation("%s must be 1 to %d characters of single-line text", label, max)
	}
	return trimmed, nil
}

// uuidStrings renders ids for the text[]-typed array parameters of the queries, which keeps them
// encodable under every pgx query mode.
func uuidStrings(ids []uuid.UUID) []string {
	result := make([]string, 0, len(ids))
	for _, id := range ids {
		result = append(result, id.String())
	}
	return result
}

func pgTime(value *time.Time) pgtype.Timestamptz {
	if value == nil {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: value.UTC(), Valid: true}
}

func fromPgTime(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	moment := value.Time.UTC()
	return &moment
}

func intPointer(value *int32) *int {
	if value == nil {
		return nil
	}
	converted := int(*value)
	return &converted
}

func int32Pointer(value *int) *int32 {
	if value == nil {
		return nil
	}
	converted := int32(*value)
	return &converted
}

// ListLayouts returns the fixed layouts; it is available to every signage reader.
func (s *Service) ListLayouts(_ context.Context, principal authorization.Principal) ([]Layout, error) {
	if err := requireRead(principal); err != nil {
		return nil, err
	}
	return Layouts(), nil
}
