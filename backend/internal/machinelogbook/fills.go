package machinelogbook

import (
	"bytes"
	"context"
	"errors"
	"net/http"
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
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
)

// fillRef identifies the open fill a ledger row or job usage is attributed to,
// together with the snapshots that stay readable after the spool is deleted.
type fillRef struct {
	SpoolID, FillID uuid.UUID
	SpoolDisplayID  string
	FillNumber      int32
	MaterialID      uuid.UUID
}

func unprocessable(code, message string) error {
	return apperror.New(http.StatusUnprocessableEntity, code, message)
}

func refFromFill(spool machinelogbookdb.FilamentSpool, fill machinelogbookdb.FilamentSpoolFill) fillRef {
	return fillRef{
		SpoolID:        spool.ID,
		FillID:         fill.ID,
		SpoolDisplayID: spool.DisplayID,
		FillNumber:     fill.FillNumber,
		MaterialID:     fill.MaterialID,
	}
}

// lockConsumableFill locks a spool and returns its open fill. Spools that are
// archived or have no open fill cannot take stock movements.
func (s *Service) lockConsumableFill(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	spoolID uuid.UUID,
) (machinelogbookdb.FilamentSpool, fillRef, decimal.Decimal, error) {
	spool, err := q.GetFilamentSpoolForUpdate(ctx, spoolID)
	if err != nil {
		return spool, fillRef{}, decimal.Zero, noRows(err)
	}
	if SpoolLifecycle(spool.Lifecycle) != SpoolActive {
		return spool, fillRef{}, decimal.Zero, apperror.Conflicting(
			"spool_not_consumable",
			"The spool is archived or has no open fill",
		)
	}
	fill, err := q.GetOpenFilamentSpoolFill(ctx, spoolID)
	if errors.Is(err, pgx.ErrNoRows) {
		return spool, fillRef{}, decimal.Zero, apperror.Conflicting(
			"spool_not_consumable",
			"The spool is archived or has no open fill",
		)
	}
	if err != nil {
		return spool, fillRef{}, decimal.Zero, err
	}
	return spool, refFromFill(
			spool,
			machinelogbookdb.FilamentSpoolFill{ID: fill.ID, FillNumber: fill.FillNumber, MaterialID: fill.MaterialID},
		), decimalFromNumeric(
			fill.RemainingQuantity,
		), nil
}

// insertFillTransferRow moves stock between a fill and loose stock (or between
// two fills). Totals stay unchanged; the balance version still advances so
// stale clients notice. from or to may be nil for loose stock.
func (s *Service) insertFillTransferRow(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	p authorization.Principal,
	materialID uuid.UUID,
	expected int64,
	from, to *fillRef,
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
		params.FromSpoolID = &from.SpoolID
		params.FromFillID = &from.FillID
		params.FromSpoolDisplayID = &from.SpoolDisplayID
		params.FromFillNumber = &from.FillNumber
	}
	if to != nil {
		params.ToSpoolID, params.ToFillID, params.ToSpoolDisplayID, params.ToFillNumber = &to.SpoolID, &to.FillID, &to.SpoolDisplayID, &to.FillNumber
	}
	return q.InsertSpoolTransfer(ctx, params)
}

