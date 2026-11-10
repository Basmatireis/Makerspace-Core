package attendance

import (
	"context"

	attendancedb "github.com/Basmatireis/Makerspace-Core/backend/internal/attendance/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// EnrollmentCheckIn describes a visitor who just completed kiosk enrollment.
type EnrollmentCheckIn struct {
	PersonID, AccountID uuid.UUID
	DeviceID            uuid.UUID
	// VersionID is the Lab Rules version the visitor confirmed while enrolling, if their role asks for one.
	VersionID *uuid.UUID
	RequestID *uuid.UUID
}

// CheckInAtEnrollment counts a completed enrollment as arriving. It runs inside the enrollment transaction, so the
// account, the Lab Rules confirmation and the visit commit together; the check-in itself is not audited.
func (s *Service) CheckInAtEnrollment(ctx context.Context, tx pgx.Tx, input EnrollmentCheckIn) error {
	accountID := input.AccountID
	row, err := attendancedb.New(tx).CreateVisit(ctx, attendancedb.CreateVisitParams{
		ID: ids.New(), PersonID: input.PersonID, CheckInDeviceID: &input.DeviceID,
		CheckInMethod: "enrollment", CheckInAssurance: string(authorization.AssuranceLow),
		AdmissionDecision: string(AdmissionAdmitted), LaborordnungVersionID: input.VersionID, CheckedInByAccountID: &accountID,
	})
	if err != nil {
		return databaseError(err)
	}
	return s.afterCheckIn(ctx, tx, row.ID)
}
