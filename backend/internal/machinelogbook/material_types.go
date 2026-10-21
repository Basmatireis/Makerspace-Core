package machinelogbook

import (
	"context"
	"errors"
	"regexp"
	"slices"
	"sort"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var colorHexPattern = regexp.MustCompile(`^#[0-9A-F]{6}$`)

func materialTypeFromList(row machinelogbookdb.ListMaterialTypesRow, processes []string) MaterialType {
	if processes == nil {
		processes = []string{}
	}
	return MaterialType{
		ID:               row.ID,
		Name:             row.Name,
		Kind:             MaterialKind(row.Kind),
		Unit:             row.Unit,
		Processes:        processes,
		Active:           row.Active,
		MaterialCount:    row.MaterialCount,
		PricingRuleCount: row.PricingRuleCount,
		Version:          row.Version,
		CreatedAt:        row.CreatedAt,
		UpdatedAt:        row.UpdatedAt,
	}
}

func validateMaterialTypeName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 120 {
		return "", apperror.Invalid("name is required and limited to 120 characters")
	}
	return name, nil
}

// validateProcesses checks a type's process list: at least one, all known, no
// duplicates. The result is ordered like machineProcesses.
func validateProcesses(processes []string) ([]string, error) {
	if len(processes) == 0 {
		return nil, apperror.Invalid("at least one process is required")
	}
	chosen := map[string]bool{}
	for _, process := range processes {
		if !validProcess(process) {
			return nil, apperror.Invalid("invalid process")
		}
		chosen[process] = true
	}
	ordered := make([]string, 0, len(chosen))
	for _, process := range machineProcesses {
		if chosen[process] {
			ordered = append(ordered, process)
		}
	}
	return ordered, nil
}

func validMaterialKind(kind MaterialKind) bool {
	return kind == KindFilament || kind == KindConsumable || kind == KindPart
}

// shapeMaterialType checks unit and processes against the kind and returns the
// normalised process list: filament is measured in grams and serves FDM
// printing (the default), possibly next to other processes, a consumable
// serves at least one process, a part serves none, so it can never be used in
// a machine run.
func shapeMaterialType(kind MaterialKind, unit string, processes []string) ([]string, error) {
	switch kind {
	case KindFilament:
		if MaterialUnit(unit) != UnitGram {
			return nil, apperror.Invalid("filament material types are measured in grams")
		}
		if len(processes) == 0 {
			return []string{ProcessFDMPrinting}, nil
		}
		ordered, err := validateProcesses(processes)
		if err != nil {
			return nil, err
		}
		if !slices.Contains(ordered, ProcessFDMPrinting) {
			return nil, apperror.Invalid("filament material types serve the process fdm_printing")
		}
		return ordered, nil
	case KindConsumable:
		return validateProcesses(processes)
	case KindPart:
		if len(processes) > 0 {
			return nil, apperror.Invalid("part material types take no processes")
		}
		return []string{}, nil
	}
	return nil, apperror.Invalid("invalid material kind")
}

// materialTypeProcesses loads the processes of the given types.
func materialTypeProcesses(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	ids []uuid.UUID,
) (map[uuid.UUID][]string, error) {
	rows, err := q.ListMaterialTypeProcesses(ctx, ids)
	if err != nil {
		return nil, err
	}
	byType := map[uuid.UUID][]string{}
	for _, row := range rows {
		byType[row.MaterialTypeID] = append(byType[row.MaterialTypeID], row.Process)
	}
	for _, list := range byType {
		sort.Slice(list, func(i, j int) bool { return processRank(list[i]) < processRank(list[j]) })
	}
	return byType, nil
}

func processRank(process string) int {
	for i, candidate := range machineProcesses {
		if candidate == process {
			return i
		}
	}
	return len(machineProcesses)
}

func replaceMaterialTypeProcesses(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	id uuid.UUID,
	processes []string,
) error {
	if err := q.DeleteMaterialTypeProcesses(ctx, id); err != nil {
		return err
	}
	for _, process := range processes {
		if err := q.InsertMaterialTypeProcess(
			ctx,
			machinelogbookdb.InsertMaterialTypeProcessParams{MaterialTypeID: id, Process: process},
		); err != nil {
			return databaseError(err)
		}
	}
	return nil
}

func materialTypeConflict(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return apperror.Conflicting("material_type_exists", "A material type with this name already exists")
	}
	return databaseError(err)
}

