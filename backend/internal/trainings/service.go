package trainings

import (
	"context"
	"errors"
	"slices"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"
	trainingsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/trainings/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	maxCategoryNameRunes = 120
	maxTrainingNameRunes = 150
	maxDescriptionRunes  = 2000
	maxSortOrder         = 10000
	maxCompetencyLinks   = 50
	maxMachineTypeLinks  = 100
)

// Service owns trainings, competency categories and training records.
type Service struct {
	pool *pgxpool.Pool
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

// canReadCatalog lets everybody who maintains or reads training records see the trainings and categories.
func canReadCatalog(p authorization.Principal) bool {
	return p.Has(authorization.TrainingsManage) || p.Has(authorization.TrainingRecordsReadAll) ||
		p.Has(authorization.TrainingRecordsReadSelf)
}

func (s *Service) ListCompetencyCategories(ctx context.Context, p authorization.Principal) ([]CompetencyCategory, error) {
	if !canReadCatalog(p) {
		return nil, apperror.PermissionDenied
	}
	rows, err := trainingsdb.New(s.pool).ListCompetencyCategories(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]CompetencyCategory, 0, len(rows))
	for _, row := range rows {
		items = append(items, categoryFromRow(trainingsdb.GetCompetencyCategoryRow(row)))
	}
	return items, nil
}

// The mutations below come in pairs: the plain method runs in its own transaction, the Tx variant inside the
// caller's (the configuration import uses those).

func (s *Service) CreateCompetencyCategory(
	ctx context.Context,
	p authorization.Principal,
	input CompetencyCategoryInput,
	requestID *uuid.UUID,
) (result CompetencyCategory, err error) {
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.CreateCompetencyCategoryTx(ctx, tx, p, input, requestID)
		return err
	})
	return result, err
}

func (s *Service) CreateCompetencyCategoryTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	input CompetencyCategoryInput,
	requestID *uuid.UUID,
) (CompetencyCategory, error) {
	if !p.Has(authorization.TrainingsManage) {
		return CompetencyCategory{}, apperror.PermissionDenied
	}
	input, err := validateCategory(input)
	if err != nil {
		return CompetencyCategory{}, err
	}
	id := ids.New()
	q := trainingsdb.New(tx)
	if err := q.CreateCompetencyCategory(ctx, trainingsdb.CreateCompetencyCategoryParams{
		ID: id, Name: input.Name, Description: input.Description, Active: input.Active, SortOrder: input.SortOrder,
	}); err != nil {
		return CompetencyCategory{}, nameConflict(
			err, "competency_category_exists", "A competency category with this name already exists",
		)
	}
	if err := writeAudit(ctx, tx, p, "competency_category.created", "competency_category", id, requestID,
		[]string{"name", "description", "active", "sortOrder"}); err != nil {
		return CompetencyCategory{}, err
	}
	row, err := q.GetCompetencyCategory(ctx, id)
	return categoryFromRow(row), err
}

func (s *Service) UpdateCompetencyCategory(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	input CompetencyCategoryInput,
	requestID *uuid.UUID,
) (result CompetencyCategory, err error) {
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.UpdateCompetencyCategoryTx(ctx, tx, p, id, expected, input, requestID)
		return err
	})
	return result, err
}

func (s *Service) UpdateCompetencyCategoryTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	input CompetencyCategoryInput,
	requestID *uuid.UUID,
) (CompetencyCategory, error) {
	if !p.Has(authorization.TrainingsManage) {
		return CompetencyCategory{}, apperror.PermissionDenied
	}
	if expected < 1 {
		return CompetencyCategory{}, apperror.Invalid("expectedVersion must be positive")
	}
	input, err := validateCategory(input)
	if err != nil {
		return CompetencyCategory{}, err
	}
	q := trainingsdb.New(tx)
	current, err := q.GetCompetencyCategoryForUpdate(ctx, id)
	if err != nil {
		return CompetencyCategory{}, noRows(err)
	}
	if current.Version != expected {
		return CompetencyCategory{}, apperror.StaleWrite
	}
	if _, err := q.UpdateCompetencyCategory(ctx, trainingsdb.UpdateCompetencyCategoryParams{
		Name: input.Name, Description: input.Description, Active: input.Active, SortOrder: input.SortOrder,
		ID: id, ExpectedVersion: expected,
	}); err != nil {
		return CompetencyCategory{}, nameConflict(
			err, "competency_category_exists", "A competency category with this name already exists",
		)
	}
	if err := writeAudit(ctx, tx, p, "competency_category.updated", "competency_category", id, requestID,
		changedCategoryFields(current, input)); err != nil {
		return CompetencyCategory{}, err
	}
	row, err := q.GetCompetencyCategory(ctx, id)
	return categoryFromRow(row), err
}

// DeleteCompetencyCategory hard-deletes a category no training feeds; one in use answers 409
// competency_category_in_use and should be deactivated instead.
func (s *Service) DeleteCompetencyCategory(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		return s.DeleteCompetencyCategoryTx(ctx, tx, p, id, expected, requestID)
	})
}

func (s *Service) DeleteCompetencyCategoryTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	if !p.Has(authorization.TrainingsManage) {
		return apperror.PermissionDenied
	}
	if expected < 1 {
		return apperror.Invalid("expectedVersion must be positive")
	}
	q := trainingsdb.New(tx)
	current, err := q.GetCompetencyCategoryForUpdate(ctx, id)
	if err != nil {
		return noRows(err)
	}
	if current.Version != expected {
		return apperror.StaleWrite
	}
	usage, err := q.GetCompetencyCategory(ctx, id)
	if err != nil {
		return err
	}
	if usage.TrainingCount > 0 {
		return apperror.Conflicting(
			"competency_category_in_use",
			"Trainings feed this competency category and it cannot be deleted; deactivate it instead",
		)
	}
	if _, err := q.DeleteCompetencyCategory(
		ctx,
		trainingsdb.DeleteCompetencyCategoryParams{ID: id, ExpectedVersion: expected},
	); err != nil {
		return err
	}
	return writeAudit(ctx, tx, p, "competency_category.deleted", "competency_category", id, requestID, nil)
}

func (s *Service) ListTrainings(ctx context.Context, p authorization.Principal) ([]Training, error) {
	if !canReadCatalog(p) {
		return nil, apperror.PermissionDenied
	}
	q := trainingsdb.New(s.pool)
	rows, err := q.ListTrainings(ctx)
	if err != nil {
		return nil, err
	}
	trainingIDs := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		trainingIDs = append(trainingIDs, row.ID)
	}
	links, err := loadLinks(ctx, q, trainingIDs)
	if err != nil {
		return nil, err
	}
	items := make([]Training, 0, len(rows))
	for _, row := range rows {
		items = append(items, trainingFromRow(trainingsdb.GetTrainingRow(row), links))
	}
	return items, nil
}

func (s *Service) CreateTraining(
	ctx context.Context,
	p authorization.Principal,
	input TrainingInput,
	requestID *uuid.UUID,
) (result Training, err error) {
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.CreateTrainingTx(ctx, tx, p, input, requestID)
		return err
	})
	return result, err
}

func (s *Service) CreateTrainingTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	input TrainingInput,
	requestID *uuid.UUID,
) (Training, error) {
	if !p.Has(authorization.TrainingsManage) {
		return Training{}, apperror.PermissionDenied
	}
	input, err := validateTraining(input)
	if err != nil {
		return Training{}, err
	}
	id := ids.New()
	q := trainingsdb.New(tx)
	if err := q.CreateTraining(ctx, trainingsdb.CreateTrainingParams{
		ID: id, Name: input.Name, Description: input.Description, Active: input.Active, SortOrder: input.SortOrder,
	}); err != nil {
		return Training{}, nameConflict(err, "training_exists", "A training with this name already exists")
	}
	if err := replaceLinks(ctx, q, id, input); err != nil {
		return Training{}, err
	}
	if err := writeAudit(ctx, tx, p, "training.created", "training", id, requestID,
		[]string{"name", "description", "active", "sortOrder", "competencyIds", "machineTypeIds"}); err != nil {
		return Training{}, err
	}
	return getTraining(ctx, q, id)
}

