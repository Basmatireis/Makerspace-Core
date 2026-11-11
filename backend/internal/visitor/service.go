package visitor

import (
	"bytes"
	"context"
	"crypto/hmac"
	"errors"
	"io"
	"net/http"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/dates"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accounts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/attendance"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ratelimit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	visitordb "github.com/Basmatireis/Makerspace-Core/backend/internal/visitor/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const enrollmentTTL = 15 * time.Minute

// errLabRulesChanged tells the kiosk that the Lab Rules the visitor accepted are no longer the current version, so it
// must start over and show the new one.
var errLabRulesChanged = apperror.New(
	http.StatusConflict,
	"lab_rules_changed",
	"The Lab Rules changed while enrolling; read and accept the current version",
)

// EnrollmentNotifier mails the code that verifies a visitor's address.
type EnrollmentNotifier interface {
	SendEnrollmentEmailCode(context.Context, string, string, time.Time) error
}

type Configuration struct {
	Enabled       bool
	DeviceTypeIDs []uuid.UUID
	Version       int64
	UpdatedAt     time.Time
}

type ConfigurationInput struct {
	Enabled         bool
	DeviceTypeIDs   []uuid.UUID
	ExpectedVersion int64
}

type Context struct {
	ID              uuid.UUID
	ManagedDeviceID uuid.UUID
	CSRFTokenDigest []byte
	ExpiresAt       time.Time
	// Email and EmailVerified are the context's address under verification, as read when the request began.
	Email         string
	EmailVerified bool
}

type ContextIssue struct {
	ContextToken string
	CSRFToken    string
	ExpiresAt    time.Time
}

type LabRulesVersion struct {
	ID            uuid.UUID
	HumanRevision string
	PDFFileID     uuid.UUID
	EffectiveAt   time.Time
}

type EnrollmentState struct {
	// Email is the address the last verification code went to on this context; empty before one was sent.
	Email string
	// EmailVerified is whether that address was confirmed with its code.
	EmailVerified bool
	// Capabilities are the effective capabilities of the enrolling device.
	Capabilities    []string
	CurrentLabRules *LabRulesVersion
	// LabRulesRequired is whether the Visitor role asks for the Lab Rules; only then does Submit record a
	// confirmation, so only then does the kiosk show them.
	LabRulesRequired bool
	ExpiresAt        time.Time
}

// SubmissionInput is what the visitor enters besides the email address, which is the one verified on the context.
type SubmissionInput struct {
	FirstName string
	LastName  string
	// ProfileImage is required when the device can take or upload a photo and ignored otherwise.
	ProfileImage         []byte
	ProfileImageFilename string
	// LabRulesAccepted is the visitor's "I have read and accept the Lab Rules"; required when the role asks for them.
	LabRulesAccepted bool
	// Consents are the visitor's answers to the notification categories that need consent; may be empty.
	Consents []notifyrules.ConsentAnswer
}

type SubmissionResult struct {
	PersonID      uuid.UUID
	AccountID     uuid.UUID
	AccountStatus authorization.AccountStatus
	Admission     Admission
	// Attendance reports the check-in that completing enrollment implies.
	Attendance Attendance
}

// Attendance is the outcome of the check-in that completes enrollment.
type Attendance string

const AttendanceCheckedIn Attendance = "checked_in"

// EnrollmentConsents stores the visitor's notification consent answers inside the enrollment transaction.
type EnrollmentConsents interface {
	AnswerConsentsTx(
		ctx context.Context, tx pgx.Tx, p authorization.Principal, answers []notifyrules.ConsentAnswer,
		place notifyrules.ConsentPlace, deviceID *uuid.UUID, requestID *uuid.UUID,
	) error
}

// EnrollmentAttendance counts a finished enrollment as arriving, inside the enrollment transaction.
type EnrollmentAttendance interface {
	CheckInAtEnrollment(context.Context, pgx.Tx, attendance.EnrollmentCheckIn) error
}

type AdmissionResult struct {
	Decision Admission
	Status   laborordnung.Status
}

type Service struct {
	pool       *pgxpool.Pool
	config     config.Config
	files      *files.Service
	labRules   *laborordnung.Service
	notifier   EnrollmentNotifier
	attendance EnrollmentAttendance
	consents   EnrollmentConsents
	// emailSends bounds the verification mails one address receives across enrollment contexts.
	emailSends *ratelimit.Limiter
}

// SetAttendance wires the attendance module, which itself depends on services built after this one.
func (s *Service) SetAttendance(a EnrollmentAttendance) { s.attendance = a }

// SetConsents wires the notification rules module that stores the consent answers given while enrolling.
func (s *Service) SetConsents(c EnrollmentConsents) { s.consents = c }

func NewService(
	pool *pgxpool.Pool,
	cfg config.Config,
	fileService *files.Service,
	labRules *laborordnung.Service,
	notifier EnrollmentNotifier,
) *Service {
	return &Service{
		pool: pool, config: cfg, files: fileService, labRules: labRules, notifier: notifier,
		emailSends: ratelimit.New(EmailCodesPerContext, emailCodeRateWindow),
	}
}

func (s *Service) GetConfiguration(ctx context.Context, principal authorization.Principal) (Configuration, error) {
	if !principal.Has(authorization.VisitorEnrollmentManage) {
		return Configuration{}, apperror.PermissionDenied
	}
	return s.loadConfiguration(ctx, visitordb.New(s.pool))
}

func (s *Service) UpdateConfiguration(
	ctx context.Context,
	principal authorization.Principal,
	input ConfigurationInput,
	requestID *uuid.UUID,
) (Configuration, error) {
	if !principal.Has(authorization.VisitorEnrollmentManage) {
		return Configuration{}, apperror.PermissionDenied
	}
	var result Configuration
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.UpdateConfigurationTx(ctx, tx, principal, input, requestID)
		return err
	})
	return result, err
}

