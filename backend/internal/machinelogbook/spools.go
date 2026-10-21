package machinelogbook

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
)

func spoolDate(value pgtype.Date) *time.Time {
	if !value.Valid {
		return nil
	}
	v := value.Time
	return &v
}

func pgDate(value *time.Time) pgtype.Date {
	if value == nil {
		return pgtype.Date{}
	}
	return pgtype.Date{Time: value.UTC(), Valid: true}
}

func pgTimestamp(value time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: value.UTC(), Valid: true}
}

// spoolStatus derives the display status: archived spools are archived;
// single-use spools are active; reusable spools are loaded while a fill is open
// and need a refill otherwise.
func spoolStatus(lifecycle SpoolLifecycle, kind SpoolKind, hasOpenFill bool) SpoolStatus {
	switch {
	case lifecycle == SpoolArchived:
		return SpoolStatusArchived
	case kind == SpoolSingleUse:
		return SpoolStatusActive
	case hasOpenFill:
		return SpoolStatusLoaded
	default:
		return SpoolStatusNeedsRefill
	}
}

func spoolMount(
	machineID *uuid.UUID,
	machineName *string,
	inputUnit *string,
	slotID *uuid.UUID,
	slotName *string,
) *SpoolMount {
	if machineID == nil || machineName == nil || slotID == nil || slotName == nil {
		return nil
	}
	return &SpoolMount{
		MachineID:     *machineID,
		MachineName:   *machineName,
		InputUnitName: inputUnit,
		SlotID:        *slotID,
		SlotName:      *slotName,
	}
}

func spoolFromGet(row machinelogbookdb.GetFilamentSpoolRow) FilamentSpool {
	return FilamentSpool{
		MountedOn: spoolMount(
			row.MountMachineID,
			row.MountMachineName,
			row.MountInputUnitName,
			row.MountSlotID,
			row.MountSlotName,
		),
		ID:                row.ID,
		DisplayID:         row.DisplayID,
		Kind:              SpoolKind(row.Kind),
		Label:             row.Label,
		Status:            spoolStatus(SpoolLifecycle(row.Lifecycle), SpoolKind(row.Kind), row.FillID != nil),
		FillNumber:        row.FillNumber,
		FillID:            row.FillID,
		FilledAt:          nullableTime(row.FilledAt),
		ArchivedAt:        nullableTime(row.ArchivedAt),
		MaterialID:        row.MaterialID,
		MaterialName:      row.MaterialName,
		MaterialTypeName:  row.MaterialTypeName,
		ColorName:         row.ColorName,
		ColorHex:          row.ColorHex,
		Unit:              row.Unit,
		Manufacturer:      row.Manufacturer,
		ProductName:       row.ProductName,
		InitialNetWeightG: nullableDecimal(row.InitialNetWeightG),
		RemainingQuantity: decimalString(row.RemainingQuantity),
		TareWeightG:       nullableDecimal(row.TareWeightG),
		AcquiredOn: spoolDate(
			row.AcquiredOn,
		),
		AcquisitionReference: row.AcquisitionReference,
		StorageLocation:      row.StorageLocation,
		Notes:                row.Notes,
		Lifecycle:            SpoolLifecycle(row.Lifecycle),
		Mounted:              row.Mounted,
		Version:              row.Version,
		CreatedAt:            row.CreatedAt,
		UpdatedAt:            row.UpdatedAt,
	}
}

func spoolFromList(row machinelogbookdb.ListFilamentSpoolsRow) FilamentSpool {
	return spoolFromGet(machinelogbookdb.GetFilamentSpoolRow(row))
}

func identifierFromRow(row machinelogbookdb.FilamentSpoolIdentifier) FilamentSpoolIdentifier {
	return FilamentSpoolIdentifier{
		ID:        row.ID,
		Kind:      IdentifierKind(row.Kind),
		Value:     row.Value,
		CreatedAt: row.CreatedAt,
	}
}

func identifiersFromRows(rows []machinelogbookdb.FilamentSpoolIdentifier) []FilamentSpoolIdentifier {
	items := make([]FilamentSpoolIdentifier, 0, len(rows))
	for _, row := range rows {
		items = append(items, identifierFromRow(row))
	}
	return items
}