// ListMaterialTypes returns every material type, active ones first. The
// catalogue is small, so it is not paged.
func (s *Service) ListMaterialTypes(ctx context.Context, p authorization.Principal) ([]MaterialType, error) {
	if err := require(p, authorization.InventoryRead); err != nil {
		return nil, err
	}
	rows, err := machinelogbookdb.New(s.pool).ListMaterialTypes(ctx)
	if err != nil {
		return nil, err
	}
	ids := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	processes, err := materialTypeProcesses(ctx, machinelogbookdb.New(s.pool), ids)
	if err != nil {
		return nil, err
	}
	items := make([]MaterialType, 0, len(rows))
	for _, row := range rows {
		items = append(items, materialTypeFromList(row, processes[row.ID]))
	}
	return items, nil
}

func (s *Service) GetMaterialType(ctx context.Context, p authorization.Principal, id uuid.UUID) (MaterialType, error) {
	if err := require(p, authorization.InventoryRead); err != nil {
		return MaterialType{}, err
	}
	q := machinelogbookdb.New(s.pool)
	row, err := q.GetMaterialType(ctx, id)
	if err != nil {
		return MaterialType{}, noRows(err)
	}
	processes, err := materialTypeProcesses(ctx, q, []uuid.UUID{id})
	if err != nil {
		return MaterialType{}, err
	}
	return materialTypeFromList(machinelogbookdb.ListMaterialTypesRow(row), processes[id]), nil
}

