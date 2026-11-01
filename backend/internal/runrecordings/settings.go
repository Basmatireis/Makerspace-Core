package runrecordings

import (
	"context"
	"errors"
	"fmt"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/runrecordings/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// MaxTimelapseRetentionDays bounds the retention setting; MinTimelapseMaxBytes and MaxTimelapseCount bound the limits.
const (
	MaxTimelapseRetentionDays = 3650
	MinTimelapseMaxBytes      = 1 << 20
	MaxTimelapseCount         = 100000
)

// GetSettings returns the recording settings (machine_jobs.read or machines.manage).
func (s *Service) GetSettings(ctx context.Context, p authorization.Principal) (Settings, error) {
	if !p.Has(authorization.MachineJobsRead) && !p.Has(authorization.MachinesManage) {
		return Settings{}, apperror.PermissionDenied
	}
	row, err := db.New(s.pool).GetRecordingSettings(ctx)
	if err != nil {
		return Settings{}, err
	}
	return s.settingsFrom(row), nil
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
	if input.TimelapseMaxBytes < MinTimelapseMaxBytes || input.TimelapseMaxBytes > s.timelapseMaxBytes {
		return Settings{}, apperror.Invalid(
			fmt.Sprintf("timelapseMaxBytes must be between %d and %d", MinTimelapseMaxBytes, s.timelapseMaxBytes),
		)
	}
	if input.TimelapseMaxCount < 0 || input.TimelapseMaxCount > MaxTimelapseCount || input.TimelapseMaxTotalBytes < 0 {
		return Settings{}, apperror.Invalid("timelapseMaxCount and timelapseMaxTotalBytes must be 0 or positive")
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
		TimelapseMaxBytes:      input.TimelapseMaxBytes,
		TimelapseMaxCount:      int32(input.TimelapseMaxCount), //nolint:gosec // bounded above
		TimelapseMaxTotalBytes: input.TimelapseMaxTotalBytes,
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
	if current.TimelapseMaxBytes != row.TimelapseMaxBytes {
		fields = append(fields, "timelapseMaxBytes")
	}
	if current.TimelapseMaxCount != row.TimelapseMaxCount {
		fields = append(fields, "timelapseMaxCount")
	}
	if current.TimelapseMaxTotalBytes != row.TimelapseMaxTotalBytes {
		fields = append(fields, "timelapseMaxTotalBytes")
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
	return s.settingsFrom(row), nil
}

func (s *Service) settingsFrom(row db.RunRecordingSetting) Settings {
	return Settings{
		TimelapseEnabled:       row.TimelapseEnabled,
		TimelapseRetentionDays: int(row.TimelapseRetentionDays),
		TimelapseMaxBytes:      min(row.TimelapseMaxBytes, s.timelapseMaxBytes),
		TimelapseMaxBytesLimit: s.timelapseMaxBytes,
		TimelapseMaxCount:      int(row.TimelapseMaxCount),
		TimelapseMaxTotalBytes: row.TimelapseMaxTotalBytes,
		Version:                row.Version,
		UpdatedAt:              row.UpdatedAt.UTC(),
	}
}

// EffectiveTimelapseMaxBytes is the largest video accepted right now: the setting, capped by the deployment's
// ceiling (PRINTER_TIMELAPSE_MAX_BYTES).
func (s *Service) EffectiveTimelapseMaxBytes(ctx context.Context) (int64, error) {
	row, err := db.New(s.pool).GetRecordingSettings(ctx)
	if err != nil {
		return 0, err
	}
	return min(row.TimelapseMaxBytes, s.timelapseMaxBytes), nil
}