func (s *Service) loadSpool(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	id uuid.UUID,
	withFills bool,
) (FilamentSpool, error) {
	row, err := q.GetFilamentSpool(ctx, id)
	if err != nil {
		return FilamentSpool{}, noRows(err)
	}
	item := spoolFromGet(row)
	identifiers, err := q.ListFilamentSpoolIdentifiers(ctx, id)
	if err != nil {
		return FilamentSpool{}, err
	}
	item.Identifiers = identifiersFromRows(identifiers)
	if !withFills {
		return item, nil
	}
	fills, err := q.ListClosedFilamentSpoolFills(ctx, id)
	if err != nil {
		return FilamentSpool{}, err
	}
	retired, err := q.ListRetiredFilamentSpoolIdentifiers(ctx, id)
	if err != nil {
		return FilamentSpool{}, err
	}
	byFill := map[uuid.UUID][]FilamentSpoolIdentifier{}
	for _, identifier := range retired {
		byFill[identifier.FillID] = append(byFill[identifier.FillID], identifierFromRow(identifier))
	}
	item.Fills = make([]FilamentSpoolFill, 0, len(fills))
	for _, fill := range fills {
		identifiers := byFill[fill.ID]
		if identifiers == nil {
			identifiers = []FilamentSpoolIdentifier{}
		}
		outcome := ""
		if fill.LeftoverOutcome != nil {
			outcome = *fill.LeftoverOutcome
		}
		item.Fills = append(
			item.Fills,
			FilamentSpoolFill{
				ID:           fill.ID,
				MaterialID:   fill.MaterialID,
				FillNumber:   fill.FillNumber,
				MaterialName: fill.MaterialName,
				Manufacturer: fill.Manufacturer,
				ProductName:  fill.ProductName,
				InitialNetWeightG: decimalString(
					fill.InitialNetWeightG,
				),
				UsedG:       decimalString(fill.UsedG),
				LeftoverG:   decimalString(fill.LeftoverG),
				Outcome:     FillOutcome(outcome),
				FilledAt:    fill.FilledAt,
				ClosedAt:    fill.ClosedAt.Time,
				Identifiers: identifiers,
			},
		)
	}
	return item, nil
}

func (s *Service) GetFilamentSpool(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
) (FilamentSpool, error) {
	if err := require(p, authorization.InventoryRead); err != nil {
		return FilamentSpool{}, err
	}
	return s.loadSpool(ctx, machinelogbookdb.New(s.pool), id, true)
}

func validSpoolStatus(status SpoolStatus) bool {
	return status == SpoolStatusLoaded || status == SpoolStatusNeedsRefill || status == SpoolStatusActive ||
		status == SpoolStatusArchived
}

func (s *Service) ListFilamentSpools(
	ctx context.Context,
	p authorization.Principal,
	f SpoolFilters,
) ([]FilamentSpool, int64, error) {
	if err := require(p, authorization.InventoryRead); err != nil {
		return nil, 0, err
	}
	if f.Lifecycle != "" && f.Lifecycle != SpoolActive && f.Lifecycle != SpoolArchived {
		return nil, 0, apperror.Invalid("invalid spool lifecycle")
	}
	if f.Kind != "" && f.Kind != SpoolReusable && f.Kind != SpoolSingleUse {
		return nil, 0, apperror.Invalid("invalid spool kind")
	}
	statuses := make([]string, 0, len(f.Statuses))
	for _, status := range f.Statuses {
		if !validSpoolStatus(status) {
			return nil, 0, apperror.Invalid("invalid spool status")
		}
		statuses = append(statuses, string(status))
	}
	offset, limit, err := pageBounds(f.Page, f.PageSize)
	if err != nil {
		return nil, 0, err
	}
	q := machinelogbookdb.New(s.pool)
	params := machinelogbookdb.ListFilamentSpoolsParams{
		Search:     strings.TrimSpace(f.Search),
		MaterialID: f.MaterialID,
		Lifecycle:  string(f.Lifecycle),
		Location: strings.TrimSpace(
			f.Location,
		),
		Kind:         string(f.Kind),
		Statuses:     statuses,
		Mounted:      f.Mounted,
		Manufacturer: strings.TrimSpace(f.Manufacturer),
		Consumable:   f.Consumable,
		PageOffset:   offset,
		PageLimit:    limit,
	}
	rows, err := q.ListFilamentSpools(ctx, params)
	if err != nil {
		return nil, 0, err
	}
	total, err := q.CountFilamentSpools(
		ctx,
		machinelogbookdb.CountFilamentSpoolsParams{
			Search:       params.Search,
			MaterialID:   params.MaterialID,
			Lifecycle:    params.Lifecycle,
			Location:     params.Location,
			Kind:         params.Kind,
			Statuses:     params.Statuses,
			Mounted:      params.Mounted,
			Manufacturer: params.Manufacturer,
			Consumable:   params.Consumable,
		},
	)
	if err != nil {
		return nil, 0, err
	}
	items := make([]FilamentSpool, 0, len(rows))
	for _, row := range rows {
		item := spoolFromList(row)
		identifiers, listErr := q.ListFilamentSpoolIdentifiers(ctx, item.ID)
		if listErr != nil {
			return nil, 0, listErr
		}
		item.Identifiers = identifiersFromRows(identifiers)
		items = append(items, item)
	}
	return items, total, nil
}

