package runrecordings

import (
	"net/http"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
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
	now               func() time.Time
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

// TimelapseMaxBytes is the largest timelapse video Core accepts.
func (s *Service) TimelapseMaxBytes() int64 { return s.timelapseMaxBytes }

func invalid(code, message string) error {
	return apperror.New(http.StatusUnprocessableEntity, code, message)
}

func timestamptz(value time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: value.UTC(), Valid: true}
}