// UpdateConfigurationTx is UpdateConfiguration inside the caller's transaction; the configuration import uses it.
func (s *Service) UpdateConfigurationTx(
	ctx context.Context,
	tx pgx.Tx,
	principal authorization.Principal,
	input ConfigurationInput,
	requestID *uuid.UUID,
) (Configuration, error) {
	if !principal.Has(authorization.VisitorEnrollmentManage) {
		return Configuration{}, apperror.PermissionDenied
	}
	if input.ExpectedVersion < 1 || (input.Enabled && len(input.DeviceTypeIDs) == 0) {
		return Configuration{}, apperror.InvalidField("enabled enrollment requires at least one Device Type")
	}
	deviceTypes, err := uniqueUUIDs(input.DeviceTypeIDs)
	if err != nil {
		return Configuration{}, err
	}
	queries := visitordb.New(tx)
	// Enrollment hands out the Visitor membership, so enabling it needs the same privilege subset as assigning it.
	if input.Enabled {
		if err := authorizeVisitorRole(ctx, queries, principal); err != nil {
			return Configuration{}, err
		}
	}
	for _, typeID := range deviceTypes {
		exists, err := queries.DeviceTypeExists(ctx, typeID)
		if err != nil {
			return Configuration{}, err
		}
		if !exists {
			return Configuration{}, apperror.NotFound
		}
	}
	actor := principal.AccountID
	row, err := queries.UpdateConfiguration(
		ctx,
		visitordb.UpdateConfigurationParams{
			Enabled:            input.Enabled,
			UpdatedByAccountID: &actor,
			ExpectedVersion:    input.ExpectedVersion,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Configuration{}, apperror.StaleWrite
	}
	if err != nil {
		return Configuration{}, err
	}
	if err := queries.ClearAllowedDeviceTypes(ctx); err != nil {
		return Configuration{}, err
	}
	for _, typeID := range deviceTypes {
		if err := queries.AddAllowedDeviceType(ctx, typeID); err != nil {
			return Configuration{}, err
		}
	}
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "visitor_enrollment.configuration_updated",
			ResourceType:   "visitor_enrollment_configuration",
			RequestID:      requestID,
			ChangedFields:  []string{"enabled", "deviceTypeIds"},
		},
	); err != nil {
		return Configuration{}, err
	}
	return Configuration{
		Enabled:       row.Enabled,
		DeviceTypeIDs: deviceTypes,
		Version:       row.Version,
		UpdatedAt:     row.UpdatedAt,
	}, nil
}