func (s *Service) UpdateTraining(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	input TrainingInput,
	requestID *uuid.UUID,
) (result Training, err error) {
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.UpdateTrainingTx(ctx, tx, p, id, expected, input, requestID)
		return err
	})
	return result, err
}

func (s *Service) UpdateTrainingTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	input TrainingInput,
	requestID *uuid.UUID,
) (Training, error) {
	if !p.Has(authorization.TrainingsManage) {
		return Training{}, apperror.PermissionDenied
	}
	if expected < 1 {
		return Training{}, apperror.Invalid("expectedVersion must be positive")
	}
	input, err := validateTraining(input)
	if err != nil {
		return Training{}, err
	}
	q := trainingsdb.New(tx)
	current, err := q.GetTrainingForUpdate(ctx, id)
	if err != nil {
		return Training{}, noRows(err)
	}
	if current.Version != expected {
		return Training{}, apperror.StaleWrite
	}
	before, err := getTraining(ctx, q, id)
	if err != nil {
		return Training{}, err
	}
	if _, err := q.UpdateTraining(ctx, trainingsdb.UpdateTrainingParams{
		Name: input.Name, Description: input.Description, Active: input.Active, SortOrder: input.SortOrder,
		ID: id, ExpectedVersion: expected,
	}); err != nil {
		return Training{}, nameConflict(err, "training_exists", "A training with this name already exists")
	}
	if err := replaceLinks(ctx, q, id, input); err != nil {
		return Training{}, err
	}
	if err := writeAudit(ctx, tx, p, "training.updated", "training", id, requestID,
		changedTrainingFields(before, input)); err != nil {
		return Training{}, err
	}
	return getTraining(ctx, q, id)
}

// DeleteTraining hard-deletes a training nobody holds a record of; one with records answers 409 training_in_use and
// should be deactivated instead, so the records stay.
func (s *Service) DeleteTraining(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		return s.DeleteTrainingTx(ctx, tx, p, id, expected, requestID)
	})
}

func (s *Service) DeleteTrainingTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	if !p.Has(authorization.TrainingsManage) {
		return apperror.PermissionDenied
	}
	if expected < 1 {
		return apperror.Invalid("expectedVersion must be positive")
	}
	q := trainingsdb.New(tx)
	current, err := q.GetTrainingForUpdate(ctx, id)
	if err != nil {
		return noRows(err)
	}
	if current.Version != expected {
		return apperror.StaleWrite
	}
	usage, err := q.GetTraining(ctx, id)
	if err != nil {
		return err
	}
	if usage.RecordCount > 0 {
		return apperror.Conflicting(
			"training_in_use",
			"People hold records of this training and it cannot be deleted; deactivate it instead",
		)
	}
	if _, err := q.DeleteTraining(ctx, trainingsdb.DeleteTrainingParams{ID: id, ExpectedVersion: expected}); err != nil {
		return err
	}
	return writeAudit(ctx, tx, p, "training.deleted", "training", id, requestID, nil)
}

func validateCategory(input CompetencyCategoryInput) (CompetencyCategoryInput, error) {
	name, err := validateName(input.Name, maxCategoryNameRunes)
	if err != nil {
		return input, err
	}
	input.Name = name
	if input.Description, err = validateDescription(input.Description); err != nil {
		return input, err
	}
	if input.SortOrder < -maxSortOrder || input.SortOrder > maxSortOrder {
		return input, apperror.Invalid("sortOrder must be between -10000 and 10000")
	}
	return input, nil
}

