package streaminggateways

import (
	"context"
	"errors"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/streaminggateways/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

// CameraCandidate is a machine that can be given a camera.
type CameraCandidate struct {
	ID         uuid.UUID
	Name, Kind string
}

// ListCameraCandidates lists machines with an active Bambu printer assignment and no camera yet.
// It needs local_services.manage only, so the assign dialog works without machines.read.
func (s *Service) ListCameraCandidates(
	ctx context.Context,
	principal authorization.Principal,
) ([]CameraCandidate, error) {
	if err := requireManage(principal); err != nil {
		return nil, err
	}
	rows, err := db.New(s.pool).ListCameraCandidates(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]CameraCandidate, 0, len(rows))
	for _, row := range rows {
		result = append(result, CameraCandidate{ID: row.ID, Name: row.Name, Kind: row.Kind})
	}
	return result, nil
}

func cameraFrom(row db.GetCameraViewRow, now time.Time) Camera {
	return buildCamera(
		row.ID,
		row.GatewayID,
		row.MachineID,
		row.GatewayName,
		Lifecycle(row.GatewayLifecycle),
		row.MachineName,
		row.Enabled,
		row.Health,
		row.Viewers,
		row.Codec,
		row.Width,
		row.Height,
		row.Fps,
		row.ReportedAt,
		row.Version,
		row.CreatedAt,
		row.UpdatedAt,
		now,
	)
}

func buildCamera(
	id, gatewayID, machineID uuid.UUID,
	gatewayName string,
	gatewayLifecycle Lifecycle,
	machineName string,
	enabled bool,
	health *string,
	viewers *int32,
	codec *string,
	width, height *int32,
	fps *float64,
	reportedAt pgtype.Timestamptz,
	version int64,
	createdAt, updatedAt, now time.Time,
) Camera {
	camera := Camera{
		ID:               id,
		GatewayID:        gatewayID,
		MachineID:        machineID,
		GatewayName:      gatewayName,
		GatewayLifecycle: gatewayLifecycle,
		MachineName:      machineName,
		Enabled:          enabled,
		Health:           CameraUnknown,
		Version:          version,
		CreatedAt:        createdAt,
		UpdatedAt:        updatedAt,
	}
	reported := nullableTime(reportedAt)
	if health == nil || reported == nil || now.Sub(*reported) > cameraStatusStaleAfter || gatewayLifecycle != LifecycleActive {
		return camera
	}
	camera.Health, camera.Codec, camera.FPS, camera.ReportedAt = CameraStatus(*health), codec, fps, reported
	if viewers != nil {
		v := int(*viewers)
		camera.Viewers = &v
	}
	if width != nil {
		v := int(*width)
		camera.Width = &v
	}
	if height != nil {
		v := int(*height)
		camera.Height = &v
	}
	return camera
}

// ListCameras lists a gateway's cameras with their last reported health.
func (s *Service) ListCameras(
	ctx context.Context,
	principal authorization.Principal,
	gatewayID uuid.UUID,
) ([]Camera, error) {
	if err := requireManage(principal); err != nil {
		return nil, err
	}
	q := db.New(s.pool)
	if _, err := q.GetGateway(ctx, gatewayID); errors.Is(err, pgx.ErrNoRows) {
		return nil, apperror.NotFound
	} else if err != nil {
		return nil, err
	}
	return s.listCameras(ctx, q, &gatewayID)
}

// ListAllCameras lists the cameras of every gateway (the local services status view).
func (s *Service) ListAllCameras(ctx context.Context, principal authorization.Principal) ([]Camera, error) {
	if err := requireManage(principal); err != nil {
		return nil, err
	}
	return s.listCameras(ctx, db.New(s.pool), nil)
}

func (s *Service) listCameras(ctx context.Context, q *db.Queries, gatewayID *uuid.UUID) ([]Camera, error) {
	rows, err := q.ListCameraViews(ctx, gatewayID)
	if err != nil {
		return nil, err
	}
	now := s.now()
	result := make([]Camera, 0, len(rows))
	for _, row := range rows {
		result = append(
			result,
			buildCamera(
				row.ID,
				row.GatewayID,
				row.MachineID,
				row.GatewayName,
				Lifecycle(row.GatewayLifecycle),
				row.MachineName,
				row.Enabled,
				row.Health,
				row.Viewers,
				row.Codec,
				row.Width,
				row.Height,
				row.Fps,
				row.ReportedAt,
				row.Version,
				row.CreatedAt,
				row.UpdatedAt,
				now,
			),
		)
	}
	return result, nil
}