func (s *Service) Begin(ctx context.Context, device manageddevices.DeviceContext) (ContextIssue, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ContextIssue{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := visitordb.New(tx)
	allowed, err := queries.IsDeviceTypeAllowed(ctx, device.ID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (allowed == nil || !*allowed)) {
		return ContextIssue{}, apperror.NotFound
	}
	if err != nil {
		return ContextIssue{}, err
	}
	raw, digest, err := security.NewOpaqueToken()
	if err != nil {
		return ContextIssue{}, err
	}
	csrf, csrfDigest, err := security.NewOpaqueToken()
	if err != nil {
		return ContextIssue{}, err
	}
	expiresAt := time.Now().UTC().Add(enrollmentTTL)
	id := ids.New()
	if _, err := queries.CreateEnrollmentContext(
		ctx,
		visitordb.CreateEnrollmentContextParams{
			ID:              id,
			ManagedDeviceID: device.ID,
			TokenDigest:     digest,
			CsrfDigest:      csrfDigest,
			ExpiresAt:       expiresAt,
		},
	); err != nil {
		return ContextIssue{}, err
	}
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			Action:       "visitor_enrollment.context_created",
			ResourceType: "visitor_enrollment_context",
			ResourceID:   &id,
		},
	); err != nil {
		return ContextIssue{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ContextIssue{}, err
	}
	return ContextIssue{ContextToken: raw, CSRFToken: csrf, ExpiresAt: expiresAt}, nil
}

func (s *Service) AuthenticateContext(ctx context.Context, raw string) (Context, error) {
	if strings.TrimSpace(raw) == "" {
		return Context{}, apperror.Unauthenticated
	}
	row, err := visitordb.New(s.pool).GetEnrollmentContext(ctx, security.DigestToken(raw))
	if errors.Is(err, pgx.ErrNoRows) {
		return Context{}, apperror.Unauthenticated
	}
	if err != nil {
		return Context{}, err
	}
	return Context{
		ID:              row.ID,
		ManagedDeviceID: row.ManagedDeviceID,
		CSRFTokenDigest: row.CsrfDigest,
		ExpiresAt:       row.ExpiresAt,
		Email:           optional.Value(row.EmailDisplay),
		EmailVerified:   row.EmailVerifiedAt.Valid,
	}, nil
}

func ValidateCSRF(context Context, cookie, header string) error {
	if cookie == "" || header == "" || cookie != header ||
		!hmac.Equal(context.CSRFTokenDigest, security.DigestToken(cookie)) {
		return apperror.New(http.StatusForbidden, "csrf_invalid", "CSRF validation failed")
	}
	return nil
}

func (s *Service) State(ctx context.Context, enrollment Context) (EnrollmentState, error) {
	queries := visitordb.New(s.pool)
	role, err := queries.GetVisitorRole(ctx)
	if err != nil {
		return EnrollmentState{}, err
	}
	version, err := s.pinnedLabRules(ctx, queries, enrollment.ID)
	if err != nil {
		return EnrollmentState{}, err
	}
	capabilities, err := manageddevices.NewService(s.pool).EffectiveCapabilities(ctx, enrollment.ManagedDeviceID)
	if err != nil {
		return EnrollmentState{}, err
	}
	return EnrollmentState{
		Email:            enrollment.Email,
		EmailVerified:    enrollment.EmailVerified,
		Capabilities:     capabilities,
		CurrentLabRules:  version,
		LabRulesRequired: laborordnung.Mode(role.LaborordnungMode) != laborordnung.ModeNotRequired,
		ExpiresAt:        enrollment.ExpiresAt,
	}, nil
}

func (s *Service) OpenLabRules(ctx context.Context, enrollment Context) (files.File, io.ReadCloser, error) {
	version, err := visitordb.New(s.pool).GetPinnedLabRulesVersion(ctx, enrollment.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return files.File{}, nil, apperror.NotFound
	}
	if err != nil {
		return files.File{}, nil, err
	}
	return s.files.Open(ctx, version.PdfFileID)
}

