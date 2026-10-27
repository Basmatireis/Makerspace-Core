package attendance

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	attendancedb "github.com/Basmatireis/Makerspace-Core/backend/internal/attendance/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
)

type CredentialVerifier interface {
	VerifyPasswordForAttendance(context.Context, string, string, string) (auth.VerifiedIdentity, error)
	VerifyPINForAttendance(context.Context, string, string, string) (auth.VerifiedIdentity, error)
}

type LabRules interface {
	Evaluate(context.Context, uuid.UUID) (laborordnung.Status, error)
	RequestOwnConfirmation(context.Context, authorization.Principal, *uuid.UUID) (laborordnung.Request, bool, error)
}
type PostVisitSurveyTrigger interface {
	CreatePostVisitInvitations(context.Context, pgx.Tx, uuid.UUID, uuid.UUID) error
	CancelPostVisitInvitations(context.Context, pgx.Tx, uuid.UUID) error
}

type Service struct {
	pool     *pgxpool.Pool
	auth     CredentialVerifier
	labRules LabRules
	surveys  PostVisitSurveyTrigger
	// location defines the local day after which a held check-in lapses.
	location *time.Location
}

func NewService(
	pool *pgxpool.Pool,
	verifier CredentialVerifier,
	labRules LabRules,
	surveys PostVisitSurveyTrigger,
	location *time.Location,
) *Service {
	return &Service{pool: pool, auth: verifier, labRules: labRules, surveys: surveys, location: location}
}

type KioskContext struct {
	DeviceID                            uuid.UUID
	DeviceName                          string
	CheckoutMode                        manageddevices.CheckoutMode
	CheckInAssurance, CheckOutAssurance authorization.Assurance
	AuthenticationMethods, Capabilities []string
}

type PublicPresence struct {
	VisitID     uuid.UUID
	DisplayName string
	CheckedInAt time.Time
}

type Visit struct {
	ID, PersonID      uuid.UUID
	DisplayName       string
	CheckedInAt       time.Time
	CheckedOutAt      *time.Time
	Status            VisitStatus
	CheckInMethod     string
	CheckOutMethod    *string
	AdmissionDecision AdmissionDecision
	CorrectionReason  *string
	Version           int64
}

type Statistics struct {
	From, To                                                      time.Time
	VisitorCount, UniqueVisitors, PeakOccupancy, CurrentOccupancy int64
	VisitorHours, AverageCompletedVisitMinutes                    string
}

func assuranceRank(value authorization.Assurance) int {
	switch value {
	case authorization.AssuranceLow:
		return 1
	case authorization.AssuranceNormal:
		return 2
	case authorization.AssuranceStrong:
		return 3
	case authorization.AssuranceStrongMFA:
		return 4
	default:
		return 0
	}
}

func requireAssurance(actual authorization.Assurance, required authorization.Assurance) error {
	if assuranceRank(actual) < assuranceRank(required) {
		return apperror.New(
			http.StatusForbidden,
			"attendance_assurance_required",
			"This attendance action requires a stronger authentication method",
		)
	}
	return nil
}

func (s *Service) kiosk(
	ctx context.Context,
	device manageddevices.DeviceContext,
) (attendancedb.GetTerminalDeviceRow, error) {
	row, err := attendancedb.New(s.pool).GetTerminalDevice(ctx, device.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return row, apperror.NotFound
	}
	return row, err
}

func (s *Service) KioskContext(ctx context.Context, device manageddevices.DeviceContext) (KioskContext, error) {
	row, err := s.kiosk(ctx, device)
	if err != nil {
		return KioskContext{}, err
	}
	capabilities, err := attendancedb.New(s.pool).ListTerminalCapabilities(ctx, device.ID)
	if err != nil {
		return KioskContext{}, err
	}
	methods := []string{"password", "pin"}
	return KioskContext{DeviceID: row.ID, DeviceName: row.Name, CheckoutMode: manageddevices.CheckoutMode(row.CheckoutMode),
		CheckInAssurance: authorization.Assurance(row.CheckInAssurance), CheckOutAssurance: authorization.Assurance(row.CheckOutAssurance),
		AuthenticationMethods: methods, Capabilities: capabilities}, nil
}