func (s *Service) LookupFilamentSpool(
	ctx context.Context,
	p authorization.Principal,
	kind IdentifierKind,
	value string,
) (FilamentSpool, error) {
	if err := require(p, authorization.InventoryRead); err != nil {
		return FilamentSpool{}, err
	}
	if kind != IdentifierBarcode && kind != IdentifierQR && kind != IdentifierNFC {
		return FilamentSpool{}, apperror.Invalid("invalid identifier kind")
	}
	id, err := machinelogbookdb.New(s.pool).
		FindFilamentSpoolByIdentifier(
			ctx,
			machinelogbookdb.FindFilamentSpoolByIdentifierParams{Kind: string(kind), Value: strings.TrimSpace(value)},
		)
	if err != nil {
		return FilamentSpool{}, noRows(err)
	}
	return s.loadSpool(ctx, machinelogbookdb.New(s.pool), id, false)
}

func validSpoolKind(kind SpoolKind) bool { return kind == SpoolReusable || kind == SpoolSingleUse }

func validateOptionalText(value *string, field string, max int) (*string, error) {
	value = optional.Trimmed(value)
	if value != nil && len(*value) > max {
		return nil, apperror.Invalid(fmt.Sprintf("%s must be at most %d characters", field, max))
	}
	return value, nil
}

