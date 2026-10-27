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
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	visitordb "github.com/Basmatireis/Makerspace-Core/backend/internal/visitor/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const enrollmentTTL = 15 * time.Minute

type InvitationNotifier interface {
	SendInvitation(context.Context, string, string, time.Time) error
}

type Configuration struct {
	Enabled        bool
	InitialRoleID  *uuid.UUID
	DeviceTypeIDs  []uuid.UUID
	AllowedMethods []AuthMethod
	Version        int64
	UpdatedAt      time.Time
}

type ConfigurationInput struct {
	Enabled         bool
	InitialRoleID   *uuid.UUID
	DeviceTypeIDs   []uuid.UUID
	AllowedMethods  []AuthMethod
	ExpectedVersion int64
}

type Context struct {
	ID              uuid.UUID
	ManagedDeviceID uuid.UUID
	CSRFTokenDigest []byte
	ExpiresAt       time.Time
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
	AllowedMethods []AuthMethod
	// Capabilities are the effective capabilities of the enrolling device.
	Capabilities    []string
	CurrentLabRules *LabRulesVersion
	ExpiresAt       time.Time
}

type SubmissionInput struct {
	FirstName    string
	LastName     string
	Email        *string
	Phone        *string
	AuthMethods  []AuthMethod
	PINLoginName *string
	PIN          *string
	// ProfileImage is required when the device can take or upload a photo and ignored otherwise.
	ProfileImage         []byte
	ProfileImageFilename string
	RequestConfirmation  bool
}

type SubmissionResult struct {
	PersonID           uuid.UUID
	AccountID          uuid.UUID
	AccountStatus      authorization.AccountStatus
	InvitationDelivery *auth.DeliveryStatus
	LabRulesRequestID  *uuid.UUID
	Admission          Admission
	// Attendance reports the check-in that completing enrollment implies.
	Attendance Attendance
}

// Attendance is the outcome of the check-in that completes enrollment.
type Attendance string

const (
	AttendanceCheckedIn       Attendance = "checked_in"
	AttendanceAwaitingSignOff Attendance = "awaiting_sign_off"
)

// EnrollmentAttendance counts a finished enrollment as arriving, inside the enrollment transaction.
type EnrollmentAttendance interface {
	CheckInAtEnrollment(context.Context, pgx.Tx, attendance.EnrollmentCheckIn) (bool, error)
}

type AdmissionResult struct {
	Decision  Admission
	Status    laborordnung.Status
	RequestID *uuid.UUID
}

type Service struct {
	pool       *pgxpool.Pool
	config     config.Config
	files      *files.Service
	labRules   *laborordnung.Service
	notifier   InvitationNotifier
	attendance EnrollmentAttendance
}

// SetAttendance wires the attendance module, which itself depends on services built after this one.
func (s *Service) SetAttendance(a EnrollmentAttendance) { s.attendance = a }