func (s *Service) Submit(
	ctx context.Context,
	enrollment Context,
	input SubmissionInput,
	requestID *uuid.UUID,
) (SubmissionResult, error) {
	capabilities, err := manageddevices.NewService(s.pool).EffectiveCapabilities(ctx, enrollment.ManagedDeviceID)
	if err != nil {
		return SubmissionResult{}, err
	}
	clean, imageBytes, err := validateSubmission(input, PhotoRequired(capabilities))
	if err != nil {
		return SubmissionResult{}, err
	}
	var storedImageID *uuid.UUID
	if len(imageBytes) > 0 {
		normalizedImage, err := people.NormalizeProfileImage(bytes.NewReader(imageBytes))
		if err != nil {
			return SubmissionResult{}, err
		}
		filename := strings.TrimSpace(input.ProfileImageFilename)
		if filename == "" {
			filename = "visitor-profile.jpg"
		}
		stored, err := s.files.StoreSystemBytes(ctx, filename, "image/jpeg", normalizedImage, requestID)
		if err != nil {
			return SubmissionResult{}, err
		}
		storedImageID = &stored.ID
	}
	linked := false
	defer func() {
		if !linked && storedImageID != nil {
			_ = s.files.DeleteSystem(context.Background(), *storedImageID, requestID)
		}
	}()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SubmissionResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := visitordb.New(tx)
	locked, err := queries.GetEnrollmentContextForUpdate(ctx, enrollment.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return SubmissionResult{}, apperror.Unauthenticated
	} else if err != nil {
		return SubmissionResult{}, err
	}
	// The login email is the address verified on this context, read under the context lock.
	if !locked.EmailVerifiedAt.Valid || locked.EmailDisplay == nil || locked.EmailNormalized == nil {
		return SubmissionResult{}, errEmailVerificationRequired
	}
	emailDisplay, emailNormalized := *locked.EmailDisplay, *locked.EmailNormalized
	configuration, err := s.loadConfiguration(ctx, queries)
	if err != nil {
		return SubmissionResult{}, err
	}
	if !configuration.Enabled {
		return SubmissionResult{}, apperror.New(
			http.StatusConflict,
			"visitor_enrollment_disabled",
			"Visitor enrollment is unavailable",
		)
	}
	role, err := queries.GetVisitorRole(ctx)
	if err != nil {
		return SubmissionResult{}, err
	}
	personID, accountID := ids.New(), ids.New()
	if _, err := queries.CreateVisitorPerson(
		ctx,
		visitordb.CreateVisitorPersonParams{
			ID:                 personID,
			FirstName:          clean.FirstName,
			LastName:           clean.LastName,
			Email:              &emailDisplay,
			ProfileImageFileID: storedImageID,
			MemberSince:        dates.TodayUTC(),
		},
	); err != nil {
		return SubmissionResult{}, databaseError(err)
	}
	status := authorization.AccountEnabled
	if _, err := queries.CreateVisitorAccount(
		ctx,
		visitordb.CreateVisitorAccountParams{ID: accountID, PersonID: personID, Status: string(status)},
	); err != nil {
		return SubmissionResult{}, databaseError(err)
	}
	// The verified address becomes the login email, which signs in with an emailed code only: no password, no PIN
	// and no invitation. Another account that took the address meanwhile makes this a conflict.
	if err := accounts.SetProvisionedLoginEmail(ctx, tx, accountID, emailDisplay, emailNormalized, true); err != nil {
		return SubmissionResult{}, databaseError(err)
	}
	if enabled, err := queries.EnableVisitorEmailCode(ctx, accountID); err != nil {
		return SubmissionResult{}, err
	} else if enabled != 1 {
		return SubmissionResult{}, errors.New("visitor login email was not created")
	}
	result := SubmissionResult{
		PersonID:      personID,
		AccountID:     accountID,
		AccountStatus: status,
		Admission:     AdmissionAdmitted,
		Attendance:    AttendanceCheckedIn,
	}
	var confirmedVersionID *uuid.UUID
	if laborordnung.Mode(role.LaborordnungMode) != laborordnung.ModeNotRequired {
		if !clean.LabRulesAccepted {
			return SubmissionResult{}, apperror.InvalidField("the Lab Rules must be read and accepted")
		}
		pinned, err := queries.GetPinnedLabRulesVersion(ctx, enrollment.ID)
		if errors.Is(err, pgx.ErrNoRows) {
			return SubmissionResult{}, apperror.New(
				http.StatusConflict,
				"lab_rules_unavailable",
				"No Lab Rules version was presented; restart visitor enrollment",
			)
		}
		if err != nil {
			return SubmissionResult{}, err
		}
		actor := accountID
		err = s.labRules.ConfirmTx(
			ctx, tx, personID, pinned.ID, laborordnung.MethodEnrollment, &actor, requestID,
		)
		if apperror.IsCode(err, "lab_rules_version_outdated") || apperror.IsCode(err, "lab_rules_unavailable") {
			// The visitor accepted a version that is no longer in effect; the kiosk starts over with the new one.
			return SubmissionResult{}, errLabRulesChanged
		}
		if err != nil {
			return SubmissionResult{}, err
		}
		confirmedVersionID = &pinned.ID
	}
	if s.consents != nil && len(clean.Consents) > 0 {
		principal := authorization.Principal{PersonID: personID, AccountID: accountID}
		deviceID := enrollment.ManagedDeviceID
		if err := s.consents.AnswerConsentsTx(
			ctx, tx, principal, clean.Consents, notifyrules.PlaceKiosk, &deviceID, requestID,
		); err != nil {
			return SubmissionResult{}, err
		}
	}
	if s.attendance != nil {
		if err := s.attendance.CheckInAtEnrollment(ctx, tx, attendance.EnrollmentCheckIn{
			PersonID: personID, AccountID: accountID, DeviceID: enrollment.ManagedDeviceID,
			VersionID: confirmedVersionID, RequestID: requestID,
		}); err != nil {
			return SubmissionResult{}, err
		}
	}
	if affected, err := queries.ConsumeEnrollmentContext(ctx, enrollment.ID); err != nil || affected != 1 {
		return SubmissionResult{}, apperror.Conflict
	}
	for _, event := range []audit.Event{
		{
			Action:        "visitor_enrollment.person_created",
			ResourceType:  "person",
			ResourceID:    &personID,
			RequestID:     requestID,
			ChangedFields: []string{"role", "profileImage"},
		},
		{
			Action:        "visitor_enrollment.account_created",
			ResourceType:  "account",
			ResourceID:    &accountID,
			RequestID:     requestID,
			ChangedFields: []string{"loginEmail", "emailCodeMethod"},
		},
	} {
		if err := audit.Write(ctx, tx, event); err != nil {
			return SubmissionResult{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return SubmissionResult{}, err
	}
	linked = true
	return result, nil
}

// Admission evaluates the signed-in person's Lab Rules status on an approved device. It is read-only.
func (s *Service) Admission(ctx context.Context, principal authorization.Principal) (AdmissionResult, error) {
	if principal.Device == nil {
		return AdmissionResult{}, apperror.PermissionDenied
	}
	allowed, err := visitordb.New(s.pool).IsDeviceTypeAllowed(ctx, principal.Device.ID)
	if err != nil || allowed == nil || !*allowed {
		if err != nil {
			return AdmissionResult{}, err
		}
		return AdmissionResult{}, apperror.PermissionDenied
	}
	status, err := s.labRules.Evaluate(ctx, principal.PersonID)
	if err != nil {
		return AdmissionResult{}, err
	}
	decision := AdmissionAdmitted
	if status.ActionRequired && status.Mode == laborordnung.ModeBlocking {
		decision = AdmissionBlocked
	} else if status.ActionRequired && status.Mode == laborordnung.ModeWarning {
		decision = AdmissionWarning
	}
	return AdmissionResult{Decision: decision, Status: status}, nil
}

// PhotoRequired reports whether enrollment on a device with these effective capabilities must include a profile photo.
// A device that can neither take nor upload one (no camera, no file_upload) enrolls without it.
func PhotoRequired(capabilities []string) bool {
	return slices.Contains(capabilities, manageddevices.CapabilityCamera) ||
		slices.Contains(capabilities, manageddevices.CapabilityFileUpload)
}

func validateSubmission(input SubmissionInput, photoRequired bool) (SubmissionInput, []byte, error) {
	input.FirstName, input.LastName = strings.TrimSpace(input.FirstName), strings.TrimSpace(input.LastName)
	if input.FirstName == "" || input.LastName == "" || len([]rune(input.FirstName)) > 100 ||
		len([]rune(input.LastName)) > 100 {
		return SubmissionInput{}, nil, apperror.InvalidField("firstName and lastName are required")
	}
	imageBytes := input.ProfileImage
	if len(imageBytes) == 0 && photoRequired {
		return SubmissionInput{}, nil, apperror.InvalidField("profile image is invalid")
	}
	return input, imageBytes, nil
}

func (s *Service) loadConfiguration(ctx context.Context, queries *visitordb.Queries) (Configuration, error) {
	row, err := queries.GetConfiguration(ctx)
	if err != nil {
		return Configuration{}, err
	}
	deviceTypes, err := queries.ListAllowedDeviceTypes(ctx)
	if err != nil {
		return Configuration{}, err
	}
	return Configuration{
		Enabled:       row.Enabled,
		DeviceTypeIDs: deviceTypes,
		Version:       row.Version,
		UpdatedAt:     row.UpdatedAt,
	}, nil
}

func (s *Service) pinnedLabRules(
	ctx context.Context,
	queries *visitordb.Queries,
	contextID uuid.UUID,
) (*LabRulesVersion, error) {
	row, err := queries.GetPinnedLabRulesVersion(ctx, contextID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &LabRulesVersion{
		ID:            row.ID,
		HumanRevision: row.HumanRevision,
		PDFFileID:     row.PdfFileID,
		EffectiveAt:   row.EffectiveAt.Time,
	}, nil
}

func authorizeVisitorRole(
	ctx context.Context,
	queries *visitordb.Queries,
	principal authorization.Principal,
) error {
	role, err := queries.GetVisitorRole(ctx)
	if err != nil {
		return err
	}
	rows, err := queries.GetRolePermissionGrants(ctx, role.ID)
	if err != nil {
		return err
	}
	grants := map[uuid.UUID]authorization.PermissionGrant{}
	for _, row := range rows {
		permission := authorization.Permission(row.PermissionID)
		if !authorization.Known(permission) {
			return apperror.PermissionDenied
		}
		grant := grants[row.ID]
		grant.ID, grant.PermissionID, grant.Scope, grant.MinimumAssurance = row.ID, permission, authorization.GrantScope(
			row.Scope,
		), authorization.Assurance(
			row.MinimumAssurance,
		)
		grant.ReauthWithinMinutes = authorization.ReauthWindowFromDB(row.ReauthWithinMinutes)
		if row.DeviceTypeID != nil {
			grant.DeviceTypeIDs = append(grant.DeviceTypeIDs, *row.DeviceTypeID)
		}
		grants[row.ID] = grant
	}
	for _, grant := range grants {
		if !principal.Master && !principal.CanDelegate(grant) {
			return apperror.PermissionDenied
		}
	}
	return nil
}

func uniqueUUIDs(values []uuid.UUID) ([]uuid.UUID, error) {
	seen := map[uuid.UUID]struct{}{}
	result := make([]uuid.UUID, 0, len(values))
	for _, value := range values {
		if value == uuid.Nil {
			return nil, apperror.InvalidField("Device Type IDs must be valid")
		}
		if _, exists := seen[value]; exists {
			return nil, apperror.InvalidField("Device Type IDs must be unique")
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].String() < result[j].String() })
	return result, nil
}

func databaseError(err error) error {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) && postgresError.Code == "23505" {
		return errIdentifierExists()
	}
	return err
}
