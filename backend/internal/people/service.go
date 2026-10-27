package people

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/jpeg"
	_ "image/png"
	"io"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/dates"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accounts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/events"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	peopledb "github.com/Basmatireis/Makerspace-Core/backend/internal/people/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

type Person struct {
	ID                  uuid.UUID
	FirstName           string
	LastName            string
	Email               *string
	Phone               *string
	MatriculationNumber *string
	PhotoReference      *string
	ProfileImageFileID  *uuid.UUID
	ProfileImageSource  *ProfileImageSource
	Roles               []RoleSummary
	// MemberSince is a calendar day (UTC midnight), editable only with people.update.all.
	MemberSince time.Time
	Version     int64
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type RoleSummary struct {
	ID        uuid.UUID
	Name      string
	SystemKey *authorization.SystemKey
}

type CreateInput struct {
	FirstName           string
	LastName            string
	Email               *string
	Phone               *string
	MatriculationNumber *string
}

type OptionalString struct {
	Set   bool
	Value *string
}

type UpdateInput struct {
	ExpectedVersion     int64
	FirstName           *string
	LastName            *string
	Email               OptionalString
	Phone               OptionalString
	MatriculationNumber OptionalString
	// MemberSince changes the membership start day; it requires people.update.all even for the own person.
	MemberSince *time.Time
}

type Page struct {
	Items    []Person
	Page     int
	PageSize int
	Total    int64
}

type Service struct {
	pool  *pgxpool.Pool
	files *files.Service
}

// NewService returns the people service. fileService may be nil when profile images are not
// served (administrative tools); image operations then fail.
func NewService(pool *pgxpool.Pool, fileService *files.Service) *Service {
	return &Service{pool: pool, files: fileService}
}

func (s *Service) Create(
	ctx context.Context,
	principal authorization.Principal,
	input CreateInput,
	requestID *uuid.UUID,
) (Person, error) {
	if !principal.Has(authorization.PeopleCreate) {
		return Person{}, apperror.PermissionDenied
	}
	email := optional.Trimmed(input.Email)
	phone := optional.Trimmed(input.Phone)
	matriculation := optional.Trimmed(input.MatriculationNumber)
	if matriculation != nil && !principal.Has(authorization.PeopleUpdateMatriculation) {
		return Person{}, apperror.PermissionDenied
	}
	if err := validate(input.FirstName, input.LastName, email, phone, matriculation); err != nil {
		return Person{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Person{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	id := ids.New()
	row, err := peopledb.New(tx).CreatePerson(ctx, peopledb.CreatePersonParams{
		ID: id, FirstName: strings.TrimSpace(input.FirstName), LastName: strings.TrimSpace(input.LastName),
		Email: email, Phone: phone, MatriculationNumber: matriculation, PhotoReference: nil,
		MemberSince: dates.TodayUTC(),
	})
	if err != nil {
		return Person{}, databaseError(err)
	}
	actor := principal.AccountID
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "person.created",
			ResourceType:   "person",
			ResourceID:     &id,
			RequestID:      requestID,
		},
	); err != nil {
		return Person{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Person{}, err
	}
	return fromRow(row, principal.CanReadPerson(id), principal.Has(authorization.PeopleReadMatriculation)), nil
}

func (s *Service) Get(ctx context.Context, principal authorization.Principal, id uuid.UUID) (Person, error) {
	if !principal.CanReadPerson(id) {
		return Person{}, apperror.PermissionDenied
	}
	row, err := peopledb.New(s.pool).GetPerson(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Person{}, apperror.NotFound
	}
	if err != nil {
		return Person{}, err
	}
	return loadPerson(ctx, peopledb.New(s.pool), row, true, principal.Has(authorization.PeopleReadMatriculation))
}

func (s *Service) GetCurrent(ctx context.Context, principal authorization.Principal) (Person, error) {
	row, err := peopledb.New(s.pool).GetPerson(ctx, principal.PersonID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Person{}, apperror.NotFound
	}
	if err != nil {
		return Person{}, err
	}
	includeDetails := principal.CanReadPerson(principal.PersonID)
	return loadPerson(
		ctx,
		peopledb.New(s.pool),
		row,
		includeDetails,
		includeDetails && principal.Has(authorization.PeopleReadMatriculation),
	)
}

type ListFilters struct {
	Search               string
	RoleIDs              []uuid.UUID
	AccountStatuses      []string
	LaborordnungStatuses []string
}

var validAccountStatuses = map[string]struct{}{
	"no_account": {},
	"enabled":    {},
	"disabled":   {},
}

var validLaborordnungStatuses = map[string]struct{}{
	"not_required":         {},
	"no_published_version": {},
	"current":              {},
	"outdated":             {},
	"pending":              {},
}

func (s *Service) List(
	ctx context.Context,
	principal authorization.Principal,
	page, pageSize int,
	filters ListFilters,
) (Page, error) {
	if !principal.Has(authorization.PeopleReadAll) {
		return Page{}, apperror.PermissionDenied
	}
	if len(filters.AccountStatuses) > 0 && !principal.Has(authorization.AccountsRead) {
		return Page{}, apperror.PermissionDenied
	}
	if len(filters.LaborordnungStatuses) > 0 && !principal.Has(authorization.LaborordnungRequestsRead) {
		return Page{}, apperror.PermissionDenied
	}
	if page < 1 || pageSize < 1 || pageSize > 100 || page > math.MaxInt32/pageSize ||
		!utf8.ValidString(filters.Search) ||
		utf8.RuneCountInString(filters.Search) > 200 {
		return Page{}, invalidRequest("invalid pagination or search")
	}
	if len(filters.RoleIDs) > 50 || len(filters.AccountStatuses) > len(validAccountStatuses) ||
		len(filters.LaborordnungStatuses) > len(validLaborordnungStatuses) {
		return Page{}, invalidRequest("too many filters")
	}
	for _, status := range filters.AccountStatuses {
		if _, ok := validAccountStatuses[status]; !ok {
			return Page{}, invalidRequest("invalid account status filter")
		}
	}
	for _, status := range filters.LaborordnungStatuses {
		if _, ok := validLaborordnungStatuses[status]; !ok {
			return Page{}, invalidRequest("invalid Lab Rules status filter")
		}
	}
	roleIDs := make([]string, len(filters.RoleIDs))
	for index, roleID := range filters.RoleIDs {
		roleIDs[index] = roleID.String()
	}
	params := peopledb.ListPeopleParams{
		Search: filters.Search, IncludeMatriculation: principal.Has(authorization.PeopleReadMatriculation),
		RoleIds: roleIDs, AccountStatuses: filters.AccountStatuses, LaborordnungStatuses: filters.LaborordnungStatuses,
		PageLimit: int32(pageSize), PageOffset: int32((page - 1) * pageSize),
	}
	queries := peopledb.New(s.pool)
	rows, err := queries.ListPeople(ctx, params)
	if err != nil {
		return Page{}, err
	}
	total, err := queries.CountPeople(ctx, peopledb.CountPeopleParams{
		Search: params.Search, IncludeMatriculation: params.IncludeMatriculation,
		RoleIds:              params.RoleIds,
		AccountStatuses:      params.AccountStatuses,
		LaborordnungStatuses: params.LaborordnungStatuses,
	})
	if err != nil {
		return Page{}, err
	}
	items := make([]Person, 0, len(rows))
	personIDs := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		items = append(items, fromRow(row, true, params.IncludeMatriculation))
		personIDs = append(personIDs, row.ID)
	}
	if err := hydratePeopleRoles(ctx, queries, items, personIDs); err != nil {
		return Page{}, err
	}
	return Page{Items: items, Page: page, PageSize: pageSize, Total: total}, nil
}

func (s *Service) ProfileImageRequirements(
	ctx context.Context,
	principal authorization.Principal,
	personIDs []uuid.UUID,
) (map[uuid.UUID]bool, error) {
	if !principal.Has(authorization.PeopleReadAll) {
		return nil, apperror.PermissionDenied
	}
	result := make(map[uuid.UUID]bool, len(personIDs))
	if len(personIDs) == 0 {
		return result, nil
	}
	rows, err := peopledb.New(s.pool).ListProfileImageRequirements(ctx, uuidStrings(personIDs))
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		result[row.PersonID] = row.Required
	}
	return result, nil
}

func (s *Service) Update(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	input UpdateInput,
	requestID *uuid.UUID,
) (Person, error) {
	if !principal.CanUpdatePerson(id) {
		return Person{}, apperror.PermissionDenied
	}
	if input.MatriculationNumber.Set && !principal.Has(authorization.PeopleUpdateMatriculation) {
		return Person{}, apperror.PermissionDenied
	}
	// The membership start is an administrative fact: self-service profile edits must not change it.
	if input.MemberSince != nil && !principal.Has(authorization.PeopleUpdateAll) {
		return Person{}, apperror.PermissionDenied
	}
	if input.ExpectedVersion < 1 ||
		(input.FirstName == nil && input.LastName == nil && !input.Email.Set && !input.Phone.Set &&
			!input.MatriculationNumber.Set && input.MemberSince == nil) {
		return Person{}, apperror.InvalidField("at least one field and a valid expectedVersion are required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Person{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := peopledb.New(tx)
	// Lock the person first (people before accounts): it serializes with account creation, which decides
	// whether the email below is still a plain contact email.
	current, err := queries.GetPersonForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Person{}, apperror.NotFound
	}
	if err != nil {
		return Person{}, err
	}
	firstName, lastName := current.FirstName, current.LastName
	if input.FirstName != nil {
		firstName = strings.TrimSpace(*input.FirstName)
	}
	if input.LastName != nil {
		lastName = strings.TrimSpace(*input.LastName)
	}
	email, phone, matriculation := current.Email, current.Phone, current.MatriculationNumber
	if input.Email.Set {
		email = optional.Trimmed(input.Email.Value)
		if !sameString(current.Email, email) {
			hasAccount, err := queries.PersonHasAccount(ctx, id)
			if err != nil {
				return Person{}, err
			}
			if hasAccount {
				return Person{}, ErrEmailManagedByAccount
			}
		}
	}
	memberSince := current.MemberSince
	if input.MemberSince != nil {
		memberSince = dates.FromTime(*input.MemberSince)
		if err := validateMemberSince(memberSince.Time, time.Now()); err != nil {
			return Person{}, err
		}
	}
	if input.Phone.Set {
		phone = optional.Trimmed(input.Phone.Value)
	}
	if input.MatriculationNumber.Set {
		matriculation = optional.Trimmed(input.MatriculationNumber.Value)
	}
	if err := validate(firstName, lastName, email, phone, matriculation); err != nil {
		return Person{}, err
	}
	changed := changedFields(current, firstName, lastName, email, phone, matriculation)
	if !memberSince.Time.Equal(current.MemberSince.Time) {
		changed = append(changed, "memberSince")
	}
	row, err := queries.UpdatePerson(ctx, peopledb.UpdatePersonParams{
		ID: id, ExpectedVersion: input.ExpectedVersion, FirstName: firstName, LastName: lastName,
		Email: email, Phone: phone, MatriculationNumber: matriculation, PhotoReference: current.PhotoReference,
		MemberSince: memberSince,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Person{}, apperror.StaleWrite
	}
	if err != nil {
		return Person{}, databaseError(err)
	}
	actor := principal.AccountID
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "person.updated",
			ResourceType:   "person",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  changed,
		},
	); err != nil {
		return Person{}, err
	}
	result, err := loadPerson(
		ctx,
		queries,
		row,
		principal.CanReadPerson(id),
		principal.Has(authorization.PeopleReadMatriculation),
	)
	if err != nil {
		return Person{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Person{}, err
	}
	return result, nil
}

func (s *Service) Delete(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expectedVersion int64,
	requestID *uuid.UUID,
) error {
	if !principal.Has(authorization.PeopleDelete) {
		return apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return apperror.InvalidField("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	peopleQueries := peopledb.New(tx)
	current, err := peopleQueries.GetPersonForDeletion(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	} else if err != nil {
		return err
	}
	if current.Version != expectedVersion {
		return apperror.StaleWrite
	}
	// Collect every business rule that blocks the deletion so the operator
	// sees all of them at once instead of fixing one per attempt.
	var blockers []*apperror.Error
	var appErr *apperror.Error
	if err := accounts.AuthorizePersonDeletion(ctx, tx, principal, id); errors.As(err, &appErr) &&
		appErr.HTTPStatus == 409 {
		blockers = append(blockers, appErr)
	} else if err != nil {
		return err
	}
	// SCIM links restrict deletion; deprovisioning belongs to the identity provider.
	scimManaged, err := peopleQueries.PersonHasSCIMProvisioning(ctx, id)
	if err != nil {
		return err
	}
	if scimManaged {
		blockers = append(
			blockers,
			apperror.New(
				http.StatusConflict,
				"person_scim_managed",
				"This person is provisioned through SCIM. Remove them in the identity provider instead.",
			),
		)
	}
	if len(blockers) > 0 {
		return personDeletionBlocked(blockers...)
	}
	if current.ProfileImageFileID != nil && s.files == nil {
		return errors.New("file storage is unavailable")
	}
	actor := principal.AccountID
	if err := events.ScrubAssignmentsForDeletedPerson(ctx, tx, actor, id, requestID); err != nil {
		return err
	}
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "person.deleted",
			ResourceType:   "person",
			ResourceID:     &id,
			RequestID:      requestID,
		},
	); err != nil {
		return err
	}
	if _, err := peopleQueries.DeletePerson(
		ctx,
		peopledb.DeletePersonParams{ID: id, ExpectedVersion: expectedVersion},
	); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return apperror.StaleWrite
	} else if blocker := accounts.DeletionReferenceBlocker(err); blocker != nil {
		return personDeletionBlocked(blocker)
	} else if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if current.ProfileImageFileID != nil {
		// The actor may have deleted their own Account. The Person deletion's
		// audit event records the actor; subsequent file cleanup is system-owned.
		return s.files.DeleteSystem(ctx, *current.ProfileImageFileID, requestID)
	}
	return nil
}

func personDeletionBlocked(reasons ...*apperror.Error) *apperror.Error {
	return apperror.Blocked("person_deletion_blocked", "This person cannot be deleted for several reasons", reasons...)
}

// MaxProfileImageBytes is the largest profile image upload.
const MaxProfileImageBytes = 8 << 20

func (s *Service) PutProfileImage(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expectedVersion int64,
	filename string,
	source ProfileImageSource,
	reader io.Reader,
	requestID *uuid.UUID,
) (Person, error) {
	if s.files == nil {
		return Person{}, errors.New("file storage is unavailable")
	}
	if !principal.Has(authorization.PeopleProfileImageUpdateAll) &&
		(principal.PersonID != id || !principal.Has(authorization.PeopleProfileImageUpdateSelf)) {
		return Person{}, apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return Person{}, apperror.InvalidField("expectedVersion must be positive")
	}
	if source == "" {
		if principal.PersonID == id {
			source = ImageSelfUpload
		} else {
			source = ImageAdminUpload
		}
	}
	if source != ImageKioskCapture && source != ImageSelfUpload && source != ImageAdminUpload {
		return Person{}, apperror.InvalidField("profile image source is invalid")
	}
	if source == ImageSelfUpload && principal.PersonID != id {
		source = ImageAdminUpload
	}
	normalized, err := NormalizeProfileImage(reader)
	if err != nil {
		return Person{}, err
	}
	stored, err := s.files.StoreBytes(ctx, principal, filename, "image/jpeg", normalized, requestID)
	if err != nil {
		return Person{}, err
	}
	linked := false
	defer func() {
		if !linked {
			_ = s.files.Delete(context.Background(), principal, stored.ID, requestID)
		}
	}()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Person{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := peopledb.New(tx)
	current, err := queries.GetPersonForDeletion(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Person{}, apperror.NotFound
	}
	if err != nil {
		return Person{}, err
	}
	if current.Version != expectedVersion {
		return Person{}, apperror.StaleWrite
	}
	row, err := queries.SetProfileImage(
		ctx,
		peopledb.SetProfileImageParams{
			ID:                 id,
			ExpectedVersion:    expectedVersion,
			ProfileImageFileID: &stored.ID,
			ProfileImageSource: optional.Of(string(source)),
		},
	)
	if err != nil {
		return Person{}, err
	}
	actor := principal.AccountID
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "person.profile_image.updated",
			ResourceType:   "person",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"profileImage"},
		},
	); err != nil {
		return Person{}, err
	}
	result, err := loadPerson(
		ctx,
		queries,
		row,
		principal.CanReadPerson(id),
		principal.Has(authorization.PeopleReadMatriculation),
	)
	if err != nil {
		return Person{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Person{}, err
	}
	linked = true
	if current.ProfileImageFileID != nil {
		_ = s.files.Delete(context.Background(), principal, *current.ProfileImageFileID, requestID)
	}
	return result, nil
}

