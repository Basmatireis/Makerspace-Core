package machinelogbook

import (
	"context"
	"errors"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

func productFromGet(row machinelogbookdb.GetFilamentProductRow) FilamentProduct {
	return FilamentProduct{
		ID:           row.ID,
		Manufacturer: row.Manufacturer,
		Name:         row.Name,
		MaterialID:   row.MaterialID,
		MaterialName: row.MaterialName,
		NetWeightG: decimalString(
			row.NetWeightG,
		),
		DefaultPrice: nullableDecimal(row.DefaultPrice),
		Packaging:    row.Packaging,
		Notes:        row.Notes,
		Active:       row.Active,
		InUseCount:   row.InUseCount,
		Version:      row.Version,
		CreatedAt:    row.CreatedAt,
		UpdatedAt:    row.UpdatedAt,
	}
}

func productFromList(row machinelogbookdb.ListFilamentProductsRow) FilamentProduct {
	return productFromGet(machinelogbookdb.GetFilamentProductRow(row))
}

type validatedProduct struct {
	manufacturer, name, packaging string
	netWeight, defaultPrice       pgtype.Numeric
	notes                         *string
}

func validateProduct(in FilamentProductInput) (validatedProduct, error) {
	var v validatedProduct
	v.manufacturer = strings.TrimSpace(in.Manufacturer)
	v.name = strings.TrimSpace(in.Name)
	if v.manufacturer == "" || len(v.manufacturer) > 150 {
		return v, validation("manufacturer is required and limited to 150 characters")
	}
	if v.name == "" || len(v.name) > 200 {
		return v, validation("name is required and limited to 200 characters")
	}
	if in.Packaging != "refill" && in.Packaging != "spool" {
		return v, validation("invalid packaging")
	}
	v.packaging = in.Packaging
	var err error
	if v.netWeight, err = numericFromString(in.NetWeightG, true); err != nil {
		return v, validation("netWeightG must be positive")
	}
	if v.defaultPrice, err = pgNullableNumeric(in.DefaultPrice, false); err != nil ||
		(v.defaultPrice.Valid && decimalFromNumeric(v.defaultPrice).IsNegative()) {
		return v, validation("defaultPrice must be non-negative")
	}
	if v.notes, err = validateOptionalText(in.Notes, "notes", 2000); err != nil {
		return v, err
	}
	return v, nil
}

func productConflict(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return conflict("product_exists", "A product with this manufacturer and name already exists")
	}
	return databaseError(err)
}

func (s *Service) GetFilamentProduct(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
) (FilamentProduct, error) {
	if err := require(p, authorization.InventoryRead); err != nil {
		return FilamentProduct{}, err
	}
	row, err := machinelogbookdb.New(s.pool).GetFilamentProduct(ctx, id)
	if err != nil {
		return FilamentProduct{}, noRows(err)
	}
	return productFromGet(row), nil
}

func (s *Service) ListFilamentProducts(
	ctx context.Context,
	p authorization.Principal,
	f FilamentProductFilters,
) ([]FilamentProduct, int64, error) {
	if err := require(p, authorization.InventoryRead); err != nil {
		return nil, 0, err
	}
	if f.Packaging != "" && f.Packaging != "refill" && f.Packaging != "spool" {
		return nil, 0, validation("invalid packaging")
	}
	offset, limit, err := pageBounds(f.Page, f.PageSize)
	if err != nil {
		return nil, 0, err
	}
	q := machinelogbookdb.New(s.pool)
	search, manufacturer := strings.TrimSpace(f.Search), strings.TrimSpace(f.Manufacturer)
	rows, err := q.ListFilamentProducts(
		ctx,
		machinelogbookdb.ListFilamentProductsParams{
			Search:          search,
			MaterialID:      f.MaterialID,
			Manufacturer:    manufacturer,
			Packaging:       f.Packaging,
			IncludeInactive: f.IncludeInactive,
			PageOffset:      offset,
			PageLimit:       limit,
		},
	)
	if err != nil {
		return nil, 0, err
	}
	total, err := q.CountFilamentProducts(
		ctx,
		machinelogbookdb.CountFilamentProductsParams{
			Search:          search,
			MaterialID:      f.MaterialID,
			Manufacturer:    manufacturer,
			Packaging:       f.Packaging,
			IncludeInactive: f.IncludeInactive,
		},
	)
	if err != nil {
		return nil, 0, err
	}
	items := make([]FilamentProduct, 0, len(rows))
	for _, row := range rows {
		items = append(items, productFromList(row))
	}
	return items, total, nil
}

