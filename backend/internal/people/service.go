package people

import (
	"context"
	"errors"
	"math"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accounts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	peopledb "github.com/Basmatireis/Makerspace-Core/backend/internal/people/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Person struct {
	ID                  uuid.UUID
	FirstName           string
	LastName            string
	Email               *string
	Phone               *string
	MatriculationNumber *string
	PhotoReference      *string
	Version             int64
	CreatedAt           time.Time
	UpdatedAt           time.Time
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
}

type Page struct {
	Items    []Person
	Page     int
	PageSize int
	Total    int64
}

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func (s *Service) Create(ctx context.Context, principal authorization.Principal, input CreateInput, requestID *uuid.UUID) (Person, error) {
	if !principal.Has(authorization.PeopleCreate) {
		return Person{}, apperror.PermissionDenied
	}
	email := cleanOptional(input.Email)
	phone := cleanOptional(input.Phone)
	matriculation := cleanOptional(input.MatriculationNumber)
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
	id := uuid.Must(uuid.NewV7())
	row, err := peopledb.New(tx).CreatePerson(ctx, peopledb.CreatePersonParams{
		ID: id, FirstName: strings.TrimSpace(input.FirstName), LastName: strings.TrimSpace(input.LastName),
		Email: email, Phone: phone, MatriculationNumber: matriculation, PhotoReference: nil,
	})
	if err != nil {
		return Person{}, databaseError(err)
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "person.created", ResourceType: "person", ResourceID: &id, RequestID: requestID}); err != nil {
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
	return fromRow(row, true, principal.Has(authorization.PeopleReadMatriculation)), nil
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
	return fromRow(row, includeDetails, includeDetails && principal.Has(authorization.PeopleReadMatriculation)), nil
}

func (s *Service) List(ctx context.Context, principal authorization.Principal, page, pageSize int, search string) (Page, error) {
	if !principal.Has(authorization.PeopleReadAll) {
		return Page{}, apperror.PermissionDenied
	}
	if page < 1 || pageSize < 1 || pageSize > 100 || page > math.MaxInt32/pageSize || !utf8.ValidString(search) || utf8.RuneCountInString(search) > 200 {
		return Page{}, invalidRequest("invalid pagination or search")
	}
	params := peopledb.ListPeopleParams{Search: search, IncludeMatriculation: principal.Has(authorization.PeopleReadMatriculation), PageLimit: int32(pageSize), PageOffset: int32((page - 1) * pageSize)}
	queries := peopledb.New(s.pool)
	rows, err := queries.ListPeople(ctx, params)
	if err != nil {
		return Page{}, err
	}
	total, err := queries.CountPeople(ctx, peopledb.CountPeopleParams{Search: params.Search, IncludeMatriculation: params.IncludeMatriculation})
	if err != nil {
		return Page{}, err
	}
	items := make([]Person, 0, len(rows))
	for _, row := range rows {
		items = append(items, fromRow(row, true, params.IncludeMatriculation))
	}
	return Page{Items: items, Page: page, PageSize: pageSize, Total: total}, nil
}

func (s *Service) Update(ctx context.Context, principal authorization.Principal, id uuid.UUID, input UpdateInput, requestID *uuid.UUID) (Person, error) {
	if !principal.CanUpdatePerson(id) {
		return Person{}, apperror.PermissionDenied
	}
	if input.MatriculationNumber.Set && !principal.Has(authorization.PeopleUpdateMatriculation) {
		return Person{}, apperror.PermissionDenied
	}
	if input.ExpectedVersion < 1 || (input.FirstName == nil && input.LastName == nil && !input.Email.Set && !input.Phone.Set && !input.MatriculationNumber.Set) {
		return Person{}, validation("at least one field and a valid expectedVersion are required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Person{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := peopledb.New(tx)
	current, err := queries.GetPerson(ctx, id)
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
		email = cleanOptional(input.Email.Value)
	}
	if input.Phone.Set {
		phone = cleanOptional(input.Phone.Value)
	}
	if input.MatriculationNumber.Set {
		matriculation = cleanOptional(input.MatriculationNumber.Value)
	}
	if err := validate(firstName, lastName, email, phone, matriculation); err != nil {
		return Person{}, err
	}
	changed := changedFields(current, firstName, lastName, email, phone, matriculation)
	row, err := queries.UpdatePerson(ctx, peopledb.UpdatePersonParams{
		ID: id, ExpectedVersion: input.ExpectedVersion, FirstName: firstName, LastName: lastName,
		Email: email, Phone: phone, MatriculationNumber: matriculation, PhotoReference: current.PhotoReference,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Person{}, apperror.StaleWrite
	}
	if err != nil {
		return Person{}, databaseError(err)
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "person.updated", ResourceType: "person", ResourceID: &id, RequestID: requestID, ChangedFields: changed}); err != nil {
		return Person{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Person{}, err
	}
	return fromRow(row, principal.CanReadPerson(id), principal.Has(authorization.PeopleReadMatriculation)), nil
}

func (s *Service) Delete(ctx context.Context, principal authorization.Principal, id uuid.UUID, expectedVersion int64, requestID *uuid.UUID) error {
	if !principal.Has(authorization.PeopleDelete) {
		return apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return validation("expectedVersion must be positive")
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
	if err := accounts.AuthorizePersonDeletion(ctx, tx, principal, id); err != nil {
		return err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "person.deleted", ResourceType: "person", ResourceID: &id, RequestID: requestID}); err != nil {
		return err
	}
	if _, err := peopleQueries.DeletePerson(ctx, peopledb.DeletePersonParams{ID: id, ExpectedVersion: expectedVersion}); errors.Is(err, pgx.ErrNoRows) {
		return apperror.StaleWrite
	} else if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func validate(firstName, lastName string, email, phone, matriculation *string) error {
	firstName, lastName = strings.TrimSpace(firstName), strings.TrimSpace(lastName)
	if firstName == "" || lastName == "" || len([]rune(firstName)) > 100 || len([]rune(lastName)) > 100 {
		return validation("firstName and lastName are required and limited to 100 characters")
	}
	if email == nil && phone == nil {
		return validation("at least one contact method is required")
	}
	if email != nil {
		if _, _, err := security.NormalizeEmail(*email); err != nil {
			return validation("email is invalid")
		}
	}
	if phone != nil && (strings.TrimSpace(*phone) == "" || len([]rune(*phone)) > 64) {
		return validation("phone is invalid")
	}
	if matriculation != nil && (strings.TrimSpace(*matriculation) == "" || len([]rune(*matriculation)) > 64) {
		return validation("matriculationNumber is invalid")
	}
	return nil
}

func cleanOptional(value *string) *string {
	if value == nil {
		return nil
	}
	clean := strings.TrimSpace(*value)
	if clean == "" {
		return nil
	}
	return &clean
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
		MatriculationNumber: matriculation, PhotoReference: photoReference, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
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

func validation(reason string) *apperror.Error {
	err := apperror.New(422, "validation_failed", "Request validation failed")
	err.Details["reason"] = reason
	return err
}

func invalidRequest(reason string) *apperror.Error {
	err := apperror.New(400, "invalid_request", "Request is invalid")
	err.Details["reason"] = reason
	return err
}