func (s *Service) CreateFilamentSpool(
	ctx context.Context,
	p authorization.Principal,
	input FilamentSpoolInput,
	requestID *uuid.UUID,
) (FilamentSpool, error) {
	if err := require(p, authorization.FilamentSpoolsManage); err != nil {
		return FilamentSpool{}, err
	}
	if err := require(p, authorization.InventoryManage); err != nil {
		return FilamentSpool{}, err
	}
	if input.StockMode != StockModeNewAcquisition && input.StockMode != StockModeExistingStock &&
		input.StockMode != StockModeEmpty {
		return FilamentSpool{}, apperror.Invalid("invalid stockMode")
	}
	kind := input.Kind
	if kind == "" {
		kind = SpoolSingleUse
	}
	if !validSpoolKind(kind) {
		return FilamentSpool{}, apperror.Invalid("invalid spool kind")
	}
	empty := input.StockMode == StockModeEmpty
	if empty && kind != SpoolReusable {
		return FilamentSpool{}, unprocessable(
			"empty_requires_reusable",
			"Only reusable spools can be registered without a fill",
		)
	}
	var weight decimal.Decimal
	if !empty {
		if input.MaterialID == uuid.Nil {
			return FilamentSpool{}, apperror.Invalid("materialId is required unless the spool is registered empty")
		}
		var parseErr error
		if weight, parseErr = parseDecimal(input.InitialNetWeightG, true); parseErr != nil {
			return FilamentSpool{}, parseErr
		}
		if input.ExpectedInventoryVersion < 1 {
			return FilamentSpool{}, apperror.Invalid(
				"expectedInventoryVersion is required unless the spool is registered empty",
			)
		}
	}
	supplier, err := validateOptionalText(input.Supplier, "supplier", 200)
	if err != nil {
		return FilamentSpool{}, err
	}
	label, err := validateOptionalText(&input.Label, "label", 120)
	if err != nil {
		return FilamentSpool{}, err
	}
	if input.OccurredAt.IsZero() {
		return FilamentSpool{}, apperror.Invalid("occurredAt is required")
	}
	tare, err := pgNullableNumeric(input.TareWeightG, false)
	if err != nil || (tare.Valid && decimalFromNumeric(tare).IsNegative()) {
		return FilamentSpool{}, apperror.Invalid("tareWeightG must be non-negative")
	}
	manufacturer, err := validateOptionalText(input.Manufacturer, "manufacturer", 150)
	if err != nil {
		return FilamentSpool{}, err
	}
	productName, err := validateOptionalText(input.ProductName, "productName", 200)
	if err != nil {
		return FilamentSpool{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FilamentSpool{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	var material machinelogbookdb.GetMaterialForUpdateRow
	var detail machinelogbookdb.GetMaterialRow
	if !empty {
		material, err = q.GetMaterialForUpdate(ctx, input.MaterialID)
		if err != nil {
			return FilamentSpool{}, noRows(err)
		}
		if material.InventoryVersion != input.ExpectedInventoryVersion {
			return FilamentSpool{}, apperror.StaleWrite
		}
		manufacturer, err = s.checkFillMaterial(ctx, q, input.MaterialID, manufacturer)
		if err != nil {
			return FilamentSpool{}, err
		}
		detail, err = q.GetMaterial(ctx, input.MaterialID)
		if err != nil {
			return FilamentSpool{}, err
		}
	}
	sequence, err := q.NextFilamentSpoolSequence(ctx)
	if err != nil {
		return FilamentSpool{}, err
	}
	id := ids.New()
	spool, err := q.CreateFilamentSpool(
		ctx,
		machinelogbookdb.CreateFilamentSpoolParams{
			ID:          id,
			DisplayID:   fmt.Sprintf("S-%04d-%06d", s.now().UTC().Year(), sequence),
			Kind:        string(kind),
			Label:       label,
			TareWeightG: tare,
			AcquiredOn: pgDate(
				input.AcquiredOn,
			),
			AcquisitionReference: optional.Trimmed(input.AcquisitionReference),
			StorageLocation:      optional.Trimmed(input.StorageLocation),
			Notes:                optional.Trimmed(input.Notes),
		},
	)
	if err != nil {
		return FilamentSpool{}, databaseError(err)
	}
	if !empty {
		err = s.fillNewSpool(
			ctx,
			tx,
			q,
			p,
			input,
			spool,
			material,
			detail,
			weight,
			manufacturer,
			productName,
			supplier,
			requestID,
		)
		if err != nil {
			return FilamentSpool{}, err
		}
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"filament_spool.created",
		"filament_spool",
		id,
		requestID,
		[]string{"materialId", "kind", "label", "stockMode", "inventory", "metadata"},
	); err != nil {
		return FilamentSpool{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return FilamentSpool{}, err
	}
	return s.loadSpool(ctx, machinelogbookdb.New(s.pool), id, false)
}

// fillNewSpool opens the first fill of a freshly created spool and books the
// matching inventory movement (purchase or transfer from loose stock).
func (s *Service) fillNewSpool(
	ctx context.Context,
	tx pgx.Tx,
	q *machinelogbookdb.Queries,
	p authorization.Principal,
	input FilamentSpoolInput,
	spool machinelogbookdb.FilamentSpool,
	material machinelogbookdb.GetMaterialForUpdateRow,
	detail machinelogbookdb.GetMaterialRow,
	weight decimal.Decimal,
	manufacturer, productName, supplier *string,
	requestID *uuid.UUID,
) error {
	fill, err := q.InsertFilamentSpoolFill(
		ctx,
		machinelogbookdb.InsertFilamentSpoolFillParams{
			ID:                ids.New(),
			SpoolID:           spool.ID,
			FillNumber:        1,
			MaterialID:        input.MaterialID,
			Manufacturer:      manufacturer,
			ProductName:       productName,
			InitialNetWeightG: numericFromDecimal(weight),
			FilledAt:          input.OccurredAt.UTC(),
		},
	)
	if err != nil {
		return databaseError(err)
	}
	ref := fillRef{
		SpoolID:        spool.ID,
		FillID:         fill.ID,
		SpoolDisplayID: spool.DisplayID,
		FillNumber:     fill.FillNumber,
		MaterialID:     input.MaterialID,
	}
	if input.StockMode == StockModeNewAcquisition {
		if input.TotalPrice == nil {
			return apperror.Invalid("totalPrice is required for a new acquisition")
		}
		price, parseErr := parseDecimal(*input.TotalPrice, false)
		if parseErr != nil || price.IsNegative() {
			return apperror.Invalid("totalPrice must be non-negative")
		}
		_, err = s.applyInventoryMutation(
			ctx,
			tx,
			q,
			p,
			input.MaterialID,
			input.ExpectedInventoryVersion,
			inventoryMutation{
				Kind:          InventoryPurchase,
				QuantityDelta: weight,
				UnitCost:      price.Div(weight),
				ValueDelta:    price,
				TotalPrice:    &price,
				OccurredAt:    input.OccurredAt,
				Supplier:      supplier,
				Note:          input.Notes,
				Fill:          &ref,
			},
			requestID,
		)
	} else {
		unassigned := decimalFromNumeric(material.Quantity).Sub(decimalFromNumeric(detail.AssignedQuantity))
		if unassigned.LessThan(weight) {
			return apperror.Conflicting("insufficient_unassigned_stock", "Not enough unassigned material stock")
		}
		err = s.insertFillTransfer(
			ctx,
			q,
			p,
			input.MaterialID,
			input.ExpectedInventoryVersion,
			nil,
			&ref,
			weight,
			input.OccurredAt,
			input.Notes,
		)
		if err == nil {
			_, err = q.BumpFilamentSpoolVersion(
				ctx,
				machinelogbookdb.BumpFilamentSpoolVersionParams{ID: spool.ID, ExpectedVersion: 1},
			)
		}
	}
	return databaseError(err)
}

func (s *Service) UpdateFilamentSpool(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	in FilamentSpoolUpdate,
	requestID *uuid.UUID,
) (FilamentSpool, error) {
	if err := require(p, authorization.FilamentSpoolsManage); err != nil {
		return FilamentSpool{}, err
	}
	if in.ExpectedVersion < 1 || (in.Lifecycle != SpoolActive && in.Lifecycle != SpoolArchived) ||
		(in.Kind != nil && !validSpoolKind(*in.Kind)) {
		return FilamentSpool{}, apperror.Invalid("invalid spool update")
	}
	tare, err := pgNullableNumeric(in.TareWeightG, false)
	if err != nil || (tare.Valid && decimalFromNumeric(tare).IsNegative()) {
		return FilamentSpool{}, apperror.Invalid("tareWeightG must be non-negative")
	}
	label, err := validateOptionalText(in.Label, "label", 120)
	if err != nil {
		return FilamentSpool{}, err
	}
	manufacturer, err := validateOptionalText(in.Manufacturer, "manufacturer", 150)
	if err != nil {
		return FilamentSpool{}, err
	}
	productName, err := validateOptionalText(in.ProductName, "productName", 200)
	if err != nil {
		return FilamentSpool{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FilamentSpool{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	current, err := q.GetFilamentSpoolForUpdate(ctx, id)
	if err != nil {
		return FilamentSpool{}, noRows(err)
	}
	if current.Version != in.ExpectedVersion {
		return FilamentSpool{}, apperror.StaleWrite
	}
	kind := SpoolKind(current.Kind)
	if in.Kind != nil {
		kind = *in.Kind
	}
	open, openErr := q.GetOpenFilamentSpoolFill(ctx, id)
	hasOpen := openErr == nil
	if openErr != nil && !errors.Is(openErr, pgx.ErrNoRows) {
		return FilamentSpool{}, openErr
	}
	archivedAt := current.ArchivedAt
	switch {
	case in.Lifecycle == SpoolArchived && SpoolLifecycle(current.Lifecycle) != SpoolArchived:
		if hasOpen && !decimalFromNumeric(open.RemainingQuantity).IsZero() {
			return FilamentSpool{}, apperror.Conflicting(
				"spool_has_stock",
				"A spool must be empty before it is archived",
			)
		}
		archivedAt = pgTimestamp(s.now())
		actor := p.AccountID
		if _, err = q.UnmountFilamentSpool(
			ctx,
			machinelogbookdb.UnmountFilamentSpoolParams{
				UnmountedAt:    s.now().UTC(),
				ActorAccountID: &actor,
				SpoolID:        id,
			},
		); err != nil {
			return FilamentSpool{}, err
		}
	case in.Lifecycle == SpoolActive && SpoolLifecycle(current.Lifecycle) == SpoolArchived:
		if kind == SpoolSingleUse && !hasOpen {
			return FilamentSpool{}, apperror.Conflicting(
				"spool_without_fill",
				"A finished single-use spool cannot be restored",
			)
		}
		archivedAt = pgtype.Timestamptz{}
	}
	_, err = q.UpdateFilamentSpool(
		ctx,
		machinelogbookdb.UpdateFilamentSpoolParams{
			Kind:                 string(kind),
			Label:                label,
			TareWeightG:          tare,
			AcquiredOn:           pgDate(in.AcquiredOn),
			AcquisitionReference: optional.Trimmed(in.AcquisitionReference),
			StorageLocation: optional.Trimmed(
				in.StorageLocation,
			),
			Notes:           optional.Trimmed(in.Notes),
			Lifecycle:       string(in.Lifecycle),
			ArchivedAt:      archivedAt,
			ID:              id,
			ExpectedVersion: in.ExpectedVersion,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return FilamentSpool{}, apperror.StaleWrite
	}
	if err != nil {
		return FilamentSpool{}, databaseError(err)
	}
	if hasOpen {
		if _, err = q.UpdateOpenFilamentSpoolFillSnapshot(
			ctx,
			machinelogbookdb.UpdateOpenFilamentSpoolFillSnapshotParams{
				Manufacturer: manufacturer,
				ProductName:  productName,
				SpoolID:      id,
			},
		); err != nil {
			return FilamentSpool{}, databaseError(err)
		}
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"filament_spool.updated",
		"filament_spool",
		id,
		requestID,
		[]string{"kind", "label", "manufacturer", "productName", "tareWeightG", "storageLocation", "lifecycle"},
	); err != nil {
		return FilamentSpool{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return FilamentSpool{}, err
	}
	return s.loadSpool(ctx, machinelogbookdb.New(s.pool), id, false)
}

func (s *Service) AddFilamentSpoolIdentifier(
	ctx context.Context,
	p authorization.Principal,
	spoolID uuid.UUID,
	kind IdentifierKind,
	value string,
	requestID *uuid.UUID,
) (FilamentSpoolIdentifier, error) {
	if err := require(p, authorization.FilamentSpoolsManage); err != nil {
		return FilamentSpoolIdentifier{}, err
	}
	value = strings.TrimSpace(value)
	if (kind != IdentifierBarcode && kind != IdentifierQR && kind != IdentifierNFC) || value == "" || len(value) > 255 {
		return FilamentSpoolIdentifier{}, apperror.Invalid("invalid spool identifier")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FilamentSpoolIdentifier{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	if _, err = q.GetFilamentSpoolForUpdate(ctx, spoolID); err != nil {
		return FilamentSpoolIdentifier{}, noRows(err)
	}
	open, err := q.GetOpenFilamentSpoolFill(ctx, spoolID)
	if errors.Is(err, pgx.ErrNoRows) {
		return FilamentSpoolIdentifier{}, apperror.Conflicting("no_open_fill", "The spool has no open fill to tag")
	}
	if err != nil {
		return FilamentSpoolIdentifier{}, err
	}
	row, err := q.AddFilamentSpoolIdentifier(
		ctx,
		machinelogbookdb.AddFilamentSpoolIdentifierParams{
			ID:      ids.New(),
			SpoolID: spoolID,
			FillID:  open.ID,
			Kind:    string(kind),
			Value:   value,
		},
	)
	if err != nil {
		return FilamentSpoolIdentifier{}, databaseError(err)
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"filament_spool.identifier_added",
		"filament_spool",
		spoolID,
		requestID,
		[]string{"identifiers"},
	); err != nil {
		return FilamentSpoolIdentifier{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return FilamentSpoolIdentifier{}, err
	}
	return identifierFromRow(row), nil
}

func (s *Service) DeleteFilamentSpoolIdentifier(
	ctx context.Context,
	p authorization.Principal,
	spoolID, identifierID uuid.UUID,
	requestID *uuid.UUID,
) error {
	if err := require(p, authorization.FilamentSpoolsManage); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	rows, err := q.DeleteFilamentSpoolIdentifier(
		ctx,
		machinelogbookdb.DeleteFilamentSpoolIdentifierParams{ID: identifierID, SpoolID: spoolID},
	)
	if err != nil {
		return err
	}
	if rows == 0 {
		return apperror.NotFound
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"filament_spool.identifier_removed",
		"filament_spool",
		spoolID,
		requestID,
		[]string{"identifiers"},
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) TransferSpoolStock(
	ctx context.Context,
	p authorization.Principal,
	materialID uuid.UUID,
	expected int64,
	fromID, toID *uuid.UUID,
	quantity string,
	occurredAt time.Time,
	note *string,
	requestID *uuid.UUID,
) (InventoryTransaction, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return InventoryTransaction{}, err
	}
	qty, err := parseDecimal(quantity, true)
	if err != nil {
		return InventoryTransaction{}, err
	}
	if (fromID == nil && toID == nil) || (fromID != nil && toID != nil && *fromID == *toID) || occurredAt.IsZero() {
		return InventoryTransaction{}, apperror.Invalid("invalid spool transfer")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return InventoryTransaction{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	material, err := q.GetMaterialForUpdate(ctx, materialID)
	if err != nil {
		return InventoryTransaction{}, noRows(err)
	}
	if material.InventoryVersion != expected {
		return InventoryTransaction{}, apperror.StaleWrite
	}
	detail, err := q.GetMaterial(ctx, materialID)
	if err != nil {
		return InventoryTransaction{}, err
	}
	ids := make([]uuid.UUID, 0, 2)
	for _, spoolID := range []*uuid.UUID{fromID, toID} {
		if spoolID != nil {
			ids = append(ids, *spoolID)
		}
	}
	sort.Slice(ids, func(i, j int) bool { return strings.Compare(ids[i].String(), ids[j].String()) < 0 })
	refs := map[uuid.UUID]fillRef{}
	versions := map[uuid.UUID]int64{}
	for _, spoolID := range ids {
		spool, ref, remaining, spoolErr := s.lockConsumableFill(ctx, q, spoolID)
		if spoolErr != nil {
			return InventoryTransaction{}, spoolErr
		}
		if ref.MaterialID != materialID {
			return InventoryTransaction{}, apperror.Conflicting(
				"spool_material_mismatch",
				"Spools must belong to the selected material",
			)
		}
		refs[spoolID] = ref
		versions[spoolID] = spool.Version
		if fromID != nil && spoolID == *fromID && remaining.LessThan(qty) {
			return InventoryTransaction{}, apperror.Conflicting(
				"insufficient_spool_stock",
				"Source spool does not contain enough stock",
			)
		}
	}
	if fromID == nil &&
		decimalFromNumeric(material.Quantity).Sub(decimalFromNumeric(detail.AssignedQuantity)).LessThan(qty) {
		return InventoryTransaction{}, apperror.Conflicting(
			"insufficient_unassigned_stock",
			"Not enough unassigned stock",
		)
	}
	var from, to *fillRef
	if fromID != nil {
		ref := refs[*fromID]
		from = &ref
	}
	if toID != nil {
		ref := refs[*toID]
		to = &ref
	}
	row, err := s.insertFillTransferRow(ctx, q, p, materialID, expected, from, to, qty, occurredAt, note)
	if err != nil {
		return InventoryTransaction{}, databaseError(err)
	}
	for id, version := range versions {
		if _, err = q.BumpFilamentSpoolVersion(
			ctx,
			machinelogbookdb.BumpFilamentSpoolVersionParams{ID: id, ExpectedVersion: version},
		); err != nil {
			return InventoryTransaction{}, err
		}
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"inventory.spool_transfer",
		"material",
		materialID,
		requestID,
		[]string{"attribution", "inventoryVersion"},
	); err != nil {
		return InventoryTransaction{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return InventoryTransaction{}, err
	}
	return transactionFromRow(row), nil
}

func (s *Service) ConsumeFilamentSpool(
	ctx context.Context,
	p authorization.Principal,
	spoolID uuid.UUID,
	expectedInventory, expectedSpool int64,
	quantity string,
	occurredAt time.Time,
	disposal bool,
	reason, note *string,
	requestID *uuid.UUID,
) (InventoryMutationResult, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return InventoryMutationResult{}, err
	}
	qty, err := parseDecimal(quantity, true)
	if err != nil || occurredAt.IsZero() {
		return InventoryMutationResult{}, apperror.Invalid("valid quantity and occurredAt are required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	spool, ref, _, err := s.lockConsumableFill(ctx, q, spoolID)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	if spool.Version != expectedSpool {
		return InventoryMutationResult{}, apperror.StaleWrite
	}
	material, err := q.GetMaterialForUpdate(ctx, ref.MaterialID)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	if material.InventoryVersion != expectedInventory {
		return InventoryMutationResult{}, apperror.StaleWrite
	}
	kind := InventoryManualConsumption
	if disposal {
		kind = InventoryDisposal
	}
	average := decimalFromNumeric(material.AverageUnitCost)
	result, err := s.applyInventoryMutation(
		ctx,
		tx,
		q,
		p,
		ref.MaterialID,
		expectedInventory,
		inventoryMutation{
			Kind:          kind,
			QuantityDelta: qty.Neg(),
			UnitCost:      average,
			ValueDelta:    qty.Mul(average).Neg(),
			OccurredAt:    occurredAt,
			Reason:        optional.Trimmed(reason),
			Note:          note,
			Fill:          &ref,
		},
		requestID,
	)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return InventoryMutationResult{}, err
	}
	return result, nil
}

func (s *Service) CorrectFilamentSpoolStock(
	ctx context.Context,
	p authorization.Principal,
	spoolID uuid.UUID,
	expectedInventory, expectedSpool int64,
	physical string,
	acquisitionCost *string,
	occurredAt time.Time,
	reason string,
	note *string,
	requestID *uuid.UUID,
) (InventoryMutationResult, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return InventoryMutationResult{}, err
	}
	physicalQty, err := parseDecimal(physical, false)
	if err != nil || physicalQty.IsNegative() || strings.TrimSpace(reason) == "" || occurredAt.IsZero() {
		return InventoryMutationResult{}, apperror.Invalid("invalid spool correction")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	spool, ref, remaining, err := s.lockConsumableFill(ctx, q, spoolID)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	if spool.Version != expectedSpool {
		return InventoryMutationResult{}, apperror.StaleWrite
	}
	material, err := q.GetMaterialForUpdate(ctx, ref.MaterialID)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	if material.InventoryVersion != expectedInventory {
		return InventoryMutationResult{}, apperror.StaleWrite
	}
	delta := physicalQty.Sub(remaining)
	if delta.IsZero() {
		return InventoryMutationResult{}, apperror.Invalid("physicalQuantity equals current spool stock")
	}
	unitCost := decimalFromNumeric(material.AverageUnitCost)
	if delta.IsPositive() && unitCost.IsZero() {
		if acquisitionCost == nil {
			return InventoryMutationResult{}, apperror.Invalid(
				"acquisitionUnitCost is required without an average cost",
			)
		}
		unitCost, err = parseDecimal(*acquisitionCost, false)
		if err != nil || unitCost.IsNegative() {
			return InventoryMutationResult{}, apperror.Invalid("invalid acquisitionUnitCost")
		}
	}
	reason = strings.TrimSpace(reason)
	result, err := s.applyInventoryMutation(
		ctx,
		tx,
		q,
		p,
		ref.MaterialID,
		expectedInventory,
		inventoryMutation{
			Kind:          InventoryAdjustment,
			QuantityDelta: delta,
			UnitCost:      unitCost,
			ValueDelta:    delta.Mul(unitCost),
			OccurredAt:    occurredAt,
			Reason:        &reason,
			Note:          note,
			Fill:          &ref,
		},
		requestID,
	)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return InventoryMutationResult{}, err
	}
	return result, nil
}

func transactionFromSpoolList(row machinelogbookdb.ListFilamentSpoolTransactionsRow) InventoryTransaction {
	return transactionFromList(machinelogbookdb.ListInventoryTransactionsRow(row))
}

func (s *Service) ListFilamentSpoolTransactions(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	page, pageSize int,
) ([]InventoryTransaction, int64, error) {
	if err := require(p, authorization.InventoryRead); err != nil {
		return nil, 0, err
	}
	offset, limit, err := pageBounds(page, pageSize)
	if err != nil {
		return nil, 0, err
	}
	q := machinelogbookdb.New(s.pool)
	if _, err = q.GetFilamentSpool(ctx, id); err != nil {
		return nil, 0, noRows(err)
	}
	rows, err := q.ListFilamentSpoolTransactions(
		ctx,
		machinelogbookdb.ListFilamentSpoolTransactionsParams{SpoolID: &id, PageOffset: offset, PageLimit: limit},
	)
	if err != nil {
		return nil, 0, err
	}
	total, err := q.CountFilamentSpoolTransactions(ctx, &id)
	if err != nil {
		return nil, 0, err
	}
	items := make([]InventoryTransaction, 0, len(rows))
	for _, row := range rows {
		items = append(items, transactionFromSpoolList(row))
	}
	return items, total, nil
}
