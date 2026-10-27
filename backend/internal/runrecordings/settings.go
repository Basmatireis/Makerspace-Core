package runrecordings

import (
	"context"
	"errors"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/runrecordings/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// MaxTimelapseRetentionDays bounds the retention setting.
const MaxTimelapseRetentionDays = 3650

// GetSettings returns the recording settings (machine_jobs.read or machines.manage).
func (s *Service) GetSettings(ctx context.Context, p authorization.Principal) (Settings, error) {
	if !p.Has(authorization.MachineJobsRead) && !p.Has(authorization.MachinesManage) {
		return Settings{}, apperror.PermissionDenied
	}
	row, err := db.New(s.pool).GetRecordingSettings(ctx)
	if err != nil {
		return Settings{}, err
	}
	return settingsFrom(row), nil
}

// UpdateSettings changes the recording settings (machines.manage). Connectors
// read timelapseEnabled from every configuration poll.
func (s *Service) UpdateSettings(
	ctx context.Context,
	p authorization.Principal,
	input SettingsInput,
	requestID *uuid.UUID,
) (Settings, error) {
	if !p.Has(authorization.MachinesManage) {
		return Settings{}, apperror.PermissionDenied
	}
	if input.TimelapseRetentionDays < 0 || input.TimelapseRetentionDays > MaxTimelapseRetentionDays || input.ExpectedVersion < 1 {
		return Settings{}, apperror.Invalid("timelapseRetentionDays must be between 0 and 3650")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Settings{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	current, err := q.GetRecordingSettings(ctx)
	if err != nil {
		return Settings{}, err
	}
	row, err := q.UpdateRecordingSettings(ctx, db.UpdateRecordingSettingsParams{
		TimelapseEnabled:       input.TimelapseEnabled,
		TimelapseRetentionDays: int32(input.TimelapseRetentionDays), //nolint:gosec // bounded to 0..3650 above
		ExpectedVersion:        input.ExpectedVersion,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Settings{}, apperror.StaleWrite
	}
	if err != nil {
		return Settings{}, err
	}
	var fields []string
	if current.TimelapseEnabled != row.TimelapseEnabled {
		fields = append(fields, "timelapseEnabled")
	}
	if current.TimelapseRetentionDays != row.TimelapseRetentionDays {
		fields = append(fields, "timelapseRetentionDays")
	}
	actor := p.AccountID
	if err = audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor,
		Action:         "run_recording_settings.updated",
		ResourceType:   "run_recording_settings",
		RequestID:      requestID,
		ChangedFields:  fields,
	}); err != nil {
		return Settings{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Settings{}, err
	}
	return settingsFrom(row), nil
}

func settingsFrom(row db.RunRecordingSetting) Settings {
	return Settings{
		TimelapseEnabled:       row.TimelapseEnabled,
		TimelapseRetentionDays: int(row.TimelapseRetentionDays),
		Version:                row.Version,
		UpdatedAt:              row.UpdatedAt.UTC(),
	}
}
