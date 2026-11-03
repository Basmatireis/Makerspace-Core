package machinelogbook

import (
	"bytes"
	"context"
	"errors"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var colorHexPattern = regexp.MustCompile(`^#[0-9A-F]{6}$`)

func materialTypeFromList(row machinelogbookdb.ListMaterialTypesRow, processIDs []uuid.UUID) MaterialType {
	if processIDs == nil {
		processIDs = []uuid.UUID{}
	}
	return MaterialType{
		ID:               row.ID,
		Name:             row.Name,
		Code:             row.Code,
		MachineUse:       row.MachineUse,
		Kind:             MaterialKind(row.Kind),
		Unit:             row.Unit,
		ProcessIDs:       processIDs,
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

// validateProcesses checks a type's process list: at least one, no duplicates, every id a known process. The
// result is ordered by id and the integrations of the processes are returned alongside.
func validateProcesses(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	processIDs []uuid.UUID,
) ([]uuid.UUID, map[uuid.UUID]ProcessIntegration, error) {
	if len(processIDs) == 0 {
		return nil, nil, apperror.Invalid("at least one process is required")
	}
	unique := slices.Clone(processIDs)
	slices.SortFunc(unique, func(a, b uuid.UUID) int { return bytes.Compare(a[:], b[:]) })
	unique = slices.Compact(unique)
	rows, err := q.ListProcessesByIDs(ctx, uuidStrings(unique))
	if err != nil {
		return nil, nil, err
	}
	if len(rows) != len(unique) {
		return nil, nil, apperror.Invalid("processIds refers to an unknown process")
	}
	integrations := make(map[uuid.UUID]ProcessIntegration, len(rows))
	for _, row := range rows {
		integrations[row.ID] = ProcessIntegration(row.Integration)
	}
	return unique, integrations, nil
}

func validMaterialKind(kind MaterialKind) bool {
	return kind == KindFilament || kind == KindConsumable || kind == KindPart
}

// shapeMaterialType checks unit and processes against the kind and returns the
// normalised process list: filament is measured in grams and serves the
// processes with an FDM printer integration (every active one by default),
// possibly next to other processes, a consumable serves at least one process,
// a part serves none, so it can never be used in a machine run.
func shapeMaterialType(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	kind MaterialKind,
	unit string,
	processIDs []uuid.UUID,
) ([]uuid.UUID, error) {
	switch kind {
	case KindFilament:
		if MaterialUnit(unit) != UnitGram {
			return nil, apperror.Invalid("filament material types are measured in grams")
		}
		if len(processIDs) == 0 {
			defaults, err := q.ListActiveFDMProcessIDs(ctx)
			if err != nil {
				return nil, err
			}
			if defaults == nil {
				defaults = []uuid.UUID{}
			}
			return defaults, nil
		}
		ordered, integrations, err := validateProcesses(ctx, q, processIDs)
		if err != nil {
			return nil, err
		}
		for _, id := range ordered {
			if integrations[id] == IntegrationFDMPrinter {
				return ordered, nil
			}
		}
		return nil, apperror.Invalid("filament material types serve a process with the fdm_printer integration")
	case KindConsumable:
		ordered, _, err := validateProcesses(ctx, q, processIDs)
		return ordered, err
	case KindPart:
		if len(processIDs) > 0 {
			return nil, apperror.Invalid("part material types take no processes")
		}
		return []uuid.UUID{}, nil
	}
	return nil, apperror.Invalid("invalid material kind")
}

// materialTypeProcesses loads the process ids of the given types.
func materialTypeProcesses(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	ids []uuid.UUID,
) (map[uuid.UUID][]uuid.UUID, error) {
	rows, err := q.ListMaterialTypeProcesses(ctx, ids)
	if err != nil {
		return nil, err
	}
	byType := map[uuid.UUID][]uuid.UUID{}
	for _, row := range rows {
		byType[row.MaterialTypeID] = append(byType[row.MaterialTypeID], row.ProcessID)
	}
	return byType, nil
}

func replaceMaterialTypeProcesses(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	id uuid.UUID,
	processIDs []uuid.UUID,
) error {
	if err := q.DeleteMaterialTypeProcesses(ctx, id); err != nil {
		return err
	}
	for _, processID := range processIDs {
		if err := q.InsertMaterialTypeProcess(
			ctx,
			machinelogbookdb.InsertMaterialTypeProcessParams{MaterialTypeID: id, ProcessID: processID},
		); err != nil {
			return databaseError(err)
		}
	}
	return nil
}

func materialTypeConflict(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		if pgErr.ConstraintName == "material_types_code_ci_idx" {
			return apperror.Conflicting("material_type_code_exists", "A material type with this code already exists")
		}
		return apperror.Conflicting("material_type_exists", "A material type with this name already exists")
	}
	return databaseError(err)
}

// MaterialTypeOptions carries the label code and the machine-use flag of a material type. Nil keeps the
// current value on update; on create the code defaults to the first word of the name and machine use to true
// for filament and consumables.
type MaterialTypeOptions struct {
	Code       *string
	MachineUse *bool
}

var materialTypeCodePattern = regexp.MustCompile(`^[A-Z0-9]{1,12}$`)

const maxMaterialTypeCodeLength = 12

// defaultMaterialTypeCode derives a code from the first word of a type name.
func defaultMaterialTypeCode(name string) string {
	word := strings.ToUpper(strings.Fields(name + " ")[0])
	var b strings.Builder
	for _, r := range word {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	code := b.String()
	if len(code) > maxMaterialTypeCodeLength {
		code = code[:maxMaterialTypeCodeLength]
	}
	if code == "" {
		code = "TYPE"
	}
	return code
}

// freeMaterialTypeCode appends a number to a derived code another type already uses.
func freeMaterialTypeCode(ctx context.Context, q *machinelogbookdb.Queries, base string) (string, error) {
	candidate := base
	for n := 2; ; n++ {
		_, err := q.FindMaterialTypeByCode(ctx, candidate)
		if errors.Is(err, pgx.ErrNoRows) {
			return candidate, nil
		}
		if err != nil {
			return "", err
		}
		suffix := strconv.Itoa(n)
		limit := min(len(base), maxMaterialTypeCodeLength-len(suffix))
		candidate = base[:limit] + suffix
	}
}

func validateMaterialTypeCode(code string) (string, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	if !materialTypeCodePattern.MatchString(code) {
		return "", apperror.Invalid("code must be 1 to 12 letters A-Z or digits")
	}
	return code, nil
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
	processIDs, err := materialTypeProcesses(ctx, machinelogbookdb.New(s.pool), ids)
	if err != nil {
		return nil, err
	}
	items := make([]MaterialType, 0, len(rows))
	for _, row := range rows {
		items = append(items, materialTypeFromList(row, processIDs[row.ID]))
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
	processIDs, err := materialTypeProcesses(ctx, q, []uuid.UUID{id})
	if err != nil {
		return MaterialType{}, err
	}
	return materialTypeFromList(machinelogbookdb.ListMaterialTypesRow(row), processIDs[id]), nil
}

func (s *Service) CreateMaterialType(
	ctx context.Context,
	p authorization.Principal,
	name string,
	kind MaterialKind,
	unit string,
	processIDs []uuid.UUID,
	requestID *uuid.UUID,
) (MaterialType, error) {
	return s.CreateMaterialTypeWithOptions(ctx, p, name, kind, unit, processIDs, MaterialTypeOptions{}, requestID)
}

// CreateMaterialTypeWithOptions is CreateMaterialType with an explicit code and machine-use flag.
func (s *Service) CreateMaterialTypeWithOptions(
	ctx context.Context,
	p authorization.Principal,
	name string,
	kind MaterialKind,
	unit string,
	processIDs []uuid.UUID,
	options MaterialTypeOptions,
	requestID *uuid.UUID,
) (MaterialType, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return MaterialType{}, err
	}
	var result MaterialType
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.createMaterialTypeTx(ctx, tx, p, name, kind, unit, processIDs, options, requestID)
		return err
	})
	return result, err
}

// CreateMaterialTypeTx is CreateMaterialType inside the caller's transaction; the configuration import uses it.
func (s *Service) CreateMaterialTypeTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	name string,
	kind MaterialKind,
	unit string,
	processIDs []uuid.UUID,
	requestID *uuid.UUID,
) (MaterialType, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return MaterialType{}, err
	}
	return s.createMaterialTypeTx(ctx, tx, p, name, kind, unit, processIDs, MaterialTypeOptions{}, requestID)
}

