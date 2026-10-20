package machinelogbook

import (
	"context"
	"errors"
	"regexp"
	"slices"
	"sort"
	"strings"

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
	return MaterialType{ID: row.ID, Name: row.Name, Kind: row.Kind, Unit: row.Unit, Processes: processes, Active: row.Active, MaterialCount: row.MaterialCount, PricingRuleCount: row.PricingRuleCount,
		Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}

func validateMaterialTypeName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 120 {
		return "", validation("name is required and limited to 120 characters")
	}
	return name, nil
}

// validateProcesses checks a type's process list: at least one, all known, no
// duplicates. The result is ordered like machineProcesses.
func validateProcesses(processes []string) ([]string, error) {
	if len(processes) == 0 {
		return nil, validation("at least one process is required")
	}
	chosen := map[string]bool{}
	for _, process := range processes {
		if !validProcess(process) {
			return nil, validation("invalid process")
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

// Material kinds. The kind of an article comes from its material type.
const (
	KindFilament   = "filament"
	KindConsumable = "consumable"
	KindPart       = "part"
)

func validMaterialKind(kind string) bool {
	return kind == KindFilament || kind == KindConsumable || kind == KindPart
}

// shapeMaterialType checks unit and processes against the kind and returns the
// normalised process list: filament is measured in grams and serves FDM
// printing (the default), possibly next to other processes, a consumable
// serves at least one process, a part
// serves none, so it can never be used in a machine run.
func shapeMaterialType(kind, unit string, processes []string) ([]string, error) {
	switch kind {
	case KindFilament:
		if unit != "g" {
			return nil, validation("filament material types are measured in grams")
		}
		if len(processes) == 0 {
			return []string{ProcessFDMPrinting}, nil
		}
		ordered, err := validateProcesses(processes)
		if err != nil {
			return nil, err
		}
		if !slices.Contains(ordered, ProcessFDMPrinting) {
			return nil, validation("filament material types serve the process fdm_printing")
		}
		return ordered, nil
	case KindConsumable:
		return validateProcesses(processes)
	case KindPart:
		if len(processes) > 0 {
			return nil, validation("part material types take no processes")
		}
		return []string{}, nil
	}
	return nil, validation("invalid material kind")
}

// materialTypeProcesses loads the processes of the given types.
func materialTypeProcesses(ctx context.Context, q *machinelogbookdb.Queries, ids []uuid.UUID) (map[uuid.UUID][]string, error) {
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

func replaceMaterialTypeProcesses(ctx context.Context, q *machinelogbookdb.Queries, id uuid.UUID, processes []string) error {
	if err := q.DeleteMaterialTypeProcesses(ctx, id); err != nil {
		return err
	}
	for _, process := range processes {
		if err := q.InsertMaterialTypeProcess(ctx, machinelogbookdb.InsertMaterialTypeProcessParams{MaterialTypeID: id, Process: process}); err != nil {
			return databaseError(err)
		}
	}
	return nil
}

func materialTypeConflict(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return conflict("material_type_exists", "A material type with this name already exists")
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

func (s *Service) CreateMaterialType(ctx context.Context, p authorization.Principal, name, kind, unit string, processes []string, requestID *uuid.UUID) (MaterialType, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return MaterialType{}, err
	}
	name, err := validateMaterialTypeName(name)
	if err != nil {
		return MaterialType{}, err
	}
	if !validUnit(unit) {
		return MaterialType{}, validation("invalid material unit")
	}
	if !validMaterialKind(kind) {
		return MaterialType{}, validation("invalid material kind")
	}
	processes, err = shapeMaterialType(kind, unit, processes)
	if err != nil {
		return MaterialType{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MaterialType{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	id := newID()
	if _, err = q.CreateMaterialType(ctx, machinelogbookdb.CreateMaterialTypeParams{ID: id, Name: name, Unit: unit, Kind: kind}); err != nil {
		return MaterialType{}, materialTypeConflict(err)
	}
	if err = replaceMaterialTypeProcesses(ctx, q, id, processes); err != nil {
		return MaterialType{}, err
	}
	if err = writeAudit(ctx, tx, p, "material_type.created", "material_type", id, requestID, []string{"name", "kind", "unit", "processes"}); err != nil {
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
func (s *Service) UpdateMaterialType(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, name, kind, unit string, processes []string, active bool, requestID *uuid.UUID) (MaterialType, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return MaterialType{}, err
	}
	if expected < 1 {
		return MaterialType{}, validation("expectedVersion must be positive")
	}
	name, err := validateMaterialTypeName(name)
	if err != nil {
		return MaterialType{}, err
	}
	if !validUnit(unit) {
		return MaterialType{}, validation("invalid material unit")
	}
	if kind != "" && !validMaterialKind(kind) {
		return MaterialType{}, validation("invalid material kind")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MaterialType{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	current, err := q.GetMaterialTypeForUpdate(ctx, id)
	if err != nil {
		return MaterialType{}, noRows(err)
	}
	if current.Version != expected {
		return MaterialType{}, apperror.StaleWrite
	}
	if kind == "" {
		kind = current.Kind
	}
	if kind != current.Kind {
		count, countErr := q.CountMaterialsOfType(ctx, id)
		if countErr != nil {
			return MaterialType{}, countErr
		}
		if count > 0 {
			return MaterialType{}, conflict("material_type_in_use", "The kind cannot change while materials use this material type")
		}
		if kind == KindPart {
			rules, rulesErr := q.CountActivePricingRulesOfMaterialType(ctx, &id)
			if rulesErr != nil {
				return MaterialType{}, rulesErr
			}
			if rules > 0 {
				return MaterialType{}, conflict("material_type_in_use", "A material type with active pricing rules cannot become a part category")
			}
		}
	}
	effective := processes
	if effective == nil {
		names, listErr := q.ListMaterialTypeProcessNames(ctx, id)
		if listErr != nil {
			return MaterialType{}, listErr
		}
		effective = names
		if kind != current.Kind {
			// A new kind needs processes of its own; the defaults apply when none were given.
			effective = nil
		}
	}
	shaped, err := shapeMaterialType(kind, unit, effective)
	if err != nil {
		return MaterialType{}, err
	}
	if processes != nil || kind != current.Kind {
		processes = shaped
	}
	if current.Unit != unit {
		referenced, refErr := q.MaterialTypeIsReferenced(ctx, id)
		if refErr != nil {
			return MaterialType{}, refErr
		}
		if referenced {
			return MaterialType{}, conflict("material_type_unit_in_use", "The unit cannot change while materials or pricing rules use this material type")
		}
	}
	if _, err = q.UpdateMaterialType(ctx, machinelogbookdb.UpdateMaterialTypeParams{Name: name, Unit: unit, Kind: kind, Active: active, ID: id, ExpectedVersion: expected}); err != nil {
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
	if err = writeAudit(ctx, tx, p, "material_type.updated", "material_type", id, requestID, []string{"name", "kind", "unit", "processes", "active"}); err != nil {
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

// DeleteMaterialType hard-deletes a type that no material or pricing rule uses.
// Referenced types answer 409 material_type_in_use; deactivate those instead.
func (s *Service) DeleteMaterialType(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, requestID *uuid.UUID) error {
	if err := require(p, authorization.InventoryManage); err != nil {
		return err
	}
	if expected < 1 {
		return validation("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
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
		return conflict("material_type_in_use", "Materials or pricing rules use this material type and it cannot be deleted; deactivate it instead")
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
func resolveMaterialType(ctx context.Context, q *machinelogbookdb.Queries, id uuid.UUID, requireActive bool) (machinelogbookdb.MaterialType, error) {
	row, err := q.GetMaterialTypeForShare(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return row, validation("materialTypeId does not refer to a material type")
	}
	if err != nil {
		return row, err
	}
	if requireActive && !row.Active {
		return row, conflict("material_type_inactive", "The material type is inactive")
	}
	return row, nil
}

// validateColor normalises the optional colour name and checks the colour code.
func validateColor(name, hex *string) (*string, *string, error) {
	name = cleanOptional(name)
	if name != nil && len(*name) > 80 {
		return nil, nil, validation("colorName is limited to 80 characters")
	}
	hex = cleanOptional(hex)
	if hex != nil && !colorHexPattern.MatchString(*hex) {
		return nil, nil, validation("colorHex must look like #RRGGBB with upper-case hexadecimal digits")
	}
	return name, hex, nil
}