func (s *Service) CreateMaterialType(
	ctx context.Context,
	p authorization.Principal,
	name string,
	kind MaterialKind,
	unit string,
	processes []string,
	requestID *uuid.UUID,
) (MaterialType, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return MaterialType{}, err
	}
	name, err := validateMaterialTypeName(name)
	if err != nil {
		return MaterialType{}, err
	}
	if !validUnit(MaterialUnit(unit)) {
		return MaterialType{}, apperror.Invalid("invalid material unit")
	}
	if !validMaterialKind(kind) {
		return MaterialType{}, apperror.Invalid("invalid material kind")
	}
	processes, err = shapeMaterialType(kind, unit, processes)
	if err != nil {
		return MaterialType{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MaterialType{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	id := ids.New()
	if _, err = q.CreateMaterialType(
		ctx,
		machinelogbookdb.CreateMaterialTypeParams{ID: id, Name: name, Unit: unit, Kind: string(kind)},
	); err != nil {
		return MaterialType{}, materialTypeConflict(err)
	}
	if err = replaceMaterialTypeProcesses(ctx, q, id, processes); err != nil {
		return MaterialType{}, err
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"material_type.created",
		"material_type",
		id,
		requestID,
		[]string{"name", "kind", "unit", "processes"},
	); err != nil {
		return MaterialType{}, err
	}
	row, err := q.GetMaterialType(ctx, id)
	if err != nil {
		return MaterialType{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MaterialType{}, err
	}
	return materialTypeFromList(machinelogbookdb.ListMaterialTypesRow(row), processes), nil
}

// UpdateMaterialType renames, deactivates or reactivates a type. Its unit can
// only change while no material or pricing rule uses the type, because those
// keep the unit of their type, and the kind only while no material uses it.
// An empty kind keeps the current one. Nil processes keeps the current ones; a
// given list replaces them and must fit the kind.
func (s *Service) UpdateMaterialType(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	name string,
	kind MaterialKind,
	unit string,
	processes []string,
	active bool,
	requestID *uuid.UUID,
) (MaterialType, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return MaterialType{}, err
	}
	if expected < 1 {
		return MaterialType{}, apperror.Invalid("expectedVersion must be positive")
	}
	name, err := validateMaterialTypeName(name)
	if err != nil {
		return MaterialType{}, err
	}
	if !validUnit(MaterialUnit(unit)) {
		return MaterialType{}, apperror.Invalid("invalid material unit")
	}
	if kind != "" && !validMaterialKind(kind) {
		return MaterialType{}, apperror.Invalid("invalid material kind")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MaterialType{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	current, err := q.GetMaterialTypeForUpdate(ctx, id)
	if err != nil {
		return MaterialType{}, noRows(err)
	}
	if current.Version != expected {
		return MaterialType{}, apperror.StaleWrite
	}
	currentKind := MaterialKind(current.Kind)
	if kind == "" {
		kind = currentKind
	}
	if kind != currentKind {
		if err = ensureKindChangeAllowed(ctx, q, id, kind); err != nil {
			return MaterialType{}, err
		}
	}
	effective := processes
	if effective == nil && kind == currentKind {
		// A new kind needs processes of its own; the defaults apply when none were given.
		if effective, err = q.ListMaterialTypeProcessNames(ctx, id); err != nil {
			return MaterialType{}, err
		}
	}
	shaped, err := shapeMaterialType(kind, unit, effective)
	if err != nil {
		return MaterialType{}, err
	}
	if processes != nil || kind != currentKind {
		processes = shaped
	}
	if current.Unit != unit {
		referenced, refErr := q.MaterialTypeIsReferenced(ctx, id)
		if refErr != nil {
			return MaterialType{}, refErr
		}
		if referenced {
			return MaterialType{}, apperror.Conflicting(
				"material_type_unit_in_use",
				"The unit cannot change while materials or pricing rules use this material type",
			)
		}
	}
	if _, err = q.UpdateMaterialType(
		ctx,
		machinelogbookdb.UpdateMaterialTypeParams{
			Name:            name,
			Unit:            unit,
			Kind:            string(kind),
			Active:          active,
			ID:              id,
			ExpectedVersion: expected,
		},
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return MaterialType{}, apperror.StaleWrite
		}
		return MaterialType{}, materialTypeConflict(err)
	}
	if processes != nil {
		if err = replaceMaterialTypeProcesses(ctx, q, id, processes); err != nil {
			return MaterialType{}, err
		}
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"material_type.updated",
		"material_type",
		id,
		requestID,
		[]string{"name", "kind", "unit", "processes", "active"},
	); err != nil {
		return MaterialType{}, err
	}
	row, err := q.GetMaterialType(ctx, id)
	if err != nil {
		return MaterialType{}, err
	}
	stored, err := materialTypeProcesses(ctx, q, []uuid.UUID{id})
	if err != nil {
		return MaterialType{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MaterialType{}, err
	}
	return materialTypeFromList(machinelogbookdb.ListMaterialTypesRow(row), stored[id]), nil
}

// ensureKindChangeAllowed refuses a new kind while materials use the type, and
// the part kind while active pricing rules price the type.
func ensureKindChangeAllowed(ctx context.Context, q *machinelogbookdb.Queries, id uuid.UUID, kind MaterialKind) error {
	count, err := q.CountMaterialsOfType(ctx, id)
	if err != nil {
		return err
	}
	if count > 0 {
		return apperror.Conflicting(
			"material_type_in_use",
			"The kind cannot change while materials use this material type",
		)
	}
	if kind != KindPart {
		return nil
	}
	rules, err := q.CountActivePricingRulesOfMaterialType(ctx, &id)
	if err != nil {
		return err
	}
	if rules > 0 {
		return apperror.Conflicting(
			"material_type_in_use",
			"A material type with active pricing rules cannot become a part category",
		)
	}
	return nil
}

// DeleteMaterialType hard-deletes a type that no material or pricing rule uses.
// Referenced types answer 409 material_type_in_use; deactivate those instead.
func (s *Service) DeleteMaterialType(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	if err := require(p, authorization.InventoryManage); err != nil {
		return err
	}
	if expected < 1 {
		return apperror.Invalid("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	current, err := q.GetMaterialTypeForUpdate(ctx, id)
	if err != nil {
		return noRows(err)
	}
	if current.Version != expected {
		return apperror.StaleWrite
	}
	referenced, err := q.MaterialTypeIsReferenced(ctx, id)
	if err != nil {
		return err
	}
	if referenced {
		return apperror.Conflicting(
			"material_type_in_use",
			"Materials or pricing rules use this material type and it cannot be deleted; deactivate it instead",
		)
	}
	rows, err := q.DeleteMaterialType(ctx, machinelogbookdb.DeleteMaterialTypeParams{ID: id, ExpectedVersion: expected})
	if err != nil {
		return databaseError(err)
	}
	if rows == 0 {
		return apperror.StaleWrite
	}
	if err = writeAudit(ctx, tx, p, "material_type.deleted", "material_type", id, requestID, nil); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// resolveMaterialType loads the type a material or pricing rule points at and
// returns its unit. requireActive refuses deactivated types for new choices.
func resolveMaterialType(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	id uuid.UUID,
	requireActive bool,
) (machinelogbookdb.MaterialType, error) {
	row, err := q.GetMaterialTypeForShare(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return row, apperror.Invalid("materialTypeId does not refer to a material type")
	}
	if err != nil {
		return row, err
	}
	if requireActive && !row.Active {
		return row, apperror.Conflicting("material_type_inactive", "The material type is inactive")
	}
	return row, nil
}

// validateColor normalises the optional colour name and checks the colour code.
func validateColor(name, hex *string) (*string, *string, error) {
	name = optional.Trimmed(name)
	if name != nil && len(*name) > 80 {
		return nil, nil, apperror.Invalid("colorName is limited to 80 characters")
	}
	hex = optional.Trimmed(hex)
	if hex != nil && !colorHexPattern.MatchString(*hex) {
		return nil, nil, apperror.Invalid("colorHex must look like #RRGGBB with upper-case hexadecimal digits")
	}
	return name, hex, nil
}
