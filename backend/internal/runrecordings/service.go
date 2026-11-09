package runrecordings

import (
	"context"
	"net/http"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Service owns recorded-run files, connector run reports, run commands and
// recording settings.
type Service struct {
	pool              *pgxpool.Pool
	files             *files.Service
	logbook           *machinelogbook.Service
	timelapseMaxBytes int64
	notices           NotificationEmitter
	now               func() time.Time
}

// NotificationEmitter is the part of the notification rules this feature raises events with, inside its own
// transaction.
type NotificationEmitter interface {
	// TimelapseReady is told about a run whose timelapse video was just stored.
	TimelapseReady(ctx context.Context, tx pgx.Tx, runID uuid.UUID) error
}

// NewService takes the largest accepted timelapse video in bytes
// (PRINTER_TIMELAPSE_MAX_BYTES).
func NewService(
	pool *pgxpool.Pool,
	fileService *files.Service,
	logbook *machinelogbook.Service,
	timelapseMaxBytes int64,
) *Service {
	return &Service{
		pool:              pool,
		files:             fileService,
		logbook:           logbook,
		timelapseMaxBytes: timelapseMaxBytes,
		now:               func() time.Time { return time.Now().UTC() },
	}
}

// WithNotifications makes a stored timelapse raise the notification trigger. Without it nothing is raised.
func (s *Service) WithNotifications(notices NotificationEmitter) *Service {
	s.notices = notices
	return s
}

// TimelapseMaxBytes is the largest timelapse video Core accepts.
func (s *Service) TimelapseMaxBytes() int64 { return s.timelapseMaxBytes }

func invalid(code, message string) error {
	return apperror.New(http.StatusUnprocessableEntity, code, message)
}

func timestamptz(value time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: value.UTC(), Valid: true}
}
