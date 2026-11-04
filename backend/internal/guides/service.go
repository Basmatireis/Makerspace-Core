package guides

import (
	"context"
	"fmt"
	"regexp"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	guidesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/guides/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Status is how a guide ended for an account.
type Status string

const (
	StatusCompleted Status = "completed"
	StatusDismissed Status = "dismissed"
)

var guideIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

// Progress is one account's entry for one guide.
type Progress struct {
	GuideID   string
	Status    Status
	UpdatedAt time.Time
}

// Service reads and writes the principal's own guide progress.
type Service struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

// NewService builds the service.
func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool, now: func() time.Time { return time.Now().UTC() }}
}

// List returns the principal's entries ordered by guide id.
func (s *Service) List(ctx context.Context, principal authorization.Principal) ([]Progress, error) {
	rows, err := guidesdb.New(s.pool).ListOwnGuideProgress(ctx, principal.AccountID)
	if err != nil {
		return nil, fmt.Errorf("list guide progress: %w", err)
	}
	items := make([]Progress, 0, len(rows))
	for _, row := range rows {
		items = append(items, Progress{GuideID: row.GuideID, Status: Status(row.Status), UpdatedAt: row.UpdatedAt})
	}
	return items, nil
}

// Set creates or overwrites the principal's entry for a guide.
func (s *Service) Set(
	ctx context.Context, principal authorization.Principal, guideID string, status Status,
) (Progress, error) {
	if !guideIDPattern.MatchString(guideID) {
		return Progress{}, apperror.InvalidField("guideId")
	}
	if status != StatusCompleted && status != StatusDismissed {
		return Progress{}, apperror.InvalidField("status")
	}
	row, err := guidesdb.New(s.pool).UpsertOwnGuideProgress(ctx, guidesdb.UpsertOwnGuideProgressParams{
		AccountID: principal.AccountID, GuideID: guideID, Status: string(status), UpdatedAt: s.now(),
	})
	if err != nil {
		return Progress{}, fmt.Errorf("store guide progress: %w", err)
	}
	return Progress{GuideID: row.GuideID, Status: Status(row.Status), UpdatedAt: row.UpdatedAt}, nil
}

// Reset deletes every entry of the principal's account.
func (s *Service) Reset(ctx context.Context, principal authorization.Principal) error {
	if _, err := guidesdb.New(s.pool).DeleteOwnGuideProgress(ctx, principal.AccountID); err != nil {
		return fmt.Errorf("reset guide progress: %w", err)
	}
	return nil
}