// PublicPresence lists who is here and whose check-in is held, both with first name and last initial only.
func (s *Service) PublicPresence(
	ctx context.Context,
	device manageddevices.DeviceContext,
) ([]PublicPresence, []PublicWaiting, error) {
	if _, err := s.kiosk(ctx, device); err != nil {
		return nil, nil, err
	}
	q := attendancedb.New(s.pool)
	rows, err := q.ListPublicPresence(ctx)
	if err != nil {
		return nil, nil, err
	}
	result := make([]PublicPresence, 0, len(rows))
	shortName := shortNamer()
	for _, row := range rows {
		result = append(result, PublicPresence{
			VisitID:     row.ID,
			DisplayName: shortName(row.FirstName, row.LastInitial),
			CheckedInAt: row.CheckedInAt,
		})
	}
	holds, err := q.ListPublicHolds(ctx)
	if err != nil {
		return nil, nil, err
	}
	waiting := make([]PublicWaiting, 0, len(holds))
	shortName = shortNamer()
	for _, row := range holds {
		waiting = append(waiting, PublicWaiting{
			HoldID:      row.ID,
			DisplayName: shortName(row.FirstName, row.LastInitial),
			RequestedAt: row.RequestedAt,
		})
	}
	return result, waiting, nil
}

// shortNamer numbers repeated "First L." names so people with the same short name stay distinguishable.
func shortNamer() func(firstName, lastInitial string) string {
	duplicates := map[string]int{}
	return func(firstName, lastInitial string) string {
		name := firstName + " " + lastInitial + "."
		duplicates[name]++
		if duplicates[name] > 1 {
			name = fmt.Sprintf("%s (%d)", name, duplicates[name])
		}
		return name
	}
}

func (s *Service) PasswordCheckIn(
	ctx context.Context,
	device manageddevices.DeviceContext,
	email, password, source string,
	requestID *uuid.UUID,
) (CheckInResult, error) {
	verified, err := s.auth.VerifyPasswordForAttendance(ctx, email, password, source)
	if err != nil {
		return CheckInResult{}, err
	}
	return s.checkIn(ctx, device, verified, requestID)
}

func (s *Service) PINCheckIn(
	ctx context.Context,
	device manageddevices.DeviceContext,
	login, pin, source string,
	requestID *uuid.UUID,
) (CheckInResult, error) {
	verified, err := s.auth.VerifyPINForAttendance(ctx, login, pin, source)
	if err != nil {
		return CheckInResult{}, err
	}
	return s.checkIn(ctx, device, verified, requestID)
}

func (s *Service) checkIn(
	ctx context.Context,
	device manageddevices.DeviceContext,
	verified auth.VerifiedIdentity,
	requestID *uuid.UUID,
) (CheckInResult, error) {
	kiosk, err := s.kiosk(ctx, device)
	if err != nil {
		return CheckInResult{}, err
	}
	if err = requireAssurance(verified.Assurance, authorization.Assurance(kiosk.CheckInAssurance)); err != nil {
		return CheckInResult{}, err
	}
	status, err := s.labRules.Evaluate(ctx, verified.PersonID)
	if err != nil {
		return CheckInResult{}, err
	}
	if status.Mode != laborordnung.ModeNotRequired && status.State == laborordnung.StateNoPublishedVersion {
		return CheckInResult{}, apperror.New(
			http.StatusConflict,
			"lab_rules_unavailable",
			"Required Lab Rules are not currently available",
		)
	}
	if status.ActionRequired {
		principal := authorization.Principal{
			AccountID: verified.AccountID,
			PersonID:  verified.PersonID,
			Assurance: verified.Assurance,
		}
		if _, _, err = s.labRules.RequestOwnConfirmation(ctx, principal, requestID); err != nil {
			return CheckInResult{}, err
		}
	}
	// Roles that block admission get a held check-in that a supervisor completes by confirming the Lab Rules.
	held := status.ActionRequired && status.Mode == laborordnung.ModeBlocking
	decision := AdmissionAdmitted
	if status.ActionRequired {
		decision = AdmissionWarning
	}
	var versionID *uuid.UUID
	if status.CurrentVersion != nil {
		versionID = &status.CurrentVersion.ID
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CheckInResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := attendancedb.New(tx)
	if _, err = q.LockEnabledAttendanceAccount(
		ctx,
		attendancedb.LockEnabledAttendanceAccountParams{AccountID: verified.AccountID, PersonID: verified.PersonID},
	); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return CheckInResult{}, apperror.Unauthenticated
	} else if err != nil {
		return CheckInResult{}, err
	}
	if _, err = q.LockPerson(ctx, verified.PersonID); errors.Is(err, pgx.ErrNoRows) {
		return CheckInResult{}, apperror.NotFound
	} else if err != nil {
		return CheckInResult{}, err
	}
	if _, err = q.GetOpenVisitForPerson(ctx, verified.PersonID); err == nil {
		return CheckInResult{}, apperror.New(http.StatusConflict, "already_checked_in", "This person is already checked in")
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return CheckInResult{}, err
	}
	accountID := verified.AccountID
	if held {
		hold, err := s.createHold(ctx, tx, holdInput{
			PersonID:  verified.PersonID,
			DeviceID:  &device.ID,
			Method:    verified.Method,
			Assurance: string(verified.Assurance),
			ByAccount: &accountID,
			ActorID:   &accountID,
			RequestID: requestID,
		})
		if err != nil {
			return CheckInResult{}, err
		}
		if err = tx.Commit(ctx); err != nil {
			return CheckInResult{}, err
		}
		return CheckInResult{Hold: &hold}, nil
	}
	row, err := q.CreateVisit(
		ctx,
		attendancedb.CreateVisitParams{ID: ids.New(), PersonID: verified.PersonID,
			CheckInDeviceID: &device.ID, CheckInMethod: verified.Method, CheckInAssurance: string(verified.Assurance),
			AdmissionDecision: string(decision), LaborordnungVersionID: versionID, CheckedInByAccountID: &accountID},
	)
	if err != nil {
		return CheckInResult{}, databaseError(err)
	}
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &accountID,
			Action:         "visit.checked_in",
			ResourceType:   "visit",
			ResourceID:     &row.ID,
			RequestID:      requestID,
		},
	); err != nil {
		return CheckInResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return CheckInResult{}, err
	}
	visit := visitFromCreate(row)
	return CheckInResult{Visit: &visit}, nil
}