// AssignCamera binds a machine's printer camera to a gateway. The machine must exist and have an
// active Bambu printer assignment, because the stream source comes from that assignment.
func (s *Service) AssignCamera(
	ctx context.Context,
	principal authorization.Principal,
	gatewayID, machineID uuid.UUID,
	enabled bool,
	requestID *uuid.UUID,
) (Camera, error) {
	if err := requireManage(principal); err != nil {
		return Camera{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Camera{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	gateway, err := q.GetGatewayForUpdate(ctx, gatewayID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Camera{}, apperror.NotFound
	}
	if err != nil {
		return Camera{}, err
	}
	if Lifecycle(gateway.Lifecycle) == LifecycleRevoked {
		return Camera{}, apperror.Conflicting("streaming_gateway_revoked", "A revoked gateway cannot receive cameras")
	}
	exists, err := q.MachineExists(ctx, machineID)
	if err != nil {
		return Camera{}, err
	}
	if !exists {
		return Camera{}, apperror.Invalid("machineId does not refer to an existing machine")
	}
	if _, err = q.ActiveBambuAssignmentForMachine(ctx, machineID); errors.Is(err, pgx.ErrNoRows) {
		return Camera{}, apperror.Invalid(
			"the machine needs an active Bambu printer assignment (H2D or X1 Carbon) before its camera can be streamed",
		)
	} else if err != nil {
		return Camera{}, err
	}
	id := ids.New()
	if _, err = q.CreateCamera(
		ctx,
		db.CreateCameraParams{ID: id, GatewayID: gatewayID, MachineID: machineID, Enabled: enabled},
	); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return Camera{}, apperror.Conflicting(
				"streaming_camera_exists",
				"This machine already has a streaming camera",
			)
		}
		return Camera{}, databaseError(err)
	}
	if err = q.BumpGatewayConfiguration(ctx, gatewayID); err != nil {
		return Camera{}, err
	}
	actor := principal.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "streaming_camera.assigned",
			ResourceType:   "streaming_camera",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"gatewayId", "machineId", "enabled"},
		},
	); err != nil {
		return Camera{}, err
	}
	view, err := q.GetCameraView(ctx, id)
	if err != nil {
		return Camera{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Camera{}, err
	}
	return cameraFrom(view, s.now()), nil
}

// UpdateCamera enables or disables a camera.
func (s *Service) UpdateCamera(
	ctx context.Context,
	principal authorization.Principal,
	gatewayID, cameraID uuid.UUID,
	enabled bool,
	expected int64,
	requestID *uuid.UUID,
) (Camera, error) {
	if err := requireManage(principal); err != nil {
		return Camera{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Camera{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	if _, err = q.GetCameraForUpdate(ctx, db.GetCameraForUpdateParams{ID: cameraID, GatewayID: gatewayID}); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return Camera{}, apperror.NotFound
	} else if err != nil {
		return Camera{}, err
	}
	if _, err = q.UpdateCameraEnabled(
		ctx,
		db.UpdateCameraEnabledParams{Enabled: enabled, ID: cameraID, GatewayID: gatewayID, ExpectedVersion: expected},
	); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return Camera{}, apperror.StaleWrite
	} else if err != nil {
		return Camera{}, err
	}
	if err = q.BumpGatewayConfiguration(ctx, gatewayID); err != nil {
		return Camera{}, err
	}
	actor := principal.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "streaming_camera.updated",
			ResourceType:   "streaming_camera",
			ResourceID:     &cameraID,
			RequestID:      requestID,
			ChangedFields:  []string{"enabled"},
		},
	); err != nil {
		return Camera{}, err
	}
	view, err := q.GetCameraView(ctx, cameraID)
	if err != nil {
		return Camera{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Camera{}, err
	}
	return cameraFrom(view, s.now()), nil
}

// DeleteCamera unassigns a camera.
func (s *Service) DeleteCamera(
	ctx context.Context,
	principal authorization.Principal,
	gatewayID, cameraID uuid.UUID,
	requestID *uuid.UUID,
) error {
	if err := requireManage(principal); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	affected, err := q.DeleteCamera(ctx, db.DeleteCameraParams{ID: cameraID, GatewayID: gatewayID})
	if err != nil {
		return err
	}
	if affected == 0 {
		return apperror.NotFound
	}
	if err = q.BumpGatewayConfiguration(ctx, gatewayID); err != nil {
		return err
	}
	actor := principal.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "streaming_camera.unassigned",
			ResourceType:   "streaming_camera",
			ResourceID:     &cameraID,
			RequestID:      requestID,
			ChangedFields:  []string{"gatewayId", "machineId"},
		},
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
