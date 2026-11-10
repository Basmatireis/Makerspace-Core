package attendance

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/surveys"

	attendancedb "github.com/Basmatireis/Makerspace-Core/backend/internal/attendance/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
)

type CredentialVerifier interface {
	VerifyPasswordForAttendance(context.Context, string, string, string) (auth.VerifiedIdentity, error)
	VerifyPINForAttendance(context.Context, string, string, string) (auth.VerifiedIdentity, error)
	VerifyEmailCodeForAttendance(context.Context, string, string, string) (auth.VerifiedIdentity, error)
	RequestCheckInEmailCode(ctx context.Context, email, sourceKey string, requestID *uuid.UUID) error
	// ConsumeVerifiedTx uses up a one-time proof (an emailed code) inside the attendance transaction, so it is spent
	// exactly when the check-in or check-out commits.
	ConsumeVerifiedTx(ctx context.Context, tx pgx.Tx, verified auth.VerifiedIdentity) error
}

type LabRules interface {
	Evaluate(context.Context, uuid.UUID) (laborordnung.Status, error)
	ConfirmTx(
		ctx context.Context,
		tx pgx.Tx,
		personID, versionID uuid.UUID,
		method laborordnung.ConfirmationMethod,
		actorAccountID *uuid.UUID,
		requestID *uuid.UUID,
	) error
}
type PostVisitSurveyTrigger interface {
	CreatePostVisitInvitations(context.Context, pgx.Tx, uuid.UUID, uuid.UUID) error
	// OfferAtCheckOut may offer a survey on the tablet after a self check-out; it returns nil when nothing is offered.
	OfferAtCheckOut(ctx context.Context, tx pgx.Tx, personID, visitID, deviceID uuid.UUID) (*surveys.Offer, error)
	// OfferAfterTapCheckOut may offer a survey on the tablet after a tap check-out; the offer names nobody.
	OfferAfterTapCheckOut(ctx context.Context, tx pgx.Tx, personID, checkOutRef, deviceID uuid.UUID) (*surveys.Offer, error)
}

type Service struct {
	pool     *pgxpool.Pool
	auth     CredentialVerifier
	labRules LabRules
	surveys  PostVisitSurveyTrigger
	notices  NotificationEmitter
}

// NotificationEmitter is the part of the notification event source this package uses. It writes inside the caller's
// transaction, so the notification commits with the visit.
type NotificationEmitter interface {
	CheckIn(ctx context.Context, tx pgx.Tx, visitID uuid.UUID) error
	CheckOut(ctx context.Context, tx pgx.Tx, visitID uuid.UUID) error
}

// WithNotifications makes check-ins and check-outs raise the notification triggers. Without it nothing is raised.
func (s *Service) WithNotifications(notices NotificationEmitter) *Service {
	s.notices = notices
	return s
}

func (s *Service) notifyCheckIn(ctx context.Context, tx pgx.Tx, visitID uuid.UUID) error {
	if s.notices == nil {
		return nil
	}
	return s.notices.CheckIn(ctx, tx, visitID)
}

func (s *Service) notifyCheckOut(ctx context.Context, tx pgx.Tx, visitID uuid.UUID) error {
	if s.notices == nil {
		return nil
	}
	return s.notices.CheckOut(ctx, tx, visitID)
}

// afterCheckIn records the new occupancy as a candidate for today's peak and raises the check-in trigger.
func (s *Service) afterCheckIn(ctx context.Context, tx pgx.Tx, visitID uuid.UUID) error {
	if err := attendancedb.New(tx).RecordPeakOccupancy(ctx); err != nil {
		return err
	}
	return s.notifyCheckIn(ctx, tx, visitID)
}

// checkOut closes an open visit. The occupancy just before it leaves is a candidate for today's peak.
func checkOut(
	ctx context.Context,
	q *attendancedb.Queries,
	params attendancedb.CheckOutVisitParams,
) (attendancedb.CheckOutVisitRow, error) {
	if err := q.RecordPeakOccupancy(ctx); err != nil {
		return attendancedb.CheckOutVisitRow{}, err
	}
	row, err := q.CheckOutVisit(ctx, params)
	if err != nil {
		return attendancedb.CheckOutVisitRow{}, databaseError(err)
	}
	return row, nil
}