func (s *Service) insertFillTransfer(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	p authorization.Principal,
	materialID uuid.UUID,
	expected int64,
	from, to *fillRef,
	quantity decimal.Decimal,
	occurredAt time.Time,
	note *string,
) error {
	_, err := s.insertFillTransferRow(ctx, q, p, materialID, expected, from, to, quantity, occurredAt, note)
	return err
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

// checkFillMaterialAndProduct validates the material of a new fill and the
// optional catalog product, and returns the manufacturer and product name
// snapshots (defaulting to the product's).
func (s *Service) checkFillMaterialAndProduct(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	materialID uuid.UUID,
	productID *uuid.UUID,
	manufacturer, productName *string,
) (*string, *string, error) {
	detail, err := q.GetMaterial(ctx, materialID)
	if err != nil {
		return nil, nil, noRows(err)
	}
	if MaterialUnit(detail.Unit) != UnitGram || !detail.DiameterMm.Valid {
		return nil, nil, apperror.Conflicting(
			"material_not_filament",
			"Spools require a gram-denominated material with filament properties",
		)
	}
	if productID == nil {
		return manufacturer, productName, nil
	}
	product, err := q.GetFilamentProduct(ctx, *productID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, apperror.Invalid("productId does not exist")
	}
	if err != nil {
		return nil, nil, err
	}
	if !product.Active {
		return nil, nil, unprocessable("product_inactive", "The product is inactive")
	}
	if product.MaterialID != materialID {
		return nil, nil, apperror.Invalid("materialId must be the product's material")
	}
	if manufacturer == nil {
		manufacturer = &product.Manufacturer
	}
	if productName == nil {
		productName = &product.Name
	}
	return manufacturer, productName, nil
}

type leftoverPlan struct {
	Remaining, Leftover decimal.Decimal
	Disposition         LeftoverDisposition
	Reason              string
}

// planLeftover derives what is left on a fill from the chosen basis and
// validates the disposition before anything is written.
func planLeftover(tare pgtype.Numeric, remaining decimal.Decimal, in LeftoverInput) (leftoverPlan, error) {
	plan := leftoverPlan{Remaining: remaining, Reason: "inventory_count"}
	switch in.Basis {
	case LeftoverSystem:
		plan.Leftover = decimal.Max(remaining, decimal.Zero)
	case LeftoverWeighed:
		if in.GrossWeightG == nil {
			return plan, apperror.Invalid("grossWeightG is required for a weighed leftover")
		}
		gross, err := parseDecimal(*in.GrossWeightG, false)
		if err != nil || gross.IsNegative() {
			return plan, apperror.Invalid("grossWeightG must be non-negative")
		}
		if !tare.Valid {
			return plan, unprocessable("tare_required", "The spool needs a tare weight to weigh the leftover")
		}
		plan.Leftover = decimal.Max(gross.Sub(decimalFromNumeric(tare)), decimal.Zero)
	case LeftoverNone:
		plan.Leftover = decimal.Zero
		plan.Reason = "mark_empty"
	default:
		return plan, apperror.Invalid("invalid leftover basis")
	}
	if in.Disposition != nil && *in.Disposition != DispositionReturnedToStock && *in.Disposition != DispositionDisposed {
		return plan, apperror.Invalid("invalid leftover disposition")
	}
	if plan.Leftover.IsPositive() {
		if in.Disposition == nil {
			return plan, unprocessable("disposition_required", "A leftover above zero needs a disposition")
		}
		plan.Disposition = *in.Disposition
	}
	return plan, nil
}

// closeFill writes the ledger rows that settle a fill (correction to the
// leftover, then return to stock or disposal), closes it and retires its
// identifiers. The caller holds the spool and material locks.
func (s *Service) closeFill(
	ctx context.Context,
	tx pgx.Tx,
	q *machinelogbookdb.Queries,
	p authorization.Principal,
	ref fillRef,
	plan leftoverPlan,
	occurredAt time.Time,
	requestID *uuid.UUID,
) error {
	diff := plan.Leftover.Sub(plan.Remaining)
	if !diff.IsZero() {
		material, err := q.GetMaterialForUpdate(ctx, ref.MaterialID)
		if err != nil {
			return noRows(err)
		}
		average := decimalFromNumeric(material.AverageUnitCost)
		reason := plan.Reason
		if _, err = s.applyInventoryMutation(
			ctx,
			tx,
			q,
			p,
			ref.MaterialID,
			anyInventoryVersion,
			inventoryMutation{
				Kind:             InventoryAdjustment,
				QuantityDelta:    diff,
				UnitCost:         average,
				ValueDelta:       diff.Mul(average),
				OccurredAt:       occurredAt,
				Reason:           &reason,
				Fill:             &ref,
				KeepSpoolVersion: true,
			},
			requestID,
		); err != nil {
			return err
		}
	}
	outcome := FillUsedUp
	if plan.Leftover.IsPositive() {
		outcome = FillOutcome(plan.Disposition)
		switch plan.Disposition {
		case DispositionReturnedToStock:
			if err := s.insertFillTransfer(
				ctx,
				q,
				p,
				ref.MaterialID,
				anyInventoryVersion,
				&ref,
				nil,
				plan.Leftover,
				occurredAt,
				nil,
			); err != nil {
				return databaseError(err)
			}
		case DispositionDisposed:
			material, err := q.GetMaterialForUpdate(ctx, ref.MaterialID)
			if err != nil {
				return noRows(err)
			}
			average := decimalFromNumeric(material.AverageUnitCost)
			reason := "disposed"
			if _, err = s.applyInventoryMutation(
				ctx,
				tx,
				q,
				p,
				ref.MaterialID,
				anyInventoryVersion,
				inventoryMutation{
					Kind:             InventoryDisposal,
					QuantityDelta:    plan.Leftover.Neg(),
					UnitCost:         average,
					ValueDelta:       plan.Leftover.Mul(average).Neg(),
					OccurredAt:       occurredAt,
					Reason:           &reason,
					Fill:             &ref,
					KeepSpoolVersion: true,
				},
				requestID,
			); err != nil {
				return err
			}
		}
	}
	if _, err := q.CloseFilamentSpoolFill(
		ctx,
		machinelogbookdb.CloseFilamentSpoolFillParams{
			ID:              ref.FillID,
			ClosedAt:        pgTimestamp(occurredAt),
			LeftoverG:       numericFromDecimal(plan.Leftover),
			LeftoverOutcome: optional.Convert[string](&outcome),
		},
	); err != nil {
		return databaseError(err)
	}
	return q.RetireFillIdentifiers(
		ctx,
		machinelogbookdb.RetireFillIdentifiersParams{RetiredAt: pgTimestamp(occurredAt), FillID: ref.FillID},
	)
}

func validIdentifierKind(kind IdentifierKind) bool {
	return kind == IdentifierBarcode || kind == IdentifierQR || kind == IdentifierNFC
}

// ChangeFilamentSpoolFill closes the open fill of a reusable spool (when there
// is one) and starts the next fill in a single transaction.
func (s *Service) ChangeFilamentSpoolFill(
	ctx context.Context,
	p authorization.Principal,
	spoolID uuid.UUID,
	in ChangeFillInput,
	requestID *uuid.UUID,
) (FilamentSpool, error) {
	if err := require(p, authorization.FilamentSpoolsManage); err != nil {
		return FilamentSpool{}, err
	}
	if err := require(p, authorization.InventoryManage); err != nil {
		return FilamentSpool{}, err
	}
	if in.ExpectedVersion < 1 || in.OccurredAt.IsZero() {
		return FilamentSpool{}, apperror.Invalid("occurredAt and expectedVersion are required")
	}
	weight, err := parseDecimal(in.Fill.NetWeightG, true)
	if err != nil {
		return FilamentSpool{}, err
	}
	var price decimal.Decimal
	switch in.Fill.Source {
	case FillSourceLooseStock:
	case FillSourcePurchase:
		if in.Fill.TotalPrice == nil {
			return FilamentSpool{}, apperror.Invalid("totalPrice is required for a purchase")
		}
		price, err = parseDecimal(*in.Fill.TotalPrice, false)
		if err != nil || price.IsNegative() {
			return FilamentSpool{}, apperror.Invalid("totalPrice must be non-negative")
		}
	default:
		return FilamentSpool{}, apperror.Invalid("invalid fill source")
	}
	supplier, err := validateOptionalText(in.Fill.Supplier, "supplier", 200)
	if err != nil {
		return FilamentSpool{}, err
	}
	manufacturer, err := validateOptionalText(in.Fill.Manufacturer, "manufacturer", 150)
	if err != nil {
		return FilamentSpool{}, err
	}
	productName, err := validateOptionalText(in.Fill.ProductName, "productName", 200)
	if err != nil {
		return FilamentSpool{}, err
	}
	if len(in.KeepIdentifierIDs) > 20 || len(in.NewIdentifiers) > 20 {
		return FilamentSpool{}, apperror.Invalid("too many identifiers")
	}
	newIdentifiers := make([]NewSpoolIdentifier, 0, len(in.NewIdentifiers))
	for _, identifier := range in.NewIdentifiers {
		value := strings.TrimSpace(identifier.Value)
		if !validIdentifierKind(identifier.Kind) || value == "" || len(value) > 255 {
			return FilamentSpool{}, apperror.Invalid("invalid spool identifier")
		}
		newIdentifiers = append(newIdentifiers, NewSpoolIdentifier{Kind: identifier.Kind, Value: value})
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FilamentSpool{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	spool, err := q.GetFilamentSpoolForUpdate(ctx, spoolID)
	if err != nil {
		return FilamentSpool{}, noRows(err)
	}
	if SpoolKind(spool.Kind) != SpoolReusable {
		return FilamentSpool{}, apperror.Conflicting("spool_not_reusable", "Only reusable spools can be refilled")
	}
	if SpoolLifecycle(spool.Lifecycle) == SpoolArchived {
		return FilamentSpool{}, apperror.Conflicting("spool_archived", "An archived spool cannot be refilled")
	}
	if spool.Version != in.ExpectedVersion {
		return FilamentSpool{}, apperror.StaleWrite
	}
	open, err := q.GetOpenFilamentSpoolFill(ctx, spoolID)
	hasOpen := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return FilamentSpool{}, err
	}
	if hasOpen && in.Leftover == nil {
		return FilamentSpool{}, unprocessable("leftover_required", "The open fill needs a leftover")
	}
	if !hasOpen && in.Leftover != nil {
		return FilamentSpool{}, unprocessable("leftover_not_allowed", "The spool has no open fill")
	}
	active, err := q.ListFilamentSpoolIdentifiers(ctx, spoolID)
	if err != nil {
		return FilamentSpool{}, err
	}
	activeByID := map[uuid.UUID]machinelogbookdb.FilamentSpoolIdentifier{}
	for _, identifier := range active {
		activeByID[identifier.ID] = identifier
	}
	kept := make([]machinelogbookdb.FilamentSpoolIdentifier, 0, len(in.KeepIdentifierIDs))
	seenKept := map[uuid.UUID]bool{}
	for _, id := range in.KeepIdentifierIDs {
		identifier, ok := activeByID[id]
		if !ok || (hasOpen && identifier.FillID != open.ID) {
			return FilamentSpool{}, apperror.Invalid("keepIdentifierIds must belong to the open fill")
		}
		if !seenKept[id] {
			seenKept[id] = true
			kept = append(kept, identifier)
		}
	}

	materials := []uuid.UUID{in.Fill.MaterialID}
	if hasOpen {
		materials = append(materials, open.MaterialID)
	}
	if err = lockMaterials(ctx, q, materials...); err != nil {
		return FilamentSpool{}, err
	}
	manufacturer, productName, err = s.checkFillMaterialAndProduct(
		ctx,
		q,
		in.Fill.MaterialID,
		in.Fill.ProductID,
		manufacturer,
		productName,
	)
	if err != nil {
		return FilamentSpool{}, err
	}

	if hasOpen {
		if in.OccurredAt.Before(open.FilledAt) {
			return FilamentSpool{}, apperror.Invalid("occurredAt must not precede the start of the open fill")
		}
		plan, planErr := planLeftover(spool.TareWeightG, decimalFromNumeric(open.RemainingQuantity), *in.Leftover)
		if planErr != nil {
			return FilamentSpool{}, planErr
		}
		oldRef := refFromFill(
			spool,
			machinelogbookdb.FilamentSpoolFill{ID: open.ID, FillNumber: open.FillNumber, MaterialID: open.MaterialID},
		)
		if err = s.closeFill(ctx, tx, q, p, oldRef, plan, in.OccurredAt, requestID); err != nil {
			return FilamentSpool{}, err
		}
	}

	number, err := q.NextFilamentSpoolFillNumber(ctx, spoolID)
	if err != nil {
		return FilamentSpool{}, err
	}
	fill, err := q.InsertFilamentSpoolFill(
		ctx,
		machinelogbookdb.InsertFilamentSpoolFillParams{
			ID:                ids.New(),
			SpoolID:           spoolID,
			FillNumber:        number,
			MaterialID:        in.Fill.MaterialID,
			ProductID:         in.Fill.ProductID,
			Manufacturer:      manufacturer,
			ProductName:       productName,
			InitialNetWeightG: numericFromDecimal(weight),
			FilledAt:          in.OccurredAt.UTC(),
		},
	)
	if err != nil {
		return FilamentSpool{}, databaseError(err)
	}
	newRef := refFromFill(spool, fill)
	if in.Fill.Source == FillSourceLooseStock {
		detail, detailErr := q.GetMaterial(ctx, in.Fill.MaterialID)
		if detailErr != nil {
			return FilamentSpool{}, detailErr
		}
		loose := decimalFromNumeric(detail.Quantity).Sub(decimalFromNumeric(detail.AssignedQuantity))
		if loose.LessThan(weight) {
			return FilamentSpool{}, unprocessable("insufficient_loose_stock", "Not enough loose stock for the new fill")
		}
		if err = s.insertFillTransfer(
			ctx,
			q,
			p,
			in.Fill.MaterialID,
			anyInventoryVersion,
			nil,
			&newRef,
			weight,
			in.OccurredAt,
			nil,
		); err != nil {
			return FilamentSpool{}, databaseError(err)
		}
	} else if _, err = s.applyInventoryMutation(ctx, tx, q, p, in.Fill.MaterialID, anyInventoryVersion, inventoryMutation{
		Kind: InventoryPurchase, QuantityDelta: weight, UnitCost: price.Div(weight), ValueDelta: price,
		TotalPrice: &price, OccurredAt: in.OccurredAt, Supplier: supplier, Fill: &newRef, KeepSpoolVersion: true,
	}, requestID); err != nil {
		return FilamentSpool{}, err
	}

	wanted := make([]NewSpoolIdentifier, 0, len(kept)+len(newIdentifiers))
	for _, identifier := range kept {
		wanted = append(wanted, NewSpoolIdentifier{Kind: IdentifierKind(identifier.Kind), Value: identifier.Value})
	}
	wanted = append(wanted, newIdentifiers...)
	seen := map[string]bool{}
	for i, identifier := range wanted {
		key := string(identifier.Kind) + "/" + strings.ToLower(identifier.Value)
		if seen[key] {
			return FilamentSpool{}, apperror.Conflicting("identifier_in_use", "An identifier is used twice")
		}
		seen[key] = true
		if i >= len(kept) {
			inUse, useErr := q.FilamentSpoolIdentifierInUse(
				ctx,
				machinelogbookdb.FilamentSpoolIdentifierInUseParams{Kind: string(identifier.Kind), Value: identifier.Value},
			)
			if useErr != nil {
				return FilamentSpool{}, useErr
			}
			if inUse {
				return FilamentSpool{}, apperror.Conflicting(
					"identifier_in_use",
					"An identifier is already assigned to a fill",
				)
			}
		}
		if _, err = q.AddFilamentSpoolIdentifier(
			ctx,
			machinelogbookdb.AddFilamentSpoolIdentifierParams{
				ID:      ids.New(),
				SpoolID: spoolID,
				FillID:  fill.ID,
				Kind:    string(identifier.Kind),
				Value:   identifier.Value,
			},
		); err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				return FilamentSpool{}, apperror.Conflicting(
					"identifier_in_use",
					"An identifier is already assigned to a fill",
				)
			}
			return FilamentSpool{}, databaseError(err)
		}
	}

	if _, err = q.BumpFilamentSpoolVersion(
		ctx,
		machinelogbookdb.BumpFilamentSpoolVersionParams{ID: spoolID, ExpectedVersion: in.ExpectedVersion},
	); err != nil {
		return FilamentSpool{}, err
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"filament_spool.fill_changed",
		"filament_spool",
		spoolID,
		requestID,
		[]string{"fill", "leftover", "identifiers", "inventory"},
	); err != nil {
		return FilamentSpool{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return FilamentSpool{}, err
	}
	return s.loadSpool(ctx, machinelogbookdb.New(s.pool), spoolID, false)
}

// FinishFilamentSpool closes the open fill and unmounts the spool. Single-use
// spools are archived, reusable spools wait for their next fill.
func (s *Service) FinishFilamentSpool(
	ctx context.Context,
	p authorization.Principal,
	spoolID uuid.UUID,
	in FinishSpoolInput,
	requestID *uuid.UUID,
) (FilamentSpool, error) {
	if err := require(p, authorization.FilamentSpoolsManage); err != nil {
		return FilamentSpool{}, err
	}
	if err := require(p, authorization.InventoryManage); err != nil {
		return FilamentSpool{}, err
	}
	if in.ExpectedVersion < 1 || in.OccurredAt.IsZero() {
		return FilamentSpool{}, apperror.Invalid("occurredAt and expectedVersion are required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FilamentSpool{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	spool, err := q.GetFilamentSpoolForUpdate(ctx, spoolID)
	if err != nil {
		return FilamentSpool{}, noRows(err)
	}
	if spool.Version != in.ExpectedVersion {
		return FilamentSpool{}, apperror.StaleWrite
	}
	open, err := q.GetOpenFilamentSpoolFill(ctx, spoolID)
	if errors.Is(err, pgx.ErrNoRows) {
		return FilamentSpool{}, apperror.Conflicting("no_open_fill", "The spool has no open fill")
	}
	if err != nil {
		return FilamentSpool{}, err
	}
	if in.OccurredAt.Before(open.FilledAt) {
		return FilamentSpool{}, apperror.Invalid("occurredAt must not precede the start of the open fill")
	}
	plan, err := planLeftover(spool.TareWeightG, decimalFromNumeric(open.RemainingQuantity), in.Leftover)
	if err != nil {
		return FilamentSpool{}, err
	}
	if err = lockMaterials(ctx, q, open.MaterialID); err != nil {
		return FilamentSpool{}, err
	}
	ref := refFromFill(
		spool,
		machinelogbookdb.FilamentSpoolFill{ID: open.ID, FillNumber: open.FillNumber, MaterialID: open.MaterialID},
	)
	if err = s.closeFill(ctx, tx, q, p, ref, plan, in.OccurredAt, requestID); err != nil {
		return FilamentSpool{}, err
	}
	actor := p.AccountID
	if _, err = q.UnmountFilamentSpool(
		ctx,
		machinelogbookdb.UnmountFilamentSpoolParams{
			UnmountedAt:    in.OccurredAt.UTC(),
			ActorAccountID: &actor,
			SpoolID:        spoolID,
		},
	); err != nil {
		return FilamentSpool{}, err
	}
	if SpoolKind(spool.Kind) == SpoolSingleUse && SpoolLifecycle(spool.Lifecycle) == SpoolActive {
		_, err = q.ArchiveFilamentSpool(
			ctx,
			machinelogbookdb.ArchiveFilamentSpoolParams{
				ArchivedAt:      pgTimestamp(s.now()),
				ID:              spoolID,
				ExpectedVersion: in.ExpectedVersion,
			},
		)
	} else {
		_, err = q.BumpFilamentSpoolVersion(
			ctx,
			machinelogbookdb.BumpFilamentSpoolVersionParams{ID: spoolID, ExpectedVersion: in.ExpectedVersion},
		)
	}
	if err != nil {
		return FilamentSpool{}, err
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"filament_spool.finished",
		"filament_spool",
		spoolID,
		requestID,
		[]string{"leftover", "lifecycle", "mounted", "inventory"},
	); err != nil {
		return FilamentSpool{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return FilamentSpool{}, err
	}
	return s.loadSpool(ctx, machinelogbookdb.New(s.pool), spoolID, false)
}

func validCleanupMonths(months int) bool {
	return months == 1 || months == 3 || months == 6 || months == 12
}

// CleanUpFilamentSpools lists (dry run) or hard-deletes archived single-use
// spools older than the cutoff. Only spools that are still candidates when
// locked are deleted; ledger rows and job usages keep their snapshots.
func (s *Service) CleanUpFilamentSpools(
	ctx context.Context,
	p authorization.Principal,
	olderThanMonths int,
	dryRun bool,
	spoolIDs []uuid.UUID,
	requestID *uuid.UUID,
) ([]CleanUpCandidate, bool, error) {
	if err := require(p, authorization.FilamentSpoolsManage); err != nil {
		return nil, false, err
	}
	if err := require(p, authorization.InventoryManage); err != nil {
		return nil, false, err
	}
	if !validCleanupMonths(olderThanMonths) {
		return nil, false, apperror.Invalid("olderThanMonths must be 1, 3, 6 or 12")
	}
	cutoff := pgTimestamp(s.now().AddDate(0, -olderThanMonths, 0))
	if dryRun {
		rows, err := machinelogbookdb.New(s.pool).ListFilamentSpoolCleanupCandidates(ctx, cutoff.Time)
		if err != nil {
			return nil, false, err
		}
		items := make([]CleanUpCandidate, 0, len(rows))
		for _, row := range rows {
			items = append(
				items,
				CleanUpCandidate{
					ID:         row.ID,
					DisplayID:  row.DisplayID,
					Label:      row.Label,
					ArchivedAt: row.ArchivedAt.Time,
				},
			)
		}
		return items, false, nil
	}
	if len(spoolIDs) == 0 {
		return nil, false, apperror.Invalid("spoolIds is required without dryRun")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	rows, err := q.LockFilamentSpoolCleanupCandidates(
		ctx,
		machinelogbookdb.LockFilamentSpoolCleanupCandidatesParams{Ids: spoolIDs, Cutoff: cutoff.Time},
	)
	if err != nil {
		return nil, false, err
	}
	items := make([]CleanUpCandidate, 0, len(rows))
	for _, row := range rows {
		if _, err = q.DeleteFilamentSpool(ctx, row.ID); err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				return nil, false, apperror.Conflicting(
					"spool_cleanup_conflict",
					"A job already has an unassigned usage of the same material",
				)
			}
			return nil, false, databaseError(err)
		}
		if err = writeAudit(
			ctx,
			tx,
			p,
			"filament_spool.deleted",
			"filament_spool",
			row.ID,
			requestID,
			nil,
		); err != nil {
			return nil, false, err
		}
		items = append(
			items,
			CleanUpCandidate{ID: row.ID, DisplayID: row.DisplayID, Label: row.Label, ArchivedAt: row.ArchivedAt.Time},
		)
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	return items, true, nil
}