func (s *Service) createMaterialTypeTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	name string,
	kind MaterialKind,
	unit string,
	processIDs []uuid.UUID,
	options MaterialTypeOptions,
	requestID *uuid.UUID,
) (MaterialType, error) {
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
	q := machinelogbookdb.New(tx)
	processIDs, err = shapeMaterialType(ctx, q, kind, unit, processIDs)
	if err != nil {
		return MaterialType{}, err
	}
	machineUse := kind != KindPart
	if options.MachineUse != nil {
		machineUse = *options.MachineUse
	}
	if kind == KindFilament && !machineUse {
		return MaterialType{}, apperror.Invalid("filament material types are always used in machine runs")
	}
	var code string
	if options.Code != nil {
		if code, err = validateMaterialTypeCode(*options.Code); err != nil {
			return MaterialType{}, err
		}
	} else if code, err = freeMaterialTypeCode(ctx, q, defaultMaterialTypeCode(name)); err != nil {
		return MaterialType{}, err
	}
	id := ids.New()
	if _, err = q.CreateMaterialType(
		ctx,
		machinelogbookdb.CreateMaterialTypeParams{
			ID:         id,
			Name:       name,
			Unit:       unit,
			Kind:       string(kind),
			Code:       code,
			MachineUse: machineUse,
		},
	); err != nil {
		return MaterialType{}, materialTypeConflict(err)
	}
	if err = replaceMaterialTypeProcesses(ctx, q, id, processIDs); err != nil {
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
		[]string{"name", "code", "kind", "machineUse", "unit", "processIds"},
	); err != nil {
		return MaterialType{}, err
	}
	row, err := q.GetMaterialType(ctx, id)
	if err != nil {
		return MaterialType{}, err
	}
	return materialTypeFromList(machinelogbookdb.ListMaterialTypesRow(row), processIDs), nil
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
	processIDs []uuid.UUID,
	active bool,
	requestID *uuid.UUID,
) (MaterialType, error) {
	return s.UpdateMaterialTypeWithOptions(
		ctx, p, id, expected, name, kind, unit, processIDs, active, MaterialTypeOptions{}, requestID,
	)
}