func NewService(
	pool *pgxpool.Pool,
	cfg config.Config,
	fileService *files.Service,
	labRules *laborordnung.Service,
	notifier InvitationNotifier,
) *Service {
	return &Service{pool: pool, config: cfg, files: fileService, labRules: labRules, notifier: notifier}
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
	methods, err := normalizeMethods(input.AllowedMethods)
	if err != nil || input.ExpectedVersion < 1 ||
		(input.Enabled && (input.InitialRoleID == nil || len(input.DeviceTypeIDs) == 0 || len(methods) == 0)) {
		return Configuration{}, apperror.InvalidField(
			"enabled enrollment requires an initial Role, at least one Device Type, and at least one authentication method",
		)
	}
	deviceTypes, err := uniqueUUIDs(input.DeviceTypeIDs)
	if err != nil {
		return Configuration{}, err
	}
	queries := visitordb.New(tx)
	if input.InitialRoleID != nil {
		if err := authorizeRole(ctx, queries, principal, *input.InitialRoleID); err != nil {
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
			InitialRoleID:      input.InitialRoleID,
			AllowedMethods:     optional.ConvertSlice[string](methods),
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
			ChangedFields:  []string{"enabled", "initialRoleId", "deviceTypeIds", "allowedMethods"},
		},
	); err != nil {
		return Configuration{}, err
	}
	return Configuration{
		Enabled:        row.Enabled,
		InitialRoleID:  row.InitialRoleID,
		DeviceTypeIDs:  deviceTypes,
		AllowedMethods: optional.ConvertSlice[AuthMethod](row.AllowedMethods),
		Version:        row.Version,
		UpdatedAt:      row.UpdatedAt,
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
	configuration, err := s.loadConfiguration(ctx, visitordb.New(s.pool))
	if err != nil {
		return EnrollmentState{}, err
	}
	version, err := s.pinnedLabRules(ctx, visitordb.New(s.pool), enrollment.ID)
	if err != nil {
		return EnrollmentState{}, err
	}
	capabilities, err := manageddevices.NewService(s.pool).EffectiveCapabilities(ctx, enrollment.ManagedDeviceID)
	if err != nil {
		return EnrollmentState{}, err
	}
	return EnrollmentState{
		AllowedMethods:  configuration.AllowedMethods,
		Capabilities:    capabilities,
		CurrentLabRules: version,
		ExpiresAt:       enrollment.ExpiresAt,
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
	clean, pinDisplay, pinNormalized, pinHash, imageBytes, err := s.validateSubmission(
		input,
		PhotoRequired(capabilities),
	)
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
	var invitationCode string
	var invitationExpiresAt time.Time
	if slices.Contains(clean.AuthMethods, MethodPassword) {
		invitationCode, err = security.NewChallengeCode()
		if err != nil {
			return SubmissionResult{}, err
		}
		invitationExpiresAt = time.Now().UTC().Add(s.config.PasswordResetTTL)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SubmissionResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := visitordb.New(tx)
	if _, err := queries.GetEnrollmentContextForUpdate(ctx, enrollment.ID); errors.Is(err, pgx.ErrNoRows) {
		return SubmissionResult{}, apperror.Unauthenticated
	} else if err != nil {
		return SubmissionResult{}, err
	}
	configuration, err := s.loadConfiguration(ctx, queries)
	if err != nil {
		return SubmissionResult{}, err
	}
	for _, method := range clean.AuthMethods {
		if !slices.Contains(configuration.AllowedMethods, method) {
			return SubmissionResult{}, apperror.PermissionDenied
		}
	}
	if configuration.InitialRoleID == nil {
		return SubmissionResult{}, apperror.New(
			http.StatusConflict,
			"visitor_enrollment_disabled",
			"Visitor enrollment is unavailable",
		)
	}
	role, err := queries.GetAssignableRole(ctx, *configuration.InitialRoleID)
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
			Email:              clean.Email,
			Phone:              clean.Phone,
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
	var challengeID *uuid.UUID
	if clean.Email != nil && !slices.Contains(clean.AuthMethods, MethodPassword) {
		// The visitor's email is the account's login email even when they enrol with a PIN only (a password
		// can be set later). Another account already using the address leaves this account without one.
		if display, normalized, normalizeErr := security.NormalizeEmail(*clean.Email); normalizeErr == nil {
			if _, err := accounts.TrySetProvisionedLoginEmail(ctx, tx, accountID, display, normalized, false); err != nil {
				return SubmissionResult{}, err
			}
		}
	}
	if slices.Contains(clean.AuthMethods, MethodPassword) {
		display, normalized, _ := security.NormalizeEmail(*clean.Email)
		identity, err := queries.CreateVisitorPasswordIdentity(
			ctx,
			visitordb.CreateVisitorPasswordIdentityParams{
				ID:                   ids.New(),
				AccountID:            accountID,
				IdentifierDisplay:    &display,
				IdentifierNormalized: &normalized,
			},
		)
		if err != nil {
			return SubmissionResult{}, databaseError(err)
		}
		id := ids.New()
		if _, err := queries.CreateVisitorInvitation(
			ctx,
			visitordb.CreateVisitorInvitationParams{
				ID:             id,
				AccountID:      accountID,
				AuthIdentityID: &identity.ID,
				CodeDigest: security.ChallengeDigest(
					s.config.ChallengeHMACKey,
					"invitation",
					accountID,
					invitationCode,
				),
				DeliveryAddress: &display,
				ExpiresAt:       invitationExpiresAt,
			},
		); err != nil {
			return SubmissionResult{}, err
		}
		challengeID = &id
	}
	if slices.Contains(clean.AuthMethods, MethodPIN) {
		identity, err := queries.CreateVisitorPINIdentity(
			ctx,
			visitordb.CreateVisitorPINIdentityParams{
				ID:                   ids.New(),
				AccountID:            accountID,
				IdentifierDisplay:    &pinDisplay,
				IdentifierNormalized: &pinNormalized,
			},
		)
		if err != nil {
			return SubmissionResult{}, databaseError(err)
		}
		if err := queries.CreateVisitorPINCredential(
			ctx,
			visitordb.CreateVisitorPINCredentialParams{AuthIdentityID: identity.ID, PinHash: pinHash},
		); err != nil {
			return SubmissionResult{}, err
		}
	}
	if err := queries.AssignVisitorRole(
		ctx,
		visitordb.AssignVisitorRoleParams{PersonID: personID, RoleID: role.ID},
	); err != nil {
		return SubmissionResult{}, err
	}
	result := SubmissionResult{PersonID: personID, AccountID: accountID, AccountStatus: status, Admission: AdmissionAdmitted}
	if laborordnung.Mode(role.LaborordnungMode) != laborordnung.ModeNotRequired {
		current, err := queries.GetPinnedLabRulesVersion(ctx, enrollment.ID)
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
		requestRow, err := queries.CreateLabRulesRequest(
			ctx,
			visitordb.CreateLabRulesRequestParams{
				ID:                ids.New(),
				PersonID:          personID,
				RequiredVersionID: current.ID,
			},
		)
		if err != nil {
			return SubmissionResult{}, err
		}
		result.LabRulesRequestID = &requestRow.ID
		if laborordnung.Mode(role.LaborordnungMode) == laborordnung.ModeBlocking {
			result.Admission = AdmissionBlocked
		} else {
			result.Admission = AdmissionWarning
		}
	}
	if s.attendance != nil {
		var versionID *uuid.UUID
		if result.LabRulesRequestID != nil {
			if current, err := queries.GetPinnedLabRulesVersion(ctx, enrollment.ID); err == nil {
				versionID = &current.ID
			}
		}
		checkedIn, err := s.attendance.CheckInAtEnrollment(ctx, tx, attendance.EnrollmentCheckIn{
			PersonID: personID, AccountID: accountID, DeviceID: enrollment.ManagedDeviceID,
			Blocking:       result.Admission == AdmissionBlocked,
			ActionRequired: result.Admission == AdmissionWarning,
			VersionID:      versionID, RequestID: requestID,
		})
		if err != nil {
			return SubmissionResult{}, err
		}
		result.Attendance = AttendanceAwaitingSignOff
		if checkedIn {
			result.Attendance = AttendanceCheckedIn
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
			ChangedFields: []string{"authMethods"},
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
	if challengeID != nil {
		delivery := auth.DeliveryFailed
		var deliveryFailure *string
		if s.notifier != nil &&
			s.notifier.SendInvitation(ctx, *clean.Email, invitationCode, invitationExpiresAt) == nil {
			delivery = auth.DeliverySent
		} else {
			value := "provider_error"
			deliveryFailure = &value
		}
		_ = visitordb.New(s.pool).
			SetChallengeDelivery(
				ctx,
				visitordb.SetChallengeDeliveryParams{
					ID:                  *challengeID,
					DeliveryStatus:      string(delivery),
					DeliveryFailureCode: deliveryFailure,
				},
			)
		result.InvitationDelivery = &delivery
	}
	return result, nil
}

func (s *Service) Admission(
	ctx context.Context,
	principal authorization.Principal,
	requestID *uuid.UUID,
) (AdmissionResult, error) {
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
	var requestIDValue *uuid.UUID
	if status.ActionRequired {
		request, _, err := s.labRules.RequestOwnConfirmation(ctx, principal, requestID)
		if err != nil {
			return AdmissionResult{}, err
		}
		requestIDValue = &request.ID
		status, err = s.labRules.Evaluate(ctx, principal.PersonID)
		if err != nil {
			return AdmissionResult{}, err
		}
	}
	decision := AdmissionAdmitted
	if status.ActionRequired && status.Mode == laborordnung.ModeBlocking {
		decision = AdmissionBlocked
	} else if status.ActionRequired && status.Mode == laborordnung.ModeWarning {
		decision = AdmissionWarning
	}
	return AdmissionResult{Decision: decision, Status: status, RequestID: requestIDValue}, nil
}

// PhotoRequired reports whether enrollment on a device with these effective capabilities must include a profile photo.
// A device that can neither take nor upload one (no camera, no file_upload) enrolls without it.
func PhotoRequired(capabilities []string) bool {
	return slices.Contains(capabilities, manageddevices.CapabilityCamera) ||
		slices.Contains(capabilities, manageddevices.CapabilityFileUpload)
}

func (s *Service) validateSubmission(input SubmissionInput, photoRequired bool) (SubmissionInput, string, string, string, []byte, error) {
	input.FirstName, input.LastName = strings.TrimSpace(input.FirstName), strings.TrimSpace(input.LastName)
	if input.FirstName == "" || input.LastName == "" || len([]rune(input.FirstName)) > 100 ||
		len([]rune(input.LastName)) > 100 {
		return SubmissionInput{}, "", "", "", nil, apperror.InvalidField("firstName and lastName are required")
	}
	input.Email = optional.Trimmed(input.Email)
	input.Phone = optional.Trimmed(input.Phone)
	if input.Email == nil && input.Phone == nil {
		return SubmissionInput{}, "", "", "", nil, apperror.InvalidField("at least one contact method is required")
	}
	if input.Email != nil {
		display, _, err := security.NormalizeEmail(*input.Email)
		if err != nil {
			return SubmissionInput{}, "", "", "", nil, apperror.InvalidField("email is invalid")
		}
		input.Email = &display
	}
	if input.Phone != nil && len([]rune(*input.Phone)) > 64 {
		return SubmissionInput{}, "", "", "", nil, apperror.InvalidField("phone is invalid")
	}
	methods, err := normalizeMethods(input.AuthMethods)
	if err != nil || len(methods) == 0 {
		return SubmissionInput{}, "", "", "", nil, apperror.InvalidField(
			"at least one supported authentication method is required",
		)
	}
	input.AuthMethods = methods
	if slices.Contains(methods, MethodPassword) && input.Email == nil {
		return SubmissionInput{}, "", "", "", nil, apperror.InvalidField("email is required for password invitation")
	}
	var pinDisplay, pinNormalized, pinHash string
	if slices.Contains(methods, MethodPIN) {
		if input.PINLoginName == nil || input.PIN == nil {
			return SubmissionInput{}, "", "", "", nil, apperror.InvalidField("PIN username and PIN are required")
		}
		pinDisplay, pinNormalized, err = auth.NormalizePINLoginName(*input.PINLoginName)
		if err != nil {
			return SubmissionInput{}, "", "", "", nil, apperror.InvalidField(err.Error())
		}
		pinHash, err = security.HashPIN(s.config.PINPepper, *input.PIN)
		if err != nil {
			return SubmissionInput{}, "", "", "", nil, apperror.InvalidField(err.Error())
		}
	}
	if !input.RequestConfirmation {
		return SubmissionInput{}, "", "", "", nil, apperror.InvalidField(
			"explicit Lab Rules signing request is required",
		)
	}
	imageBytes := input.ProfileImage
	if len(imageBytes) == 0 && photoRequired {
		return SubmissionInput{}, "", "", "", nil, apperror.InvalidField("profile image is invalid")
	}
	return input, pinDisplay, pinNormalized, pinHash, imageBytes, nil
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
		Enabled:        row.Enabled,
		InitialRoleID:  row.InitialRoleID,
		DeviceTypeIDs:  deviceTypes,
		AllowedMethods: optional.ConvertSlice[AuthMethod](row.AllowedMethods),
		Version:        row.Version,
		UpdatedAt:      row.UpdatedAt,
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

func authorizeRole(
	ctx context.Context,
	queries *visitordb.Queries,
	principal authorization.Principal,
	roleID uuid.UUID,
) error {
	role, err := queries.GetAssignableRole(ctx, roleID)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if role.SystemKey != nil {
		if !principal.Master {
			return apperror.PermissionDenied
		}
		return nil
	}
	rows, err := queries.GetRolePermissionGrants(ctx, roleID)
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

func normalizeMethods(values []AuthMethod) ([]AuthMethod, error) {
	seen := map[AuthMethod]struct{}{}
	for _, value := range values {
		value = AuthMethod(strings.ToLower(strings.TrimSpace(string(value))))
		if value != MethodPassword && value != MethodPIN {
			return nil, errors.New("unsupported authentication method")
		}
		seen[value] = struct{}{}
	}
	result := make([]AuthMethod, 0, len(seen))
	for value := range seen {
		result = append(result, value)
	}
	slices.Sort(result)
	return result, nil
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
		return apperror.New(
			http.StatusConflict,
			"authentication_identifier_exists",
			"This login identifier already belongs to an Account; use returning-user login",
		)
	}
	return err
}