func (s *Service) CreateFilamentProduct(
	ctx context.Context,
	p authorization.Principal,
	in FilamentProductInput,
	requestID *uuid.UUID,
) (FilamentProduct, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return FilamentProduct{}, err
	}
	v, err := validateProduct(in)
	if err != nil {
		return FilamentProduct{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FilamentProduct{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	if _, err = q.GetMaterial(ctx, in.MaterialID); err != nil {
		return FilamentProduct{}, noRows(err)
	}
	id := newID()
	if _, err = q.CreateFilamentProduct(
		ctx,
		machinelogbookdb.CreateFilamentProductParams{
			ID:           id,
			Manufacturer: v.manufacturer,
			Name:         v.name,
			MaterialID:   in.MaterialID,
			NetWeightG:   v.netWeight,
			DefaultPrice: v.defaultPrice,
			Packaging:    v.packaging,
			Notes:        v.notes,
		},
	); err != nil {
		return FilamentProduct{}, productConflict(err)
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"filament_product.created",
		"filament_product",
		id,
		requestID,
		[]string{"manufacturer", "name", "materialId", "netWeightG", "defaultPrice", "packaging", "notes"},
	); err != nil {
		return FilamentProduct{}, err
	}
	row, err := q.GetFilamentProduct(ctx, id)
	if err != nil {
		return FilamentProduct{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return FilamentProduct{}, err
	}
	return productFromGet(row), nil
}

// UpdateFilamentProduct edits or deactivates a product. Spools and fills keep
// their own snapshots, so the update never touches them.
func (s *Service) UpdateFilamentProduct(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	in FilamentProductInput,
	requestID *uuid.UUID,
) (FilamentProduct, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return FilamentProduct{}, err
	}
	if in.ExpectedVersion < 1 {
		return FilamentProduct{}, validation("expectedVersion must be positive")
	}
	v, err := validateProduct(in)
	if err != nil {
		return FilamentProduct{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FilamentProduct{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	current, err := q.GetFilamentProductForUpdate(ctx, id)
	if err != nil {
		return FilamentProduct{}, noRows(err)
	}
	if current.Version != in.ExpectedVersion {
		return FilamentProduct{}, apperror.StaleWrite
	}
	if _, err = q.GetMaterial(ctx, in.MaterialID); err != nil {
		return FilamentProduct{}, noRows(err)
	}
	if _, err = q.UpdateFilamentProduct(
		ctx,
		machinelogbookdb.UpdateFilamentProductParams{
			Manufacturer:    v.manufacturer,
			Name:            v.name,
			MaterialID:      in.MaterialID,
			NetWeightG:      v.netWeight,
			DefaultPrice:    v.defaultPrice,
			Packaging:       v.packaging,
			Notes:           v.notes,
			Active:          in.Active,
			ID:              id,
			ExpectedVersion: in.ExpectedVersion,
		},
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return FilamentProduct{}, apperror.StaleWrite
		}
		return FilamentProduct{}, productConflict(err)
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"filament_product.updated",
		"filament_product",
		id,
		requestID,
		[]string{"manufacturer", "name", "materialId", "netWeightG", "defaultPrice", "packaging", "notes", "active"},
	); err != nil {
		return FilamentProduct{}, err
	}
	row, err := q.GetFilamentProduct(ctx, id)
	if err != nil {
		return FilamentProduct{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return FilamentProduct{}, err
	}
	return productFromGet(row), nil
}
