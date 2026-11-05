package machinelogbook

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
)

// spoolRemainderLowShare is the share of the initial net weight below which an
// active spool is flagged remainder_low.
var spoolRemainderLowShare = decimal.NewFromFloat(0.1)

// spoolRef identifies the spool a ledger row or job usage is attributed to,
// with the label snapshot that stays readable after the spool is deleted.
type spoolRef struct {
	SpoolID        uuid.UUID
	SpoolDisplayID string
	MaterialID     uuid.UUID
}

func unprocessable(code, message string) error {
	return apperror.New(http.StatusUnprocessableEntity, code, message)
}

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

// spoolAttention flags an active spool that holds less than 10 % of its initial net weight, and one that ran
// out during a print (ranOutRun is the run's display id; empty when it did not). Running out is only a
// suggestion: Core keeps the spool and its remainder until staff retire, weigh, correct or mount it.
func spoolAttention(lifecycle SpoolLifecycle, initial, remaining decimal.Decimal, unit, ranOutRun string) []Attention {
	items := []Attention{}
	if lifecycle != SpoolActive {
		return items
	}
	if ranOutRun != "" {
		items = append(items, Attention{
			Code: AttentionRanOutDuringRun,
			Message: fmt.Sprintf(
				"Ran out during %s; Core still holds %s %s. Retire or weigh it.",
				ranOutRun, remaining.Round(1).String(), unit,
			),
		})
	}
	if !initial.IsPositive() {
		return items
	}
	if remaining.LessThan(initial.Mul(spoolRemainderLowShare)) {
		items = append(items, Attention{
			Code: AttentionRemainderLow,
			Message: fmt.Sprintf(
				"Less than 10 %% left: %s %s of %s %s",
				remaining.Round(1).String(), unit, initial.Round(1).String(), unit,
			),
		})
	}
	return items
}

// ranOutRun names the run a spool ran out during, or is empty.
func ranOutRun(ranOut bool, runDisplayID string) string {
	if !ranOut {
		return ""
	}
	return runDisplayID
}

