package calendarfeed

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	calendarfeeddb "github.com/Basmatireis/Makerspace-Core/backend/internal/calendarfeed/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// Window is how far back the feed reaches; everything later is included.
	Window = 30 * 24 * time.Hour
	// UsageInterval is the granularity of the recorded last use: it is written at most this often per feed.
	UsageInterval = time.Hour
	// pathPrefix and pathSuffix surround the token in the public link, below the API base path.
	pathPrefix = "/api/v1/calendar/"
	pathSuffix = ".ics"
)

// Status is what a person may know about their own subscription. The link itself is never part of it.
type Status struct {
	Active     bool
	CreatedAt  *time.Time
	LastUsedAt *time.Time
}

// Link is a freshly issued subscription link, shown exactly once.
type Link struct {
	URL       string
	CreatedAt time.Time
}

// Service manages and serves calendar subscriptions.
type Service struct {
	pool     *pgxpool.Pool
	cfg      config.Config
	location *time.Location
	now      func() time.Time
}

// NewService returns the calendar feed service. Times in the feed are written in UTC; the makerspace time zone only
// words the descriptions.
func NewService(pool *pgxpool.Pool, cfg config.Config) (*Service, error) {
	zone := cfg.MakerspaceTimeZone
	if zone == "" {
		zone = "Europe/Vienna"
	}
	location, err := time.LoadLocation(zone)
	if err != nil {
		return nil, fmt.Errorf("load makerspace timezone: %w", err)
	}
	return &Service{pool: pool, cfg: cfg, location: location, now: func() time.Time { return time.Now().UTC() }}, nil
}

// Get reports whether the principal has a subscription.
func (s *Service) Get(ctx context.Context, principal authorization.Principal) (Status, error) {
	row, err := calendarfeeddb.New(s.pool).GetOwnCalendarFeed(ctx, principal.PersonID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Status{}, nil
	}
	if err != nil {
		return Status{}, fmt.Errorf("load calendar feed: %w", err)
	}
	return Status{Active: true, CreatedAt: &row.CreatedAt, LastUsedAt: timePointer(row.LastUsedAt)}, nil
}

// Rotate creates the principal's subscription or, when one exists, replaces its token: the previous link stops
// working in the same transaction. Only the digest of the new token is stored and audited events never contain it.
func (s *Service) Rotate(
	ctx context.Context,
	principal authorization.Principal,
	requestID *uuid.UUID,
) (Link, error) {
	raw, digest, err := security.NewOpaqueToken()
	if err != nil {
		return Link{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Link{}, fmt.Errorf("begin calendar feed rotation: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := calendarfeeddb.New(tx)
	action := "calendar_feed.rotated"
	if _, err = queries.GetOwnCalendarFeedForUpdate(ctx, principal.PersonID); errors.Is(err, pgx.ErrNoRows) {
		action = "calendar_feed.created"
	} else if err != nil {
		return Link{}, fmt.Errorf("lock calendar feed: %w", err)
	}
	row, err := queries.UpsertCalendarFeed(ctx, calendarfeeddb.UpsertCalendarFeedParams{
		PersonID: principal.PersonID, TokenDigest: digest, CreatedAt: s.now(),
	})
	if err != nil {
		return Link{}, fmt.Errorf("store calendar feed: %w", err)
	}
	if err = s.writeAudit(ctx, tx, principal, action, requestID); err != nil {
		return Link{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Link{}, fmt.Errorf("commit calendar feed: %w", err)
	}
	return Link{URL: s.linkFor(raw), CreatedAt: row.CreatedAt}, nil
}

// Revoke deletes the principal's subscription. Without one it changes nothing and writes no audit event.
func (s *Service) Revoke(ctx context.Context, principal authorization.Principal, requestID *uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin calendar feed revocation: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	removed, err := calendarfeeddb.New(tx).DeleteCalendarFeed(ctx, principal.PersonID)
	if err != nil {
		return fmt.Errorf("delete calendar feed: %w", err)
	}
	if removed > 0 {
		if err = s.writeAudit(ctx, tx, principal, "calendar_feed.revoked", requestID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Service) writeAudit(
	ctx context.Context,
	tx pgx.Tx,
	principal authorization.Principal,
	action string,
	requestID *uuid.UUID,
) error {
	actor, person := principal.AccountID, principal.PersonID
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor,
		Action:         action,
		ResourceType:   "calendar_feed",
		ResourceID:     &person,
		RequestID:      requestID,
	}); err != nil {
		return fmt.Errorf("audit calendar feed: %w", err)
	}
	return nil
}

// linkFor is the public subscription link: absolute when the installation knows its public base URL.
func (s *Service) linkFor(token string) string {
	path := pathPrefix + token + pathSuffix
	if s.cfg.PublicBaseURL == nil {
		return path
	}
	return strings.TrimRight(s.cfg.PublicBaseURL.String(), "/") + path
}

// ownerOf resolves the token of a public request to its person, or reports apperror.NotFound for an unknown,
// revoked or inactive subscription. The only secret-dependent work is the lookup of the token's digest.
func (s *Service) ownerOf(ctx context.Context, token string) (uuid.UUID, error) {
	person, err := calendarfeeddb.New(s.pool).GetCalendarFeedOwnerByDigest(ctx, security.DigestToken(token))
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, apperror.NotFound
	}
	if err != nil {
		return uuid.Nil, fmt.Errorf("resolve calendar feed: %w", err)
	}
	return person, nil
}

// touch records that the feed was read, at most once per UsageInterval. A failure never fails the read.
func (s *Service) touch(ctx context.Context, person uuid.UUID, now time.Time) {
	_ = calendarfeeddb.New(s.pool).TouchCalendarFeed(ctx, calendarfeeddb.TouchCalendarFeedParams{
		PersonID: person, UsedAt: now, StaleBefore: now.Add(-UsageInterval),
	})
}

func timePointer(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	t := value.Time.UTC()
	return &t
}