func validateTraining(input TrainingInput) (TrainingInput, error) {
	name, err := validateName(input.Name, maxTrainingNameRunes)
	if err != nil {
		return input, err
	}
	input.Name = name
	if input.Description, err = validateDescription(input.Description); err != nil {
		return input, err
	}
	if input.SortOrder < -maxSortOrder || input.SortOrder > maxSortOrder {
		return input, apperror.Invalid("sortOrder must be between -10000 and 10000")
	}
	input.CompetencyIDs = distinct(input.CompetencyIDs)
	input.MachineTypeIDs = distinct(input.MachineTypeIDs)
	if len(input.CompetencyIDs) > maxCompetencyLinks || len(input.MachineTypeIDs) > maxMachineTypeLinks {
		return input, apperror.Invalid("a training links at most 50 competency categories and 100 machine types")
	}
	return input, nil
}

func validateName(name string, limit int) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > limit {
		return "", apperror.Invalid("name is required and limited in length")
	}
	return name, nil
}

func validateDescription(description *string) (*string, error) {
	return validateText(description, maxDescriptionRunes, "description")
}

// validateText trims optional text; blank text becomes nil.
func validateText(value *string, limit int, field string) (*string, error) {
	value = optional.Trimmed(value)
	if value != nil && len([]rune(*value)) > limit {
		return nil, apperror.Invalid(field + " is too long")
	}
	return value, nil
}