func (s *Service) DeleteProfileImage(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expectedVersion int64,
	requestID *uuid.UUID,
) error {
	if s.files == nil {
		return errors.New("file storage is unavailable")
	}
	if !principal.Has(authorization.PeopleProfileImageRemoveAll) &&
		(principal.PersonID != id || !principal.Has(authorization.PeopleProfileImageRemoveSelf)) {
		return apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := peopledb.New(tx)
	current, err := queries.GetPersonForDeletion(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if current.Version != expectedVersion {
		return apperror.StaleWrite
	}
	if current.ProfileImageFileID == nil {
		return apperror.NotFound
	}
	if _, err := queries.SetProfileImage(
		ctx,
		peopledb.SetProfileImageParams{ID: id, ExpectedVersion: expectedVersion},
	); err != nil {
		return err
	}
	actor := principal.AccountID
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "person.profile_image.removed",
			ResourceType:   "person",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"profileImage"},
		},
	); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	_ = s.files.Delete(context.Background(), principal, *current.ProfileImageFileID, requestID)
	return nil
}

func (s *Service) OpenProfileImage(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
) (files.File, io.ReadCloser, error) {
	if s.files == nil {
		return files.File{}, nil, errors.New("file storage is unavailable")
	}
	if !principal.CanReadPerson(id) {
		return files.File{}, nil, apperror.PermissionDenied
	}
	profile, err := peopledb.New(s.pool).GetProfileImage(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) || profile.ProfileImageFileID == nil {
		return files.File{}, nil, apperror.NotFound
	}
	if err != nil {
		return files.File{}, nil, err
	}
	return s.files.Open(ctx, *profile.ProfileImageFileID)
}

