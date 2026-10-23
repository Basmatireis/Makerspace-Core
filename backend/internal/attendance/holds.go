package attendance

import (
	"context"
	"errors"
	"time"

	attendancedb "github.com/Basmatireis/Makerspace-Core/backend/internal/attendance/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Hold is a check-in held until a supervisor confirms the person's signed Lab Rules. It lapses at ExpiresAt, the
// local midnight after the attempt, so a confirmation on a later day never checks anybody in retroactively.
type Hold struct {
	ID, PersonID          uuid.UUID
	DisplayName           string
	RequestedAt           time.Time
	ExpiresAt             time.Time
	CheckInMethod         string
	LaborordnungRequestID *uuid.UUID
	RequiredRevision      *string
	PreviousRevision      *string
}

// PublicWaiting is the privacy-minimized terminal view of a held check-in.
type PublicWaiting struct {
	HoldID      uuid.UUID
	DisplayName string
	RequestedAt time.Time
}

// CheckInResult is either a visit or, for people whose role blocks admission without current Lab Rules, a hold.
type CheckInResult struct {
	Visit *Visit
	Hold  *Hold
}

type holdInput struct {
	PersonID  uuid.UUID
	DeviceID  *uuid.UUID
	Method    string
	Assurance string
	ByAccount *uuid.UUID
	ActorID   *uuid.UUID
	RequestID *uuid.UUID
}

// nextLocalMidnight is the end of the makerspace's local day containing now.
func nextLocalMidnight(now time.Time, location *time.Location) time.Time {
	local := now.In(location)
	year, month, day := local.Date()
	return time.Date(year, month, day+1, 0, 0, 0, 0, location).UTC()
}

// createHold runs inside the check-in transaction after the person lock and the open-visit check. A repeated attempt
// on the same day keeps the original request time.
func (s *Service) createHold(ctx context.Context, tx pgx.Tx, input holdInput) (Hold, error) {
	q := attendancedb.New(tx)
	if err := q.DeleteExpiredHoldForPerson(ctx, input.PersonID); err != nil {
		return Hold{}, err
	}
	row, err := q.UpsertHold(ctx, attendancedb.UpsertHoldParams{
		ID:                   ids.New(),
		PersonID:             input.PersonID,
		ExpiresAt:            nextLocalMidnight(time.Now(), s.location),
		CheckInDeviceID:      input.DeviceID,
		CheckInMethod:        input.Method,
		CheckInAssurance:     input.Assurance,
		CheckedInByAccountID: input.ByAccount,
	})
	if err != nil {
		return Hold{}, err
	}
	if err = audit.Write(ctx, tx, audit.Event{
		ActorAccountID: input.ActorID,
		Action:         "attendance_hold.created",
		ResourceType:   "attendance_hold",
		ResourceID:     &row.ID,
		RequestID:      input.RequestID,
	}); err != nil {
		return Hold{}, err
	}
	view, err := q.GetActiveHoldView(ctx, input.PersonID)
	if err != nil {
		return Hold{}, err
	}
	return holdFromView(attendancedb.ListActiveHoldsRow(view)), nil
}

// LabRulesConfirmed completes a held check-in inside the transaction that confirms the person's Lab Rules. The visit
// starts at confirmation. When the person is already checked in by other means the hold is simply dropped.
func (s *Service) LabRulesConfirmed(
	ctx context.Context,
	tx pgx.Tx,
	personID, versionID, actorAccountID uuid.UUID,
	requestID *uuid.UUID,
) error {
	q := attendancedb.New(tx)
	hold, err := q.GetActiveHoldForPersonForUpdate(ctx, personID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if err = q.DeleteHoldByIDUnconditional(ctx, hold.ID); err != nil {
		return err
	}
	row, err := q.CreateVisitFromHold(ctx, attendancedb.CreateVisitFromHoldParams{
		ID:                    ids.New(),
		PersonID:              personID,
		CheckInDeviceID:       hold.CheckInDeviceID,
		CheckInMethod:         hold.CheckInMethod,
		CheckInAssurance:      hold.CheckInAssurance,
		LaborordnungVersionID: &versionID,
		CheckedInByAccountID:  hold.CheckedInByAccountID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actorAccountID,
		Action:         "visit.hold_released",
		ResourceType:   "visit",
		ResourceID:     &row.ID,
		RequestID:      requestID,
	})
}

func (s *Service) ListHolds(ctx context.Context, principal authorization.Principal) ([]Hold, error) {
	if !principal.Has(authorization.AttendanceRead) {
		return nil, apperror.PermissionDenied
	}
	rows, err := attendancedb.New(s.pool).ListActiveHolds(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]Hold, 0, len(rows))
	for _, row := range rows {
		result = append(result, holdFromView(row))
	}
	return result, nil
}

func (s *Service) CancelHold(
	ctx context.Context,
	principal authorization.Principal,
	holdID uuid.UUID,
	requestID *uuid.UUID,
) error {
	if !principal.Has(authorization.AttendanceAssist) {
		return apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row, err := attendancedb.New(tx).DeleteHoldByID(ctx, holdID)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor,
		Action:         "attendance_hold.cancelled",
		ResourceType:   "attendance_hold",
		ResourceID:     &row.ID,
		RequestID:      requestID,
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func holdFromView(row attendancedb.ListActiveHoldsRow) Hold {
	return Hold{
		ID:                    row.ID,
		PersonID:              row.PersonID,
		DisplayName:           row.FirstName + " " + row.LastName,
		RequestedAt:           row.RequestedAt.UTC(),
		ExpiresAt:             row.ExpiresAt.UTC(),
		CheckInMethod:         row.CheckInMethod,
		LaborordnungRequestID: row.LaborordnungRequestID,
		RequiredRevision:      row.RequiredRevision,
		PreviousRevision:      row.PreviousRevision,
	}
}