func distinct(values []uuid.UUID) []uuid.UUID {
	result := make([]uuid.UUID, 0, len(values))
	for _, value := range values {
		if !slices.Contains(result, value) {
			result = append(result, value)
		}
	}
	slices.SortFunc(result, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	return result
}

// replaceLinks stores the training's competency categories and machine types. Unknown IDs are a validation error.
func replaceLinks(ctx context.Context, q *trainingsdb.Queries, id uuid.UUID, input TrainingInput) error {
	categories, err := q.CountExistingCompetencyCategories(ctx, input.CompetencyIDs)
	if err != nil {
		return err
	}
	if categories != int64(len(input.CompetencyIDs)) {
		return apperror.Invalid("competencyIds contains an unknown competency category")
	}
	machineTypes, err := q.CountExistingMachineTypes(ctx, input.MachineTypeIDs)
	if err != nil {
		return err
	}
	if machineTypes != int64(len(input.MachineTypeIDs)) {
		return apperror.Invalid("machineTypeIds contains an unknown machine type")
	}
	if err := q.DeleteTrainingCompetencies(ctx, id); err != nil {
		return err
	}
	for _, competencyID := range input.CompetencyIDs {
		if err := q.InsertTrainingCompetency(ctx, trainingsdb.InsertTrainingCompetencyParams{
			TrainingID: id, CompetencyID: competencyID,
		}); err != nil {
			return err
		}
	}
	if err := q.DeleteTrainingMachineTypes(ctx, id); err != nil {
		return err
	}
	for _, machineTypeID := range input.MachineTypeIDs {
		if err := q.InsertTrainingMachineType(ctx, trainingsdb.InsertTrainingMachineTypeParams{
			TrainingID: id, MachineTypeID: machineTypeID,
		}); err != nil {
			return err
		}
	}
	return nil
}

type trainingLinks struct {
	competencies, machineTypes map[uuid.UUID][]uuid.UUID
}

func loadLinks(ctx context.Context, q *trainingsdb.Queries, trainingIDs []uuid.UUID) (trainingLinks, error) {
	links := trainingLinks{competencies: map[uuid.UUID][]uuid.UUID{}, machineTypes: map[uuid.UUID][]uuid.UUID{}}
	competencies, err := q.ListTrainingCompetencies(ctx, trainingIDs)
	if err != nil {
		return links, err
	}
	for _, row := range competencies {
		links.competencies[row.TrainingID] = append(links.competencies[row.TrainingID], row.CompetencyID)
	}
	machineTypes, err := q.ListTrainingMachineTypes(ctx, trainingIDs)
	if err != nil {
		return links, err
	}
	for _, row := range machineTypes {
		links.machineTypes[row.TrainingID] = append(links.machineTypes[row.TrainingID], row.MachineTypeID)
	}
	return links, nil
}

// TrainingTx loads one training with its links inside the caller's transaction; the caller authorizes.
func (s *Service) TrainingTx(ctx context.Context, tx pgx.Tx, id uuid.UUID) (Training, error) {
	return getTraining(ctx, trainingsdb.New(tx), id)
}

func getTraining(ctx context.Context, q *trainingsdb.Queries, id uuid.UUID) (Training, error) {
	row, err := q.GetTraining(ctx, id)
	if err != nil {
		return Training{}, noRows(err)
	}
	links, err := loadLinks(ctx, q, []uuid.UUID{id})
	if err != nil {
		return Training{}, err
	}
	return trainingFromRow(row, links), nil
}

func trainingFromRow(row trainingsdb.GetTrainingRow, links trainingLinks) Training {
	competencyIDs := links.competencies[row.ID]
	if competencyIDs == nil {
		competencyIDs = []uuid.UUID{}
	}
	machineTypeIDs := links.machineTypes[row.ID]
	if machineTypeIDs == nil {
		machineTypeIDs = []uuid.UUID{}
	}
	return Training{
		ID:             row.ID,
		Name:           row.Name,
		Description:    row.Description,
		Active:         row.Active,
		SortOrder:      row.SortOrder,
		CompetencyIDs:  competencyIDs,
		MachineTypeIDs: machineTypeIDs,
		RecordCount:    row.RecordCount,
		Version:        row.Version,
		CreatedAt:      row.CreatedAt,
		UpdatedAt:      row.UpdatedAt,
	}
}

func categoryFromRow(row trainingsdb.GetCompetencyCategoryRow) CompetencyCategory {
	return CompetencyCategory{
		ID:            row.ID,
		Name:          row.Name,
		Description:   row.Description,
		Active:        row.Active,
		SortOrder:     row.SortOrder,
		TrainingCount: row.TrainingCount,
		Version:       row.Version,
		CreatedAt:     row.CreatedAt,
		UpdatedAt:     row.UpdatedAt,
	}
}

func changedCategoryFields(current trainingsdb.CompetencyCategory, input CompetencyCategoryInput) []string {
	var changed []string
	if current.Name != input.Name {
		changed = append(changed, "name")
	}
	if !equalText(current.Description, input.Description) {
		changed = append(changed, "description")
	}
	if current.Active != input.Active {
		changed = append(changed, "active")
	}
	if current.SortOrder != input.SortOrder {
		changed = append(changed, "sortOrder")
	}
	return changed
}

func changedTrainingFields(current Training, input TrainingInput) []string {
	var changed []string
	if current.Name != input.Name {
		changed = append(changed, "name")
	}
	if !equalText(current.Description, input.Description) {
		changed = append(changed, "description")
	}
	if current.Active != input.Active {
		changed = append(changed, "active")
	}
	if current.SortOrder != input.SortOrder {
		changed = append(changed, "sortOrder")
	}
	if !slices.Equal(distinct(current.CompetencyIDs), input.CompetencyIDs) {
		changed = append(changed, "competencyIds")
	}
	if !slices.Equal(distinct(current.MachineTypeIDs), input.MachineTypeIDs) {
		changed = append(changed, "machineTypeIds")
	}
	return changed
}

func equalText(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func nameConflict(err error, code, message string) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return apperror.Conflicting(code, message)
	}
	return err
}

func noRows(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	return err
}

func writeAudit(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	action, resource string,
	id uuid.UUID,
	requestID *uuid.UUID,
	fields []string,
) error {
	return audit.Write(ctx, tx, audit.Event{
		ActorAccountID: accountPointer(p),
		Action:         action,
		ResourceType:   resource,
		ResourceID:     &id,
		RequestID:      requestID,
		ChangedFields:  fields,
	})
}