func spoolFromGet(row machinelogbookdb.GetFilamentSpoolRow) FilamentSpool {
	initial := decimalFromNumeric(row.InitialNetWeightG)
	remaining := decimalFromNumeric(row.RemainingQuantity)
	lifecycle := SpoolLifecycle(row.Lifecycle)
	return FilamentSpool{
		ID:                   row.ID,
		DisplayID:            row.DisplayID,
		MaterialID:           row.MaterialID,
		MaterialDisplayID:    row.MaterialDisplayID,
		MaterialName:         row.MaterialName,
		MaterialTypeName:     row.MaterialTypeName,
		Unit:                 row.Unit,
		ColorName:            row.ColorName,
		ColorHex:             row.ColorHex,
		Manufacturer:         row.Manufacturer,
		InitialNetWeightG:    initial.String(),
		RemainingQuantity:    remaining.String(),
		TareWeightG:          nullableDecimal(row.TareWeightG),
		AcquiredOn:           spoolDate(row.AcquiredOn),
		AcquisitionReference: row.AcquisitionReference,
		StorageLocation:      row.StorageLocation,
		Notes:                row.Notes,
		Lifecycle:            lifecycle,
		ArchivedAt:           nullableTime(row.ArchivedAt),
		RetiredOutcome:       optional.Convert[SpoolRetireOutcome](row.RetiredOutcome),
		RetiredQuantity:      nullableDecimal(row.RetiredQuantity),
		RetiredByName:        personName(row.RetiredByFirstName, row.RetiredByLastName),
		Mounted:              row.Mounted,
		MountedOn: spoolMount(
			row.MountMachineID,
			row.MountMachineName,
			row.MountInputUnitName,
			row.MountSlotID,
			row.MountSlotName,
		),
		Identifiers:     []FilamentSpoolIdentifier{},
		Attention:       spoolAttention(lifecycle, initial, remaining, row.Unit, ranOutRun(row.RanOut, row.RanOutRunDisplayID)),
		Version:         row.Version,
		CreatedAt:       row.CreatedAt,
		UpdatedAt:       row.UpdatedAt,
		materialDeleted: row.MaterialDeletedAt.Valid,
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

func (s *Service) loadSpool(ctx context.Context, q *machinelogbookdb.Queries, id uuid.UUID) (FilamentSpool, error) {
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
	return item, nil
}

// GetFilamentSpool returns a spool; spools of articles in the recycle bin are not found.
func (s *Service) GetFilamentSpool(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
) (FilamentSpool, error) {
	if err := require(p, authorization.InventoryRead); err != nil {
		return FilamentSpool{}, err
	}
	spool, err := s.loadSpool(ctx, machinelogbookdb.New(s.pool), id)
	if err != nil {
		return FilamentSpool{}, err
	}
	if spool.materialDeleted {
		return FilamentSpool{}, apperror.NotFound
	}
	return spool, nil
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
	offset, limit, err := pageBounds(f.Page, f.PageSize)
	if err != nil {
		return nil, 0, err
	}
	q := machinelogbookdb.New(s.pool)
	params := machinelogbookdb.ListFilamentSpoolsParams{
		Search:       strings.TrimSpace(f.Search),
		MaterialID:   f.MaterialID,
		Lifecycle:    string(f.Lifecycle),
		Location:     strings.TrimSpace(f.Location),
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
	if !validIdentifierKind(kind) {
		return FilamentSpool{}, apperror.Invalid("invalid identifier kind")
	}
	q := machinelogbookdb.New(s.pool)
	id, err := q.FindFilamentSpoolByIdentifier(
		ctx,
		machinelogbookdb.FindFilamentSpoolByIdentifierParams{Kind: string(kind), Value: strings.TrimSpace(value)},
	)
	if err != nil {
		return FilamentSpool{}, noRows(err)
	}
	spool, err := s.loadSpool(ctx, q, id)
	if err != nil {
		return FilamentSpool{}, err
	}
	if spool.materialDeleted {
		return FilamentSpool{}, apperror.NotFound
	}
	return spool, nil
}

func validIdentifierKind(kind IdentifierKind) bool {
	return kind == IdentifierBarcode || kind == IdentifierQR || kind == IdentifierNFC || kind == IdentifierBambuTrayUUID
}

func validateOptionalText(value *string, field string, max int) (*string, error) {
	value = optional.Trimmed(value)
	if value != nil && len(*value) > max {
		return nil, apperror.Invalid(fmt.Sprintf("%s must be at most %d characters", field, max))
	}
	return value, nil
}

// checkSpoolMaterial refuses articles that cannot be put on spools: only filament articles outside the recycle
// bin can.
func checkSpoolMaterial(detail machinelogbookdb.GetMaterialRow) error {
	if detail.DeletedAt.Valid {
		return errMaterialInBin
	}
	if MaterialKind(detail.MaterialKind) != KindFilament || !detail.DiameterMm.Valid {
		return apperror.Conflicting("material_not_filament", "Spools require a filament article")
	}
	return nil
}

// lockConsumableSpool locks an active spool and returns its reference and remaining quantity. Archived spools
// and spools of articles in the recycle bin cannot take stock movements.
func (s *Service) lockConsumableSpool(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	spoolID uuid.UUID,
) (machinelogbookdb.FilamentSpool, spoolRef, decimal.Decimal, error) {
	spool, err := q.GetFilamentSpoolForUpdate(ctx, spoolID)
	if err != nil {
		return spool, spoolRef{}, decimal.Zero, noRows(err)
	}
	if SpoolLifecycle(spool.Lifecycle) != SpoolActive {
		return spool, spoolRef{}, decimal.Zero, apperror.Conflicting(
			"spool_not_consumable",
			"The spool is retired",
		)
	}
	remaining, err := q.GetSpoolRemaining(ctx, spoolID)
	if err != nil {
		return spool, spoolRef{}, decimal.Zero, err
	}
	ref := spoolRef{SpoolID: spool.ID, SpoolDisplayID: spool.DisplayID, MaterialID: spool.MaterialID}
	return spool, ref, decimalFromNumeric(remaining), nil
}

// insertSpoolTransferRow moves stock between a spool and loose stock (or between two spools). Totals stay
// unchanged; the balance version still advances so stale clients notice. from or to may be nil for loose stock.
func (s *Service) insertSpoolTransferRow(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	p authorization.Principal,
	materialID uuid.UUID,
	expected int64,
	from, to *spoolRef,
	quantity decimal.Decimal,
	occurredAt time.Time,
	note *string,
) (machinelogbookdb.InventoryTransaction, error) {
	material, err := q.GetMaterialForUpdate(ctx, materialID)
	if err != nil {
		return machinelogbookdb.InventoryTransaction{}, noRows(err)
	}
	if expected != anyInventoryVersion && material.InventoryVersion != expected {
		return machinelogbookdb.InventoryTransaction{}, apperror.StaleWrite
	}
	if _, err = q.UpdateMaterialBalance(
		ctx,
		machinelogbookdb.UpdateMaterialBalanceParams{
			Quantity:        material.Quantity,
			InventoryValue:  material.InventoryValue,
			AverageUnitCost: material.AverageUnitCost,
			MaterialID:      materialID,
			ExpectedVersion: material.InventoryVersion,
		},
	); err != nil {
		return machinelogbookdb.InventoryTransaction{}, err
	}
	actor := p.AccountID
	params := machinelogbookdb.InsertSpoolTransferParams{
		ID:               ids.New(),
		MaterialID:       materialID,
		OccurredAt:       occurredAt.UTC(),
		Note:             optional.Trimmed(note),
		ActorAccountID:   &actor,
		TransferQuantity: numericFromDecimal(quantity),
	}
	if from != nil {
		params.FromSpoolID, params.FromSpoolDisplayID = &from.SpoolID, &from.SpoolDisplayID
	}
	if to != nil {
		params.ToSpoolID, params.ToSpoolDisplayID = &to.SpoolID, &to.SpoolDisplayID
	}
	return q.InsertSpoolTransfer(ctx, params)
}

// lockMaterials locks material balances in ascending id order so concurrent
// compound operations cannot deadlock.
func lockMaterials(ctx context.Context, q *machinelogbookdb.Queries, ids ...uuid.UUID) error {
	sort.Slice(ids, func(i, j int) bool { return bytes.Compare(ids[i][:], ids[j][:]) < 0 })
	for i, id := range ids {
		if i > 0 && ids[i-1] == id {
			continue
		}
		if _, err := q.GetMaterialForUpdate(ctx, id); err != nil {
			return noRows(err)
		}
	}
	return nil
}

// addSpoolIdentifiers tags a spool; an identifier that is in use stays refused.
func addSpoolIdentifiers(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	spoolID uuid.UUID,
	identifiers []NewSpoolIdentifier,
) error {
	for _, identifier := range identifiers {
		inUse, err := q.FilamentSpoolIdentifierInUse(
			ctx,
			machinelogbookdb.FilamentSpoolIdentifierInUseParams{Kind: string(identifier.Kind), Value: identifier.Value},
		)
		if err != nil {
			return err
		}
		if inUse {
			return apperror.Conflicting("identifier_in_use", "An identifier is already assigned to a spool")
		}
		if _, err = q.AddFilamentSpoolIdentifier(
			ctx,
			machinelogbookdb.AddFilamentSpoolIdentifierParams{
				ID:      ids.New(),
				SpoolID: spoolID,
				Kind:    string(identifier.Kind),
				Value:   identifier.Value,
			},
		); err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				return apperror.Conflicting("identifier_in_use", "An identifier is already assigned to a spool")
			}
			return databaseError(err)
		}
	}
	return nil
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
	if input.StockMode != StockModeNewAcquisition && input.StockMode != StockModeExistingStock {
		return FilamentSpool{}, apperror.Invalid("invalid stockMode")
	}
	if input.MaterialID == uuid.Nil {
		return FilamentSpool{}, apperror.Invalid("materialId is required")
	}
	weight, err := parseDecimal(input.InitialNetWeightG, true)
	if err != nil {
		return FilamentSpool{}, err
	}
	if input.ExpectedInventoryVersion < 1 {
		return FilamentSpool{}, apperror.Invalid("expectedInventoryVersion is required")
	}
	supplier, err := validateOptionalText(input.Supplier, "supplier", 200)
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
	var price decimal.Decimal
	if input.StockMode == StockModeNewAcquisition {
		if input.TotalPrice == nil {
			return FilamentSpool{}, apperror.Invalid("totalPrice is required for a new acquisition")
		}
		price, err = parseDecimal(*input.TotalPrice, false)
		if err != nil || price.IsNegative() {
			return FilamentSpool{}, apperror.Invalid("totalPrice must be non-negative")
		}
	}
	if input.Identifiers, err = validateNewIdentifiers(input.Identifiers); err != nil {
		return FilamentSpool{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FilamentSpool{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	material, err := q.GetMaterialForUpdate(ctx, input.MaterialID)
	if err != nil {
		return FilamentSpool{}, noRows(err)
	}
	if material.InventoryVersion != input.ExpectedInventoryVersion {
		return FilamentSpool{}, apperror.StaleWrite
	}
	detail, err := q.GetMaterial(ctx, input.MaterialID)
	if err != nil {
		return FilamentSpool{}, err
	}
	if err = checkSpoolMaterial(detail); err != nil {
		return FilamentSpool{}, err
	}
	label, err := nextSpoolLabel(ctx, q, spoolLabelPrefix(detail.MaterialTypeCode, detail.Variant, detail.ColorName))
	if err != nil {
		return FilamentSpool{}, err
	}
	spool, err := q.CreateFilamentSpool(
		ctx,
		machinelogbookdb.CreateFilamentSpoolParams{
			ID:                   ids.New(),
			DisplayID:            label,
			MaterialID:           input.MaterialID,
			InitialNetWeightG:    numericFromDecimal(weight),
			TareWeightG:          tare,
			AcquiredOn:           pgDate(input.AcquiredOn),
			AcquisitionReference: optional.Trimmed(input.AcquisitionReference),
			StorageLocation:      optional.Trimmed(input.StorageLocation),
			Notes:                optional.Trimmed(input.Notes),
		},
	)
	if err != nil {
		return FilamentSpool{}, databaseError(err)
	}
	if err = addSpoolIdentifiers(ctx, q, spool.ID, input.Identifiers); err != nil {
		return FilamentSpool{}, err
	}
	ref := spoolRef{SpoolID: spool.ID, SpoolDisplayID: spool.DisplayID, MaterialID: spool.MaterialID}
	if input.StockMode == StockModeNewAcquisition {
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
				Spool:         &ref,
			},
			requestID,
		)
	} else {
		unassigned := decimalFromNumeric(material.Quantity).Sub(decimalFromNumeric(detail.AssignedQuantity))
		if unassigned.LessThan(weight) {
			return FilamentSpool{}, apperror.Conflicting("insufficient_unassigned_stock", "Not enough unassigned material stock")
		}
		_, err = s.insertSpoolTransferRow(
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
	if err != nil {
		return FilamentSpool{}, databaseError(err)
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"filament_spool.created",
		"filament_spool",
		spool.ID,
		requestID,
		[]string{"materialId", "displayId", "stockMode", "inventory", "metadata"},
	); err != nil {
		return FilamentSpool{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return FilamentSpool{}, err
	}
	return s.loadSpool(ctx, machinelogbookdb.New(s.pool), spool.ID)
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
	if in.ExpectedVersion < 1 {
		return FilamentSpool{}, apperror.Invalid("invalid spool update")
	}
	tare, err := pgNullableNumeric(in.TareWeightG, false)
	if err != nil || (tare.Valid && decimalFromNumeric(tare).IsNegative()) {
		return FilamentSpool{}, apperror.Invalid("tareWeightG must be non-negative")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FilamentSpool{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	current, err := s.loadSpool(ctx, q, id)
	if err != nil {
		return FilamentSpool{}, err
	}
	if current.materialDeleted {
		return FilamentSpool{}, apperror.NotFound
	}
	_, err = q.UpdateFilamentSpool(
		ctx,
		machinelogbookdb.UpdateFilamentSpoolParams{
			TareWeightG:          tare,
			AcquiredOn:           pgDate(in.AcquiredOn),
			AcquisitionReference: optional.Trimmed(in.AcquisitionReference),
			StorageLocation:      optional.Trimmed(in.StorageLocation),
			Notes:                optional.Trimmed(in.Notes),
			ID:                   id,
			ExpectedVersion:      in.ExpectedVersion,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return FilamentSpool{}, apperror.StaleWrite
	}
	if err != nil {
		return FilamentSpool{}, databaseError(err)
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"filament_spool.updated",
		"filament_spool",
		id,
		requestID,
		[]string{"tareWeightG", "acquiredOn", "acquisitionReference", "storageLocation", "notes"},
	); err != nil {
		return FilamentSpool{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return FilamentSpool{}, err
	}
	return s.loadSpool(ctx, machinelogbookdb.New(s.pool), id)
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
	if !validIdentifierKind(kind) || value == "" || len(value) > 255 {
		return FilamentSpoolIdentifier{}, apperror.Invalid("invalid spool identifier")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FilamentSpoolIdentifier{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	spool, err := q.GetFilamentSpoolForUpdate(ctx, spoolID)
	if err != nil {
		return FilamentSpoolIdentifier{}, noRows(err)
	}
	if SpoolLifecycle(spool.Lifecycle) != SpoolActive {
		return FilamentSpoolIdentifier{}, apperror.Conflicting("spool_retired", "A retired spool cannot be tagged")
	}
	if err = addSpoolIdentifiers(ctx, q, spoolID, []NewSpoolIdentifier{{Kind: kind, Value: value}}); err != nil {
		return FilamentSpoolIdentifier{}, err
	}
	rows, err := q.ListFilamentSpoolIdentifiers(ctx, spoolID)
	if err != nil {
		return FilamentSpoolIdentifier{}, err
	}
	var added FilamentSpoolIdentifier
	for _, row := range rows {
		if row.Kind == string(kind) && strings.EqualFold(row.Value, value) {
			added = identifierFromRow(row)
		}
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
	return added, nil
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
	if material.DeletedAt.Valid {
		return InventoryTransaction{}, errMaterialInBin
	}
	if material.InventoryVersion != expected {
		return InventoryTransaction{}, apperror.StaleWrite
	}
	detail, err := q.GetMaterial(ctx, materialID)
	if err != nil {
		return InventoryTransaction{}, err
	}
	spoolIDs := make([]uuid.UUID, 0, 2)
	for _, spoolID := range []*uuid.UUID{fromID, toID} {
		if spoolID != nil {
			spoolIDs = append(spoolIDs, *spoolID)
		}
	}
	sort.Slice(spoolIDs, func(i, j int) bool { return bytes.Compare(spoolIDs[i][:], spoolIDs[j][:]) < 0 })
	refs := map[uuid.UUID]spoolRef{}
	versions := map[uuid.UUID]int64{}
	for _, spoolID := range spoolIDs {
		spool, ref, remaining, spoolErr := s.lockConsumableSpool(ctx, q, spoolID)
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
	var from, to *spoolRef
	if fromID != nil {
		ref := refs[*fromID]
		from = &ref
	}
	if toID != nil {
		ref := refs[*toID]
		to = &ref
	}
	row, err := s.insertSpoolTransferRow(ctx, q, p, materialID, expected, from, to, qty, occurredAt, note)
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
	spool, ref, _, err := s.lockConsumableSpool(ctx, q, spoolID)
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
	if material.DeletedAt.Valid {
		return InventoryMutationResult{}, errMaterialInBin
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
			Spool:         &ref,
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
	spool, ref, remaining, err := s.lockConsumableSpool(ctx, q, spoolID)
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
	if material.DeletedAt.Valid {
		return InventoryMutationResult{}, errMaterialInBin
	}
	if material.InventoryVersion != expectedInventory {
		return InventoryMutationResult{}, apperror.StaleWrite
	}
	delta := physicalQty.Sub(remaining)
	if delta.IsZero() {
		return InventoryMutationResult{}, apperror.Invalid("physicalQuantity equals current spool stock")
	}
	unitCost := decimalFromNumeric(material.AverageUnitCost)
	if delta.IsPositive() {
		// Found filament is valued at what the spool cost when bought, then at the material
		// average; existing-stock spools without either are booked at 0.
		if acquisitionCost != nil {
			unitCost, err = parseDecimal(*acquisitionCost, false)
			if err != nil || unitCost.IsNegative() {
				return InventoryMutationResult{}, apperror.Invalid("invalid acquisitionUnitCost")
			}
		} else {
			purchaseCost, costErr := q.GetFilamentSpoolPurchaseUnitCost(ctx, &spoolID)
			if costErr == nil {
				unitCost = decimalFromNumeric(purchaseCost)
			} else if !errors.Is(costErr, pgx.ErrNoRows) {
				return InventoryMutationResult{}, costErr
			}
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
			Spool:         &ref,
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