// UpdateMaterialTypeWithOptions is UpdateMaterialType that can also change the code and the machine-use flag.
func (s *Service) UpdateMaterialTypeWithOptions(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	name string,
	kind MaterialKind,
	unit string,
	processIDs []uuid.UUID,
	active bool,
	options MaterialTypeOptions,
	requestID *uuid.UUID,
) (MaterialType, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return MaterialType{}, err
	}
	var result MaterialType
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.updateMaterialTypeTx(
			ctx, tx, p, id, expected, name, kind, unit, processIDs, active, options, requestID,
		)
		return err
	})
	return result, err
}

// UpdateMaterialTypeTx is UpdateMaterialType inside the caller's transaction; the configuration import uses it.
func (s *Service) UpdateMaterialTypeTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	name string,
	kind MaterialKind,
	unit string,
	processIDs []uuid.UUID,
	active bool,
	requestID *uuid.UUID,
) (MaterialType, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return MaterialType{}, err
	}
	return s.updateMaterialTypeTx(
		ctx, tx, p, id, expected, name, kind, unit, processIDs, active, MaterialTypeOptions{}, requestID,
	)
}

func (s *Service) updateMaterialTypeTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	name string,
	kind MaterialKind,
	unit string,
	processIDs []uuid.UUID,
	active bool,
	options MaterialTypeOptions,
	requestID *uuid.UUID,
) (MaterialType, error) {
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
	if processIDs != nil || kind != currentKind {
		// A new kind needs processes of its own; the defaults apply when none were given.
		if processIDs, err = shapeMaterialType(ctx, q, kind, unit, processIDs); err != nil {
			return MaterialType{}, err
		}
	} else if kind == KindFilament && MaterialUnit(unit) != UnitGram {
		// The stored processes stay as they are, even if an integration changed since.
		return MaterialType{}, apperror.Invalid("filament material types are measured in grams")
	}
	code := current.Code
	if options.Code != nil {
		if code, err = validateMaterialTypeCode(*options.Code); err != nil {
			return MaterialType{}, err
		}
	}
	machineUse := current.MachineUse || kind == KindFilament
	if options.MachineUse != nil {
		machineUse = *options.MachineUse
	}
	if kind == KindFilament && !machineUse {
		return MaterialType{}, apperror.Invalid("filament material types are always used in machine runs")
	}
	if current.MachineUse && !machineUse {
		rules, countErr := q.CountActivePricingRulesOfMaterialType(ctx, &id)
		if countErr != nil {
			return MaterialType{}, countErr
		}
		if rules > 0 {
			return MaterialType{}, apperror.Conflicting(
				"material_type_in_use",
				"Machine use cannot be turned off while active material pricing rules price this type",
			)
		}
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
			Code:            code,
			MachineUse:      machineUse,
			ID:              id,
			ExpectedVersion: expected,
		},
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return MaterialType{}, apperror.StaleWrite
		}
		return MaterialType{}, materialTypeConflict(err)
	}
	if processIDs != nil {
		if err = replaceMaterialTypeProcesses(ctx, q, id, processIDs); err != nil {
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
		[]string{"name", "code", "kind", "machineUse", "unit", "processIds", "active"},
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
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		return s.DeleteMaterialTypeTx(ctx, tx, p, id, expected, requestID)
	})
}

// DeleteMaterialTypeTx is DeleteMaterialType inside the caller's transaction; the configuration import uses it.
func (s *Service) DeleteMaterialTypeTx(
	ctx context.Context,
	tx pgx.Tx,
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
	return nil
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