func (s *Service) PasswordCheckOut(
	ctx context.Context,
	device manageddevices.DeviceContext,
	email, password, source string,
	requestID *uuid.UUID,
) (Visit, error) {
	verified, err := s.auth.VerifyPasswordForAttendance(ctx, email, password, source)
	if err != nil {
		return Visit{}, err
	}
	return s.verifiedCheckOut(ctx, device, verified, requestID)
}

func (s *Service) PINCheckOut(
	ctx context.Context,
	device manageddevices.DeviceContext,
	login, pin, source string,
	requestID *uuid.UUID,
) (Visit, error) {
	verified, err := s.auth.VerifyPINForAttendance(ctx, login, pin, source)
	if err != nil {
		return Visit{}, err
	}
	return s.verifiedCheckOut(ctx, device, verified, requestID)
}

func (s *Service) verifiedCheckOut(
	ctx context.Context,
	device manageddevices.DeviceContext,
	verified auth.VerifiedIdentity,
	requestID *uuid.UUID,
) (Visit, error) {
	kiosk, err := s.kiosk(ctx, device)
	if err != nil {
		return Visit{}, err
	}
	if err = requireAssurance(verified.Assurance, authorization.Assurance(kiosk.CheckOutAssurance)); err != nil {
		return Visit{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Visit{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := attendancedb.New(tx)
	current, err := q.GetOpenVisitForPerson(ctx, verified.PersonID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Visit{}, apperror.New(http.StatusConflict, "not_checked_in", "This person is not checked in")
	}
	if err != nil {
		return Visit{}, err
	}
	method, assurance, accountID := verified.Method, string(verified.Assurance), verified.AccountID
	row, err := q.CheckOutVisit(ctx, attendancedb.CheckOutVisitParams{VisitID: current.ID, CheckOutDeviceID: &device.ID,
		CheckOutMethod: &method, CheckOutAssurance: &assurance, CheckedOutByAccountID: &accountID})
	if err != nil {
		return Visit{}, databaseError(err)
	}
	if s.surveys != nil {
		if err = s.surveys.CreatePostVisitInvitations(ctx, tx, row.PersonID, row.ID); err != nil {
			return Visit{}, err
		}
	}
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &accountID,
			Action:         "visit.checked_out",
			ResourceType:   "visit",
			ResourceID:     &row.ID,
			RequestID:      requestID,
		},
	); err != nil {
		return Visit{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Visit{}, err
	}
	return visitFromCheckout(row), nil
}

func (s *Service) PublicCheckOut(
	ctx context.Context,
	device manageddevices.DeviceContext,
	visitID uuid.UUID,
	requestID *uuid.UUID,
) (Visit, error) {
	kiosk, err := s.kiosk(ctx, device)
	if err != nil {
		return Visit{}, err
	}
	if manageddevices.CheckoutMode(kiosk.CheckoutMode) != manageddevices.CheckoutPublicTap {
		return Visit{}, apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Visit{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := attendancedb.New(tx)
	if _, err = q.GetOpenVisitByID(ctx, visitID); errors.Is(err, pgx.ErrNoRows) {
		return Visit{}, apperror.NotFound
	} else if err != nil {
		return Visit{}, err
	}
	method := "public_tap"
	row, err := q.CheckOutVisit(
		ctx,
		attendancedb.CheckOutVisitParams{VisitID: visitID, CheckOutDeviceID: &device.ID, CheckOutMethod: &method},
	)
	if err != nil {
		return Visit{}, databaseError(err)
	}
	if s.surveys != nil {
		if err = s.surveys.CreatePostVisitInvitations(ctx, tx, row.PersonID, row.ID); err != nil {
			return Visit{}, err
		}
	}
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{Action: "visit.public_checkout", ResourceType: "visit", ResourceID: &row.ID, RequestID: requestID},
	); err != nil {
		return Visit{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Visit{}, err
	}
	return visitFromCheckout(row), nil
}

func (s *Service) SupervisedCheckIn(
	ctx context.Context,
	principal authorization.Principal,
	personID uuid.UUID,
	requestID *uuid.UUID,
) (CheckInResult, error) {
	if !principal.Has(authorization.AttendanceAssist) {
		return CheckInResult{}, apperror.PermissionDenied
	}
	status, err := s.labRules.Evaluate(ctx, personID)
	if err != nil {
		return CheckInResult{}, err
	}
	if status.Mode != laborordnung.ModeNotRequired && status.State == laborordnung.StateNoPublishedVersion {
		return CheckInResult{}, apperror.New(
			http.StatusConflict,
			"lab_rules_unavailable",
			"Required Lab Rules are not currently available",
		)
	}
	if status.ActionRequired {
		requestPrincipal := principal
		requestPrincipal.PersonID = personID
		if _, _, err = s.labRules.RequestOwnConfirmation(ctx, requestPrincipal, requestID); err != nil {
			return CheckInResult{}, err
		}
	}
	// Roles that block admission get a held check-in that a supervisor completes by confirming the Lab Rules.
	held := status.ActionRequired && status.Mode == laborordnung.ModeBlocking
	decision := AdmissionAdmitted
	if status.ActionRequired {
		decision = AdmissionWarning
	}
	var versionID *uuid.UUID
	if status.CurrentVersion != nil {
		versionID = &status.CurrentVersion.ID
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CheckInResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := attendancedb.New(tx)
	if _, err = q.LockPerson(ctx, personID); errors.Is(err, pgx.ErrNoRows) {
		return CheckInResult{}, apperror.NotFound
	} else if err != nil {
		return CheckInResult{}, err
	}
	if _, err = q.GetOpenVisitForPerson(ctx, personID); err == nil {
		return CheckInResult{}, apperror.New(http.StatusConflict, "already_checked_in", "This person is already checked in")
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return CheckInResult{}, err
	}
	accountID := principal.AccountID
	if held {
		hold, err := s.createHold(ctx, tx, holdInput{
			PersonID:  personID,
			Method:    "supervisor",
			Assurance: string(principal.Assurance),
			ByAccount: &accountID,
			ActorID:   &accountID,
			RequestID: requestID,
		})
		if err != nil {
			return CheckInResult{}, err
		}
		if err = tx.Commit(ctx); err != nil {
			return CheckInResult{}, err
		}
		return CheckInResult{Hold: &hold}, nil
	}
	row, err := q.CreateVisit(
		ctx,
		attendancedb.CreateVisitParams{
			ID:                    ids.New(),
			PersonID:              personID,
			CheckInMethod:         "supervisor",
			CheckInAssurance:      string(principal.Assurance),
			AdmissionDecision:     string(decision),
			LaborordnungVersionID: versionID,
			CheckedInByAccountID:  &accountID,
		},
	)
	if err != nil {
		return CheckInResult{}, databaseError(err)
	}
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &accountID,
			Action:         "visit.supervised_check_in",
			ResourceType:   "visit",
			ResourceID:     &row.ID,
			RequestID:      requestID,
		},
	); err != nil {
		return CheckInResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return CheckInResult{}, err
	}
	visit := visitFromCreate(row)
	return CheckInResult{Visit: &visit}, nil
}

func (s *Service) SupervisedCheckOut(
	ctx context.Context,
	principal authorization.Principal,
	visitID uuid.UUID,
	requestID *uuid.UUID,
) (Visit, error) {
	if !principal.Has(authorization.AttendanceAssist) {
		return Visit{}, apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Visit{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := attendancedb.New(tx)
	if _, err = q.GetOpenVisitByID(ctx, visitID); errors.Is(err, pgx.ErrNoRows) {
		return Visit{}, apperror.NotFound
	} else if err != nil {
		return Visit{}, err
	}
	method, assurance, accountID := "supervisor", string(principal.Assurance), principal.AccountID
	row, err := q.CheckOutVisit(
		ctx,
		attendancedb.CheckOutVisitParams{
			VisitID:               visitID,
			CheckOutMethod:        &method,
			CheckOutAssurance:     &assurance,
			CheckedOutByAccountID: &accountID,
		},
	)
	if err != nil {
		return Visit{}, databaseError(err)
	}
	if s.surveys != nil {
		if err = s.surveys.CreatePostVisitInvitations(ctx, tx, row.PersonID, row.ID); err != nil {
			return Visit{}, err
		}
	}
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &accountID,
			Action:         "visit.supervised_check_out",
			ResourceType:   "visit",
			ResourceID:     &row.ID,
			RequestID:      requestID,
		},
	); err != nil {
		return Visit{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Visit{}, err
	}
	return visitFromCheckout(row), nil
}

func (s *Service) Void(
	ctx context.Context,
	principal authorization.Principal,
	visitID uuid.UUID,
	expectedVersion int64,
	reason string,
	requestID *uuid.UUID,
) (Visit, error) {
	if !principal.Has(authorization.AttendanceCorrect) {
		return Visit{}, apperror.PermissionDenied
	}
	reason = strings.TrimSpace(reason)
	if expectedVersion < 1 || reason == "" || len([]rune(reason)) > 500 {
		return Visit{}, apperror.InvalidField(
			"expectedVersion must be positive and reason is required with at most 500 characters",
		)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Visit{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := attendancedb.New(tx)
	current, err := q.GetVisitByIDForUpdate(ctx, visitID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Visit{}, apperror.NotFound
	} else if err != nil {
		return Visit{}, err
	}
	if current.Version != expectedVersion {
		return Visit{}, apperror.StaleWrite
	}
	if VisitStatus(current.Status) == VisitVoided {
		return Visit{}, apperror.New(
			http.StatusConflict,
			"visit_already_voided",
			"The attendance record is already voided",
		)
	}
	row, err := q.VoidVisit(
		ctx,
		attendancedb.VoidVisitParams{VisitID: visitID, ExpectedVersion: expectedVersion, CorrectionReason: &reason},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Visit{}, apperror.StaleWrite
	} else if err != nil {
		return Visit{}, databaseError(err)
	}
	if s.surveys != nil {
		if err = s.surveys.CancelPostVisitInvitations(ctx, tx, visitID); err != nil {
			return Visit{}, err
		}
	}
	actor := principal.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "visit.voided",
			ResourceType:   "visit",
			ResourceID:     &row.ID,
			RequestID:      requestID,
			ChangedFields:  []string{"status", "correctionReason"},
		},
	); err != nil {
		return Visit{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Visit{}, err
	}
	return visitFromVoid(row), nil
}

func (s *Service) List(
	ctx context.Context,
	principal authorization.Principal,
	currentlyHere bool,
	from, to *time.Time,
) ([]Visit, error) {
	if !principal.Has(authorization.AttendanceRead) {
		return nil, apperror.PermissionDenied
	}
	rows, err := attendancedb.New(s.pool).
		ListVisits(
			ctx,
			attendancedb.ListVisitsParams{
				CurrentlyHere: currentlyHere,
				FromTime:      nullableTime(from),
				ToTime:        nullableTime(to),
			},
		)
	if err != nil {
		return nil, err
	}
	result := make([]Visit, 0, len(rows))
	for _, row := range rows {
		result = append(result, visitFromList(row))
	}
	return result, nil
}

func (s *Service) Statistics(
	ctx context.Context,
	principal authorization.Principal,
	from, to time.Time,
) (Statistics, error) {
	if !principal.Has(authorization.AttendanceStatisticsRead) {
		return Statistics{}, apperror.PermissionDenied
	}
	if from.IsZero() || to.IsZero() || !to.After(from) || to.Sub(from) > 90*24*time.Hour {
		return Statistics{}, apperror.InvalidField("from and to must define a period of at most 90 days")
	}
	row, err := attendancedb.New(s.pool).
		AttendanceStatistics(ctx, attendancedb.AttendanceStatisticsParams{FromTime: from.UTC(), ToTime: to.UTC()})
	if err != nil {
		return Statistics{}, err
	}
	return Statistics{
		From:           from.UTC(),
		To:             to.UTC(),
		VisitorCount:   row.VisitorCount,
		UniqueVisitors: row.UniqueVisitors,
		VisitorHours: numericString(
			row.VisitorHours,
		),
		PeakOccupancy:                row.PeakOccupancy,
		CurrentOccupancy:             row.CurrentOccupancy,
		AverageCompletedVisitMinutes: numericString(row.AverageCompletedVisitMinutes),
	}, nil
}

func visitFromCreate(row attendancedb.CreateVisitRow) Visit {
	return Visit{
		ID:                row.ID,
		PersonID:          row.PersonID,
		DisplayName:       row.FirstName + " " + row.LastName,
		CheckedInAt:       row.CheckedInAt,
		CheckedOutAt:      timePtr(row.CheckedOutAt),
		Status:            VisitStatus(row.Status),
		CheckInMethod:     row.CheckInMethod,
		CheckOutMethod:    row.CheckOutMethod,
		AdmissionDecision: AdmissionDecision(row.AdmissionDecision),
		CorrectionReason:  row.CorrectionReason,
		Version:           row.Version,
	}
}
func visitFromCheckout(row attendancedb.CheckOutVisitRow) Visit {
	return Visit{
		ID:                row.ID,
		PersonID:          row.PersonID,
		DisplayName:       row.FirstName + " " + row.LastName,
		CheckedInAt:       row.CheckedInAt,
		CheckedOutAt:      timePtr(row.CheckedOutAt),
		Status:            VisitStatus(row.Status),
		CheckInMethod:     row.CheckInMethod,
		CheckOutMethod:    row.CheckOutMethod,
		AdmissionDecision: AdmissionDecision(row.AdmissionDecision),
		CorrectionReason:  row.CorrectionReason,
		Version:           row.Version,
	}
}
func visitFromVoid(row attendancedb.VoidVisitRow) Visit {
	return Visit{
		ID:                row.ID,
		PersonID:          row.PersonID,
		DisplayName:       row.FirstName + " " + row.LastName,
		CheckedInAt:       row.CheckedInAt,
		CheckedOutAt:      timePtr(row.CheckedOutAt),
		Status:            VisitStatus(row.Status),
		CheckInMethod:     row.CheckInMethod,
		CheckOutMethod:    row.CheckOutMethod,
		AdmissionDecision: AdmissionDecision(row.AdmissionDecision),
		CorrectionReason:  row.CorrectionReason,
		Version:           row.Version,
	}
}
func visitFromList(row attendancedb.ListVisitsRow) Visit {
	return Visit{
		ID:                row.ID,
		PersonID:          row.PersonID,
		DisplayName:       row.FirstName + " " + row.LastName,
		CheckedInAt:       row.CheckedInAt,
		CheckedOutAt:      timePtr(row.CheckedOutAt),
		Status:            VisitStatus(row.Status),
		CheckInMethod:     row.CheckInMethod,
		CheckOutMethod:    row.CheckOutMethod,
		AdmissionDecision: AdmissionDecision(row.AdmissionDecision),
		CorrectionReason:  row.CorrectionReason,
		Version:           row.Version,
	}
}
func timePtr(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	v := value.Time.UTC()
	return &v
}
func nullableTime(value *time.Time) pgtype.Timestamptz {
	if value == nil {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: value.UTC(), Valid: true}
}
func numericString(value pgtype.Numeric) string {
	if !value.Valid {
		return "0"
	}
	d, err := decimal.NewFromString(value.Int.String())
	if err != nil {
		return "0"
	}
	return d.Shift(value.Exp).String()
}
func databaseError(err error) error { return err }