func (s *Service) RequiresProfileImage(ctx context.Context, id uuid.UUID) (bool, error) {
	return peopledb.New(s.pool).PersonRequiresProfileImage(ctx, id)
}

func (s *Service) ChangeRole(
	ctx context.Context,
	principal authorization.Principal,
	personID, roleID uuid.UUID,
	expectedVersion int64,
	assign bool,
	requestID *uuid.UUID,
) (Person, error) {
	if !principal.Has(authorization.PeopleRolesAssign) {
		return Person{}, apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return Person{}, apperror.InvalidField("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Person{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := peopledb.New(tx)
	current, err := queries.GetPersonForDeletion(ctx, personID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Person{}, apperror.NotFound
	}
	if err != nil {
		return Person{}, err
	}
	if current.Version != expectedVersion {
		return Person{}, apperror.StaleWrite
	}
	role, err := authorizeRoleAssignment(ctx, queries, principal, roleID)
	if err != nil {
		return Person{}, err
	}
	present, err := queries.IsPersonRoleAssigned(
		ctx,
		peopledb.IsPersonRoleAssignedParams{PersonID: personID, RoleID: roleID},
	)
	if err != nil {
		return Person{}, err
	}
	if present == assign {
		result, err := loadPerson(
			ctx,
			queries,
			current,
			principal.CanReadPerson(personID),
			principal.Has(authorization.PeopleReadMatriculation),
		)
		if err != nil {
			return Person{}, err
		}
		return result, tx.Commit(ctx)
	}
	if !assign && role.SystemKey != nil && authorization.SystemKey(*role.SystemKey) == authorization.SystemKeyMaster {
		if err := protectLastEnabledMaster(ctx, queries, personID); err != nil {
			return Person{}, err
		}
	}
	row, err := queries.BumpPersonVersion(
		ctx,
		peopledb.BumpPersonVersionParams{ID: personID, ExpectedVersion: expectedVersion},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Person{}, apperror.StaleWrite
	}
	if err != nil {
		return Person{}, err
	}
	var rows int64
	if assign {
		rows, err = queries.AssignPersonRole(
			ctx,
			peopledb.AssignPersonRoleParams{
				PersonID:            personID,
				RoleID:              roleID,
				AssignedByAccountID: &principal.AccountID,
			},
		)
	} else {
		rows, err = queries.RemovePersonRole(ctx, peopledb.RemovePersonRoleParams{PersonID: personID, RoleID: roleID})
	}
	if err != nil {
		return Person{}, err
	}
	if rows != 1 {
		return Person{}, apperror.StaleWrite
	}
	action := "person.role_removed"
	if assign {
		action = "person.role_assigned"
	}
	actor := principal.AccountID
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         action,
			ResourceType:   "person",
			ResourceID:     &personID,
			RequestID:      requestID,
			Metadata:       map[string]any{"roleId": roleID.String()},
		},
	); err != nil {
		return Person{}, err
	}
	result, err := loadPerson(
		ctx,
		queries,
		row,
		principal.CanReadPerson(personID),
		principal.Has(authorization.PeopleReadMatriculation),
	)
	if err != nil {
		return Person{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Person{}, err
	}
	return result, nil
}

// PromoteToSupervisor replaces a trainee's trainee roles with the configured supervisor role in one transaction.
// Every role added or removed passes the same privilege-subset check as an ordinary role assignment.
func (s *Service) PromoteToSupervisor(
	ctx context.Context,
	principal authorization.Principal,
	personID uuid.UUID,
	expectedVersion int64,
	requestID *uuid.UUID,
) (Person, error) {
	if !principal.Has(authorization.PeopleRolesAssign) {
		return Person{}, apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return Person{}, apperror.InvalidField("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Person{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := peopledb.New(tx)
	current, err := queries.GetPersonForDeletion(ctx, personID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Person{}, apperror.NotFound
	}
	if err != nil {
		return Person{}, err
	}
	if current.Version != expectedVersion {
		return Person{}, apperror.StaleWrite
	}
	supervisorRoleID, err := queries.GetPromotionSupervisorRole(ctx)
	if err != nil {
		return Person{}, err
	}
	notConfigured := apperror.Conflicting(
		"promotion_role_not_configured",
		"No supervisor role is configured for promotions",
	)
	if supervisorRoleID == nil {
		return Person{}, notConfigured
	}
	held, err := queries.ListPersonStaffingRoles(ctx, personID)
	if err != nil {
		return Person{}, err
	}
	var traineeRoleIDs []uuid.UUID
	for _, role := range held {
		switch roles.StaffingLevel(role.StaffingLevel) {
		case roles.StaffingSupervisor:
			return Person{}, apperror.Conflicting("not_a_trainee", "The person is not a trainee")
		case roles.StaffingTrainee:
			traineeRoleIDs = append(traineeRoleIDs, role.ID)
		}
	}
	if len(traineeRoleIDs) == 0 {
		return Person{}, apperror.Conflicting("not_a_trainee", "The person is not a trainee")
	}
	supervisorRole, err := authorizeRoleAssignment(ctx, queries, principal, *supervisorRoleID)
	if err != nil {
		return Person{}, err
	}
	if supervisorRole.StaffingLevel == nil || roles.StaffingLevel(*supervisorRole.StaffingLevel) != roles.StaffingSupervisor {
		return Person{}, notConfigured
	}
	for _, roleID := range traineeRoleIDs {
		if _, err := authorizeRoleAssignment(ctx, queries, principal, roleID); err != nil {
			return Person{}, err
		}
	}
	row, err := queries.BumpPersonVersion(
		ctx,
		peopledb.BumpPersonVersionParams{ID: personID, ExpectedVersion: expectedVersion},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Person{}, apperror.StaleWrite
	}
	if err != nil {
		return Person{}, err
	}
	for _, roleID := range traineeRoleIDs {
		if _, err := queries.RemovePersonRole(
			ctx,
			peopledb.RemovePersonRoleParams{PersonID: personID, RoleID: roleID},
		); err != nil {
			return Person{}, err
		}
	}
	if _, err := queries.AssignPersonRole(
		ctx,
		peopledb.AssignPersonRoleParams{
			PersonID:            personID,
			RoleID:              *supervisorRoleID,
			AssignedByAccountID: &principal.AccountID,
		},
	); err != nil {
		return Person{}, err
	}
	actor := principal.AccountID
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "person.promoted_to_supervisor",
			ResourceType:   "person",
			ResourceID:     &personID,
			RequestID:      requestID,
			ChangedFields:  []string{"roles"},
			Metadata:       map[string]any{"roleId": supervisorRoleID.String()},
		},
	); err != nil {
		return Person{}, err
	}
	result, err := loadPerson(
		ctx,
		queries,
		row,
		principal.CanReadPerson(personID),
		principal.Has(authorization.PeopleReadMatriculation),
	)
	if err != nil {
		return Person{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Person{}, err
	}
	return result, nil
}

// ValidateProvisionedRoleTransfer applies ordinary assignment and delegation
// rules to the source Person within the caller's reconciliation transaction.
// The system master role is never transferable through reconciliation.
func ValidateProvisionedRoleTransfer(
	ctx context.Context,
	tx pgx.Tx,
	principal authorization.Principal,
	sourcePersonID uuid.UUID,
) error {
	queries := peopledb.New(tx)
	roles, err := queries.ListPersonRoles(ctx, sourcePersonID)
	if err != nil {
		return err
	}
	for _, role := range roles {
		if role.SystemKey != nil && authorization.SystemKey(*role.SystemKey) == authorization.SystemKeyMaster {
			return apperror.New(
				http.StatusConflict,
				"master_role_transfer",
				"SCIM reconciliation cannot transfer the master role",
			)
		}
		if _, err := authorizeRoleAssignment(ctx, queries, principal, role.ID); err != nil {
			return err
		}
	}
	return nil
}

func protectLastEnabledMaster(ctx context.Context, queries *peopledb.Queries, personID uuid.UUID) error {
	if err := queries.AcquireMasterInvariantLock(ctx); err != nil {
		return err
	}
	account, err := queries.GetAccountByPersonForMutation(ctx, personID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if authorization.AccountStatus(account.Status) != authorization.AccountEnabled {
		return nil
	}
	count, err := queries.CountEnabledMasters(ctx)
	if err != nil {
		return err
	}
	if count <= 1 {
		return apperror.New(
			http.StatusConflict,
			"last_master_required",
			"At least one enabled master account must remain",
		)
	}
	return nil
}

func authorizeRoleAssignment(
	ctx context.Context,
	queries *peopledb.Queries,
	principal authorization.Principal,
	roleID uuid.UUID,
) (peopledb.Role, error) {
	if !principal.Has(authorization.PeopleRolesAssign) {
		return peopledb.Role{}, apperror.PermissionDenied
	}
	role, err := queries.GetRoleForAssignment(ctx, roleID)
	if errors.Is(err, pgx.ErrNoRows) {
		return peopledb.Role{}, apperror.NotFound
	}
	if err != nil {
		return peopledb.Role{}, err
	}
	permissions, err := queries.GetRolePermissionGrantsForAssignment(ctx, roleID)
	if err != nil {
		return peopledb.Role{}, err
	}
	if role.SystemKey != nil && authorization.SystemKey(*role.SystemKey) == authorization.SystemKeyMaster {
		if !principal.Master {
			return peopledb.Role{}, apperror.PermissionDenied
		}
		return role, nil
	}
	grants := map[uuid.UUID]authorization.PermissionGrant{}
	for _, permission := range permissions {
		permissionID := authorization.Permission(permission.PermissionID)
		if !authorization.Known(permissionID) {
			slog.WarnContext(
				ctx,
				"unknown stored permission blocked role assignment",
				"role_id",
				roleID,
				"permission_id",
				permission.PermissionID,
			)
			if !principal.Master {
				return peopledb.Role{}, apperror.PermissionDenied
			}
			continue
		}
		grant, exists := grants[permission.ID]
		if !exists {
			grant = authorization.PermissionGrant{
				ID:                  permission.ID,
				PermissionID:        permissionID,
				Scope:               authorization.GrantScope(permission.Scope),
				MinimumAssurance:    authorization.Assurance(permission.MinimumAssurance),
				ReauthWithinMinutes: authorization.ReauthWindowFromDB(permission.ReauthWithinMinutes),
			}
		}
		if permission.DeviceTypeID != nil {
			grant.DeviceTypeIDs = append(grant.DeviceTypeIDs, *permission.DeviceTypeID)
		}
		grants[permission.ID] = grant
	}
	for _, grant := range grants {
		if !principal.Master && !principal.CanDelegate(grant) {
			return peopledb.Role{}, apperror.PermissionDenied
		}
	}
	return role, nil
}

func NormalizeProfileImage(reader io.Reader) ([]byte, error) {
	raw, err := io.ReadAll(io.LimitReader(reader, MaxProfileImageBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 || len(raw) > MaxProfileImageBytes {
		return nil, apperror.New(
			http.StatusRequestEntityTooLarge,
			"profile_image_too_large",
			"Profile image exceeds 8 MiB",
		)
	}
	configuration, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || (format != "jpeg" && format != "png" && format != "webp") {
		return nil, apperror.InvalidField("profile image must be a valid JPEG, PNG, or WebP image")
	}
	if configuration.Width < 1 || configuration.Height < 1 || configuration.Width > 4096 ||
		configuration.Height > 4096 ||
		int64(configuration.Width)*int64(configuration.Height) > 16_000_000 {
		return nil, apperror.InvalidField("profile image dimensions exceed 4096x4096 or 16 megapixels")
	}
	decoded, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, apperror.InvalidField("profile image could not be decoded")
	}
	width, height := configuration.Width, configuration.Height
	if width > 1024 || height > 1024 {
		scale := math.Min(1024/float64(width), 1024/float64(height))
		width, height = int(float64(width)*scale), int(float64(height)*scale)
	}
	canvas := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.CatmullRom.Scale(canvas, canvas.Bounds(), decoded, decoded.Bounds(), draw.Over, nil)
	var output bytes.Buffer
	if err := jpeg.Encode(&output, canvas, &jpeg.Options{Quality: 88}); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func normalizeProfileImage(reader io.Reader) ([]byte, error) { return NormalizeProfileImage(reader) }

func validate(firstName, lastName string, email, phone, matriculation *string) error {
	firstName, lastName = strings.TrimSpace(firstName), strings.TrimSpace(lastName)
	if firstName == "" || lastName == "" || len([]rune(firstName)) > 100 || len([]rune(lastName)) > 100 {
		return apperror.InvalidField("firstName and lastName are required and limited to 100 characters")
	}
	if email == nil && phone == nil {
		return apperror.InvalidField("at least one contact method is required")
	}
	if email != nil {
		if _, _, err := security.NormalizeEmail(*email); err != nil {
			return apperror.InvalidField("email is invalid")
		}
	}
	if phone != nil && (strings.TrimSpace(*phone) == "" || len([]rune(*phone)) > 64) {
		return apperror.InvalidField("phone is invalid")
	}
	if matriculation != nil && (strings.TrimSpace(*matriculation) == "" || len([]rune(*matriculation)) > 64) {
		return apperror.InvalidField("matriculationNumber is invalid")
	}
	return nil
}

// ErrEmailManagedByAccount rejects a plain person update of the email of someone who has an Account: the
// person's email is the Account's login email and changes only through the login-email operation, which
// carries its own permission, uniqueness check and session/reset-token handling.
var ErrEmailManagedByAccount = apperror.New(
	http.StatusUnprocessableEntity,
	"email_managed_by_account",
	"This person has an account; change the email with the account's login email instead.",
)

// validateMemberSince accepts days from 1900 up to tomorrow (UTC), tolerating a client ahead of UTC.
func validateMemberSince(day, now time.Time) error {
	latest := dates.FromTime(now.AddDate(0, 0, 1)).Time
	if day.Year() < 1900 || day.After(latest) {
		return apperror.InvalidField("memberSince must be a past or current date")
	}
	return nil
}

func fromRow(row peopledb.Person, includeDetails, includeMatriculation bool) Person {
	email, phone, photoReference := row.Email, row.Phone, row.PhotoReference
	if !includeDetails {
		email = nil
		phone = nil
		photoReference = nil
	}
	matriculation := row.MatriculationNumber
	if !includeDetails || !includeMatriculation {
		matriculation = nil
	}
	return Person{ID: row.ID, FirstName: row.FirstName, LastName: row.LastName, Email: email, Phone: phone,
		MatriculationNumber: matriculation, PhotoReference: photoReference, ProfileImageFileID: row.ProfileImageFileID,
		ProfileImageSource: optional.Convert[ProfileImageSource](row.ProfileImageSource),
		Roles:              []RoleSummary{},
		MemberSince:        row.MemberSince.Time,
		Version:            row.Version,
		CreatedAt:          row.CreatedAt,
		UpdatedAt:          row.UpdatedAt}
}

func loadPerson(
	ctx context.Context,
	queries *peopledb.Queries,
	row peopledb.Person,
	includeDetails, includeMatriculation bool,
) (Person, error) {
	person := fromRow(row, includeDetails, includeMatriculation)
	roles, err := queries.ListPersonRoles(ctx, row.ID)
	if err != nil {
		return Person{}, err
	}
	for _, role := range roles {
		person.Roles = append(person.Roles, RoleSummary{ID: role.ID, Name: role.Name, SystemKey: optional.Convert[authorization.SystemKey](role.SystemKey)})
	}
	return person, nil
}

func hydratePeopleRoles(ctx context.Context, queries *peopledb.Queries, people []Person, personIDs []uuid.UUID) error {
	if len(personIDs) == 0 {
		return nil
	}
	indexByID := make(map[uuid.UUID]int, len(people))
	for index := range people {
		indexByID[people[index].ID] = index
	}
	rows, err := queries.ListPersonRolesByPeople(ctx, uuidStrings(personIDs))
	if err != nil {
		return err
	}
	for _, row := range rows {
		index := indexByID[row.PersonID]
		people[index].Roles = append(
			people[index].Roles,
			RoleSummary{ID: row.ID, Name: row.Name, SystemKey: optional.Convert[authorization.SystemKey](row.SystemKey)},
		)
	}
	return nil
}

func uuidStrings(ids []uuid.UUID) []string {
	values := make([]string, len(ids))
	for index, id := range ids {
		values[index] = id.String()
	}
	return values
}

func changedFields(current peopledb.Person, firstName, lastName string, email, phone, matriculation *string) []string {
	changed := make([]string, 0, 5)
	if current.FirstName != firstName {
		changed = append(changed, "firstName")
	}
	if current.LastName != lastName {
		changed = append(changed, "lastName")
	}
	if !sameString(current.Email, email) {
		changed = append(changed, "email")
	}
	if !sameString(current.Phone, phone) {
		changed = append(changed, "phone")
	}
	if !sameString(current.MatriculationNumber, matriculation) {
		changed = append(changed, "matriculationNumber")
	}
	return changed
}

func sameString(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func databaseError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && (pgErr.Code == "23505" || pgErr.Code == "23503") {
		return apperror.Conflict
	}
	return err
}

func invalidRequest(reason string) *apperror.Error {
	err := apperror.New(http.StatusBadRequest, "invalid_request", "Request is invalid")
	err.Details["reason"] = reason
	return err
}