// archive raises the check-out trigger while the visit still exists, then rolls it into the daily statistics, records
// the person's last visit date and deletes it, all in the check-out's transaction. After this nothing about the
// visit is linked to the person any more.
func (s *Service) archive(ctx context.Context, tx pgx.Tx, visitID uuid.UUID) error {
	if err := s.notifyCheckOut(ctx, tx, visitID); err != nil {
		return err
	}
	archived, err := attendancedb.New(tx).ArchiveCheckedOutVisit(ctx, visitID)
	if err != nil {
		return err
	}
	if archived != 1 {
		return fmt.Errorf("archive visit %s: %d rows", visitID, archived)
	}
	return nil
}

func NewService(
	pool *pgxpool.Pool,
	verifier CredentialVerifier,
	labRules LabRules,
	surveys PostVisitSurveyTrigger,
) *Service {
	return &Service{pool: pool, auth: verifier, labRules: labRules, surveys: surveys}
}

// LabRulesChoice is what the person decided about the current Lab Rules on the terminal before checking in.
type LabRulesChoice struct {
	// ConfirmVersionID is the version the person read and confirms; it must be the current one.
	ConfirmVersionID *uuid.UUID
	// Defer checks in without confirming; only roles that merely warn allow it.
	Defer bool
}

var (
	errLabRulesConfirmationRequired = apperror.New(
		http.StatusConflict,
		"lab_rules_confirmation_required",
		"The current Lab Rules must be confirmed before checking in",
	)
	errLabRulesConfirmationSuggested = apperror.New(
		http.StatusConflict,
		"lab_rules_confirmation_suggested",
		"The current Lab Rules are not confirmed yet; they can be confirmed now or later",
	)
	errMethodNotAllowed = apperror.New(
		http.StatusForbidden,
		"attendance_method_not_allowed",
		"This kiosk does not accept this way of checking in or out",
	)
	errLabRulesUnavailable = apperror.New(
		http.StatusConflict,
		"lab_rules_unavailable",
		"Required Lab Rules are not currently available",
	)
)

type KioskContext struct {
	DeviceID                        uuid.UUID
	DeviceName                      string
	AllowTapCheckout                bool
	OfferSurveysAtCheckout          bool
	KioskResetSeconds               int32
	CheckInMethods, CheckOutMethods []manageddevices.KioskMethod
	Capabilities                    []string
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
	// SurveyOffer is only set on the answer of a tablet check-out (self or tap) that offers a survey.
	SurveyOffer *surveys.Offer
}

type Statistics struct {
	From, To                                                      time.Time
	VisitorCount, UniqueVisitors, PeakOccupancy, CurrentOccupancy int64
	VisitorHours, AverageCompletedVisitMinutes                    string
}

// kioskFor loads the kiosk and refuses a method it does not accept for the action. It runs before any credential is
// checked, so a method the kiosk refuses cannot be used to test passwords, PINs or codes there.
func (s *Service) kioskFor(
	ctx context.Context,
	device manageddevices.DeviceContext,
	action attendanceAction,
	method manageddevices.KioskMethod,
) (attendancedb.GetTerminalDeviceRow, error) {
	row, err := s.kiosk(ctx, device)
	if err != nil {
		return row, err
	}
	return row, requireKioskMethod(row, action, string(method))
}

// attendanceAction is the direction of a kiosk attendance step.
type attendanceAction string

const (
	actionCheckIn  attendanceAction = "check_in"
	actionCheckOut attendanceAction = "check_out"
)

