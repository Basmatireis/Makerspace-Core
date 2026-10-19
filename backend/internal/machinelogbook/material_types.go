package machinelogbook

import (
	"context"
	"errors"
	"regexp"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var colorHexPattern = regexp.MustCompile(`^#[0-9A-F]{6}$`)

func materialTypeFromList(row machinelogbookdb.ListMaterialTypesRow) MaterialType {
	return MaterialType{ID: row.ID, Name: row.Name, Unit: row.Unit, Active: row.Active, MaterialCount: row.MaterialCount, PricingRuleCount: row.PricingRuleCount,
		Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}

func validateMaterialTypeName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 120 {
		return "", validation("name is required and limited to 120 characters")
	}
	return name, nil
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
	items := make([]MaterialType, 0, len(rows))
	for _, row := range rows {
		items = append(items, materialTypeFromList(row))
	}
	return items, nil
}

func (s *Service) GetMaterialType(ctx context.Context, p authorization.Principal, id uuid.UUID) (MaterialType, error) {
	if err := require(p, authorization.InventoryRead); err != nil {
		return MaterialType{}, err
	}
	row, err := machinelogbookdb.New(s.pool).GetMaterialType(ctx, id)
	if err != nil {
		return MaterialType{}, noRows(err)
	}
	return materialTypeFromList(machinelogbookdb.ListMaterialTypesRow(row)), nil
}

func (s *Service) CreateMaterialType(ctx context.Context, p authorization.Principal, name, unit string, requestID *uuid.UUID) (MaterialType, error) {
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
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MaterialType{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	id := newID()
	if _, err = q.CreateMaterialType(ctx, machinelogbookdb.CreateMaterialTypeParams{ID: id, Name: name, Unit: unit}); err != nil {
		return MaterialType{}, materialTypeConflict(err)
	}
	if err = writeAudit(ctx, tx, p, "material_type.created", "material_type", id, requestID, []string{"name", "unit"}); err != nil {
		return MaterialType{}, err
	}
	row, err := q.GetMaterialType(ctx, id)
	if err != nil {
		return MaterialType{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MaterialType{}, err
	}
	return materialTypeFromList(machinelogbookdb.ListMaterialTypesRow(row)), nil
}

// UpdateMaterialType renames, deactivates or reactivates a type. Its unit can
// only change while no material or pricing rule uses the type, because those
// keep the unit of their type.
func (s *Service) UpdateMaterialType(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, name, unit string, active bool, requestID *uuid.UUID) (MaterialType, error) {
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
	if current.Unit != unit {
		referenced, refErr := q.MaterialTypeIsReferenced(ctx, id)
		if refErr != nil {
			return MaterialType{}, refErr
		}
		if referenced {
			return MaterialType{}, conflict("material_type_unit_in_use", "The unit cannot change while materials or pricing rules use this material type")
		}
	}
	if _, err = q.UpdateMaterialType(ctx, machinelogbookdb.UpdateMaterialTypeParams{Name: name, Unit: unit, Active: active, ID: id, ExpectedVersion: expected}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return MaterialType{}, apperror.StaleWrite
		}
		return MaterialType{}, materialTypeConflict(err)
	}
	if err = writeAudit(ctx, tx, p, "material_type.updated", "material_type", id, requestID, []string{"name", "unit", "active"}); err != nil {
		return MaterialType{}, err
	}
	row, err := q.GetMaterialType(ctx, id)
	if err != nil {
		return MaterialType{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MaterialType{}, err
	}
	return materialTypeFromList(machinelogbookdb.ListMaterialTypesRow(row)), nil
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