func requireKioskMethod(row attendancedb.GetTerminalDeviceRow, action attendanceAction, method string) error {
	accepted := row.CheckInMethods
	if action == actionCheckOut {
		accepted = row.CheckOutMethods
	}
	if !slices.Contains(accepted, method) {
		return errMethodNotAllowed
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
	if errors.Is(err, apperror.NotFound) {
		// A registered device that is not a kiosk must not look unregistered: the kiosk page would offer to pair it
		// again and replace its credential.
		return KioskContext{}, apperror.New(
			http.StatusForbidden,
			"device_not_kiosk",
			"This managed device is not configured as an entrance kiosk",
		)
	}
	if err != nil {
		return KioskContext{}, err
	}
	capabilities, err := manageddevices.NewService(s.pool).EffectiveCapabilities(ctx, device.ID)
	if err != nil {
		return KioskContext{}, err
	}
	return KioskContext{DeviceID: row.ID, DeviceName: row.Name, AllowTapCheckout: row.AllowTapCheckout,
		OfferSurveysAtCheckout: row.OfferSurveysAtCheckout, KioskResetSeconds: row.KioskResetSeconds,
		CheckInMethods:  optional.ConvertSlice[manageddevices.KioskMethod](row.CheckInMethods),
		CheckOutMethods: optional.ConvertSlice[manageddevices.KioskMethod](row.CheckOutMethods),
		Capabilities:    capabilities}, nil
}

// PublicPresence lists who is here with first name and last initial only.
func (s *Service) PublicPresence(ctx context.Context, device manageddevices.DeviceContext) ([]PublicPresence, error) {
	if _, err := s.kiosk(ctx, device); err != nil {
		return nil, err
	}
	rows, err := attendancedb.New(s.pool).ListPublicPresence(ctx)
	if err != nil {
		return nil, err
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
	return result, nil
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
	choice LabRulesChoice,
	requestID *uuid.UUID,
) (Visit, error) {
	if _, err := s.kioskFor(ctx, device, actionCheckIn, manageddevices.KioskMethodPassword); err != nil {
		return Visit{}, err
	}
	verified, err := s.auth.VerifyPasswordForAttendance(ctx, email, password, source)
	if err != nil {
		return Visit{}, err
	}
	return s.checkIn(ctx, device, verified, choice, requestID)
}

func (s *Service) PINCheckIn(
	ctx context.Context,
	device manageddevices.DeviceContext,
	login, pin, source string,
	choice LabRulesChoice,
	requestID *uuid.UUID,
) (Visit, error) {
	if _, err := s.kioskFor(ctx, device, actionCheckIn, manageddevices.KioskMethodPIN); err != nil {
		return Visit{}, err
	}
	verified, err := s.auth.VerifyPINForAttendance(ctx, login, pin, source)
	if err != nil {
		return Visit{}, err
	}
	return s.checkIn(ctx, device, verified, choice, requestID)
}

// RequestEmailCode mails a check-in code to an account that signs in with an emailed code; it works only at a kiosk,
// not for the web login. Like the web request it never tells whether the address belongs to one.
func (s *Service) RequestEmailCode(
	ctx context.Context,
	device manageddevices.DeviceContext,
	email, source string,
	requestID *uuid.UUID,
) error {
	row, err := s.kiosk(ctx, device)
	if err != nil {
		return err
	}
	if requireKioskMethod(row, actionCheckIn, string(manageddevices.KioskMethodEmailCode)) != nil &&
		requireKioskMethod(row, actionCheckOut, string(manageddevices.KioskMethodEmailCode)) != nil {
		return errMethodNotAllowed
	}
	return s.auth.RequestCheckInEmailCode(ctx, email, source, requestID)
}

// EmailCodeCheckIn checks in with an emailed code. The code stays valid until a check-in succeeds, so the kiosk can
// repeat the request after showing the Lab Rules.
func (s *Service) EmailCodeCheckIn(
	ctx context.Context,
	device manageddevices.DeviceContext,
	email, code, source string,
	choice LabRulesChoice,
	requestID *uuid.UUID,
) (Visit, error) {
	if _, err := s.kioskFor(ctx, device, actionCheckIn, manageddevices.KioskMethodEmailCode); err != nil {
		return Visit{}, err
	}
	verified, err := s.auth.VerifyEmailCodeForAttendance(ctx, email, code, source)
	if err != nil {
		return Visit{}, err
	}
	return s.checkIn(ctx, device, verified, choice, requestID)
}

// labRulesAdmission decides a terminal check-in against the person's Lab Rules status. It returns the admission
// decision and the version to confirm while checking in, if any. A person who must confirm and has neither confirmed
// nor (for roles that merely warn) deferred is refused, so the terminal can show the Lab Rules first.
func labRulesAdmission(status laborordnung.Status, choice LabRulesChoice) (AdmissionDecision, *uuid.UUID, error) {
	if status.Mode != laborordnung.ModeNotRequired && status.State == laborordnung.StateNoPublishedVersion {
		return "", nil, errLabRulesUnavailable
	}
	if !status.ActionRequired || status.CurrentVersion == nil {
		return AdmissionAdmitted, nil, nil
	}
	switch {
	case choice.ConfirmVersionID != nil:
		if *choice.ConfirmVersionID != status.CurrentVersion.ID {
			return "", nil, laborordnung.ErrVersionOutdated
		}
		return AdmissionAdmitted, choice.ConfirmVersionID, nil
	case choice.Defer && status.Mode == laborordnung.ModeWarning:
		return AdmissionWarning, nil, nil
	case status.Mode == laborordnung.ModeBlocking:
		return "", nil, errLabRulesConfirmationRequired
	default:
		return "", nil, errLabRulesConfirmationSuggested
	}
}

func (s *Service) checkIn(
	ctx context.Context,
	device manageddevices.DeviceContext,
	verified auth.VerifiedIdentity,
	choice LabRulesChoice,
	requestID *uuid.UUID,
) (Visit, error) {
	kiosk, err := s.kiosk(ctx, device)
	if err != nil {
		return Visit{}, err
	}
	if err = requireKioskMethod(kiosk, actionCheckIn, verified.Method); err != nil {
		return Visit{}, err
	}
	status, err := s.labRules.Evaluate(ctx, verified.PersonID)
	if err != nil {
		return Visit{}, err
	}
	decision, confirmVersionID, err := labRulesAdmission(status, choice)
	if err != nil {
		return Visit{}, err
	}
	var versionID *uuid.UUID
	if status.CurrentVersion != nil {
		versionID = &status.CurrentVersion.ID
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Visit{}, err
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
		return Visit{}, apperror.Unauthenticated
	} else if err != nil {
		return Visit{}, err
	}
	if _, err = q.LockPerson(ctx, verified.PersonID); errors.Is(err, pgx.ErrNoRows) {
		return Visit{}, apperror.NotFound
	} else if err != nil {
		return Visit{}, err
	}
	if _, err = q.GetOpenVisitForPerson(ctx, verified.PersonID); err == nil {
		return Visit{}, apperror.New(http.StatusConflict, "already_checked_in", "This person is already checked in")
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return Visit{}, err
	}
	accountID := verified.AccountID
	if confirmVersionID != nil {
		// The confirmation commits with the visit; ConfirmTx checks again under this transaction that the version is
		// still the current one.
		if err = s.labRules.ConfirmTx(
			ctx, tx, verified.PersonID, *confirmVersionID, laborordnung.MethodKiosk, &accountID, requestID,
		); err != nil {
			return Visit{}, err
		}
	}
	row, err := q.CreateVisit(
		ctx,
		attendancedb.CreateVisitParams{ID: ids.New(), PersonID: verified.PersonID,
			CheckInDeviceID: &device.ID, CheckInMethod: verified.Method, CheckInAssurance: string(verified.Assurance),
			AdmissionDecision: string(decision), LaborordnungVersionID: versionID, CheckedInByAccountID: &accountID},
	)
	if err != nil {
		return Visit{}, databaseError(err)
	}
	// Ordinary check-ins are not audited: the visit itself is the record while the person is here.
	if err = s.afterCheckIn(ctx, tx, row.ID); err != nil {
		return Visit{}, err
	}
	if err = s.auth.ConsumeVerifiedTx(ctx, tx, verified); err != nil {
		return Visit{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Visit{}, err
	}
	return visitFromCreate(row), nil
}

func (s *Service) PasswordCheckOut(
	ctx context.Context,
	device manageddevices.DeviceContext,
	email, password, source string,
	requestID *uuid.UUID,
) (Visit, error) {
	if _, err := s.kioskFor(ctx, device, actionCheckOut, manageddevices.KioskMethodPassword); err != nil {
		return Visit{}, err
	}
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
	if _, err := s.kioskFor(ctx, device, actionCheckOut, manageddevices.KioskMethodPIN); err != nil {
		return Visit{}, err
	}
	verified, err := s.auth.VerifyPINForAttendance(ctx, login, pin, source)
	if err != nil {
		return Visit{}, err
	}
	return s.verifiedCheckOut(ctx, device, verified, requestID)
}

func (s *Service) EmailCodeCheckOut(
	ctx context.Context,
	device manageddevices.DeviceContext,
	email, code, source string,
	requestID *uuid.UUID,
) (Visit, error) {
	if _, err := s.kioskFor(ctx, device, actionCheckOut, manageddevices.KioskMethodEmailCode); err != nil {
		return Visit{}, err
	}
	verified, err := s.auth.VerifyEmailCodeForAttendance(ctx, email, code, source)
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
	if err = requireKioskMethod(kiosk, actionCheckOut, verified.Method); err != nil {
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
	row, err := checkOut(ctx, q, attendancedb.CheckOutVisitParams{VisitID: current.ID, CheckOutDeviceID: &device.ID,
		CheckOutMethod: &method, CheckOutAssurance: &assurance, CheckedOutByAccountID: &accountID})
	if err != nil {
		return Visit{}, err
	}
	// The invitation and the tablet offer of this check-out share a fresh reference instead of the visit ID, which
	// appears in URLs and logs and must not lead to the person once the visit is gone.
	checkOutRef := ids.New()
	if s.surveys != nil {
		if err = s.surveys.CreatePostVisitInvitations(ctx, tx, row.PersonID, checkOutRef); err != nil {
			return Visit{}, err
		}
	}
	var offer *surveys.Offer
	if s.surveys != nil && kiosk.OfferSurveysAtCheckout {
		if offer, err = s.surveys.OfferAtCheckOut(ctx, tx, row.PersonID, checkOutRef, device.ID); err != nil {
			return Visit{}, err
		}
	}
	if err = s.archive(ctx, tx, row.ID); err != nil {
		return Visit{}, err
	}
	if err = s.auth.ConsumeVerifiedTx(ctx, tx, verified); err != nil {
		return Visit{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Visit{}, err
	}
	visit := visitFromCheckout(row)
	visit.SurveyOffer = offer
	return visit, nil
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
	if !kiosk.AllowTapCheckout {
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
	row, err := checkOut(
		ctx,
		q,
		attendancedb.CheckOutVisitParams{VisitID: visitID, CheckOutDeviceID: &device.ID, CheckOutMethod: &method},
	)
	if err != nil {
		return Visit{}, err
	}
	// The invitation and the tablet offer of this check-out share a fresh reference instead of the visit ID, which
	// appears in URLs and logs and must not lead to the person once the visit is gone.
	checkOutRef := ids.New()
	if s.surveys != nil {
		if err = s.surveys.CreatePostVisitInvitations(ctx, tx, row.PersonID, checkOutRef); err != nil {
			return Visit{}, err
		}
	}
	// Anyone can tap any name, so the tablet's offer after a tap names nobody and its answers stay anonymous.
	var offer *surveys.Offer
	if s.surveys != nil && kiosk.OfferSurveysAtCheckout {
		if offer, err = s.surveys.OfferAfterTapCheckOut(ctx, tx, row.PersonID, checkOutRef, device.ID); err != nil {
			return Visit{}, err
		}
	}
	if err = s.archive(ctx, tx, row.ID); err != nil {
		return Visit{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Visit{}, err
	}
	visit := visitFromCheckout(row)
	visit.SurveyOffer = offer
	return visit, nil
}

func (s *Service) SupervisedCheckIn(
	ctx context.Context,
	principal authorization.Principal,
	personID uuid.UUID,
	requestID *uuid.UUID,
) (Visit, error) {
	if !principal.Has(authorization.AttendanceAssist) {
		return Visit{}, apperror.PermissionDenied
	}
	status, err := s.labRules.Evaluate(ctx, personID)
	if err != nil {
		return Visit{}, err
	}
	if status.Mode != laborordnung.ModeNotRequired && status.State == laborordnung.StateNoPublishedVersion {
		return Visit{}, errLabRulesUnavailable
	}
	// Only the person can confirm the Lab Rules (at the terminal or in the app); nobody checks them in past a role
	// that blocks admission.
	if status.ActionRequired && status.Mode == laborordnung.ModeBlocking {
		return Visit{}, errLabRulesConfirmationRequired
	}
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
		return Visit{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := attendancedb.New(tx)
	if _, err = q.LockPerson(ctx, personID); errors.Is(err, pgx.ErrNoRows) {
		return Visit{}, apperror.NotFound
	} else if err != nil {
		return Visit{}, err
	}
	if _, err = q.GetOpenVisitForPerson(ctx, personID); err == nil {
		return Visit{}, apperror.New(http.StatusConflict, "already_checked_in", "This person is already checked in")
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return Visit{}, err
	}
	accountID := principal.AccountID
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
		return Visit{}, databaseError(err)
	}
	if err = s.afterCheckIn(ctx, tx, row.ID); err != nil {
		return Visit{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Visit{}, err
	}
	return visitFromCreate(row), nil
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
	row, err := checkOut(
		ctx,
		q,
		attendancedb.CheckOutVisitParams{
			VisitID:               visitID,
			CheckOutMethod:        &method,
			CheckOutAssurance:     &assurance,
			CheckedOutByAccountID: &accountID,
		},
	)
	if err != nil {
		return Visit{}, err
	}
	// The invitation and the tablet offer of this check-out share a fresh reference instead of the visit ID, which
	// appears in URLs and logs and must not lead to the person once the visit is gone.
	checkOutRef := ids.New()
	if s.surveys != nil {
		if err = s.surveys.CreatePostVisitInvitations(ctx, tx, row.PersonID, checkOutRef); err != nil {
			return Visit{}, err
		}
	}
	// Someone checking out another person is a correction by the team: audited, but without the visit, which is
	// deleted below.
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &accountID,
			Action:         "visit.supervised_check_out",
			ResourceType:   "visit",
			RequestID:      requestID,
		},
	); err != nil {
		return Visit{}, err
	}
	if err = s.archive(ctx, tx, row.ID); err != nil {
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
	// Only open visits exist; voiding one deletes it, and neither the visit nor the reason is kept.
	if VisitStatus(current.Status) != VisitCheckedIn {
		return Visit{}, apperror.NotFound
	}
	row, err := q.VoidOpenVisit(
		ctx,
		attendancedb.VoidOpenVisitParams{VisitID: visitID, ExpectedVersion: expectedVersion},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Visit{}, apperror.StaleWrite
	} else if err != nil {
		return Visit{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "visit.voided",
			ResourceType:   "visit",
			RequestID:      requestID,
		},
	); err != nil {
		return Visit{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Visit{}, err
	}
	visit := visitFromVoid(row)
	visit.Status, visit.CorrectionReason = VisitVoided, &reason
	return visit, nil
}

// List returns the visits of the people who are in the lab right now; completed visits are not kept.
func (s *Service) List(ctx context.Context, principal authorization.Principal) ([]Visit, error) {
	if !principal.Has(authorization.AttendanceRead) {
		return nil, apperror.PermissionDenied
	}
	rows, err := attendancedb.New(s.pool).
		ListVisits(ctx)
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
func visitFromVoid(row attendancedb.VoidOpenVisitRow) Visit {
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

// consentWindow is how long after a tablet check-in the tablet may still store the person's consent answers.
const consentWindow = 10 * time.Minute

// ConsentTarget resolves who may answer consent categories on this tablet: the person of an open visit that was
// checked in at this tablet within the last ten minutes. Everything else is not found.
func (s *Service) ConsentTarget(
	ctx context.Context,
	device manageddevices.DeviceContext,
	visitID uuid.UUID,
) (personID, accountID uuid.UUID, err error) {
	if _, err = s.kiosk(ctx, device); err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	row, err := attendancedb.New(s.pool).GetOpenVisitCheckedInAtDevice(
		ctx, attendancedb.GetOpenVisitCheckedInAtDeviceParams{ID: visitID, DeviceID: &device.ID},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, uuid.Nil, apperror.NotFound
	}
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	if row.CheckedInByAccountID == nil || time.Since(row.CheckedInAt) > consentWindow {
		return uuid.Nil, uuid.Nil, apperror.NotFound
	}
	return row.PersonID, *row.CheckedInByAccountID, nil
}
