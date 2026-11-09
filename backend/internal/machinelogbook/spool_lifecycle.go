package machinelogbook

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

var labelSpaces = regexp.MustCompile(`\s+`)

// spoolLabelPart upper-cases one part of a spool label and folds the article name separator and runs of
// white space into single spaces.
func spoolLabelPart(value string) string {
	value = strings.ReplaceAll(strings.ToUpper(value), "·", " ")
	return strings.TrimSpace(labelSpaces.ReplaceAllString(value, " "))
}

// spoolLabelPrefix is S-<TYPECODE>-<VARIANT>-<COLOUR> of an article, leaving out missing parts.
func spoolLabelPrefix(typeCode string, variant, colorName *string) string {
	parts := []string{"S"}
	for _, part := range []*string{&typeCode, variant, colorName} {
		if part == nil {
			continue
		}
		if text := spoolLabelPart(*part); text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "-")
}

// nextSpoolLabel returns prefix-NN with the smallest NN >= 1 that no active spool with the same prefix uses
// (two digits at least). Retired spools free their number. The caller's transaction holds a lock on the
// prefix until it commits, so concurrent registrations cannot pick the same number.
func nextSpoolLabel(ctx context.Context, q *machinelogbookdb.Queries, prefix string) (string, error) {
	if err := q.LockSpoolLabelPrefix(ctx, prefix); err != nil {
		return "", fmt.Errorf("lock spool label prefix: %w", err)
	}
	labels, err := q.ListActiveSpoolLabelsWithPrefix(ctx, prefix+"-")
	if err != nil {
		return "", fmt.Errorf("list spool labels: %w", err)
	}
	used := map[int]bool{}
	for _, label := range labels {
		suffix := label[len(prefix)+1:]
		if n, convErr := strconv.Atoi(suffix); convErr == nil && strings.Trim(suffix, "0123456789") == "" {
			used[n] = true
		}
	}
	n := 1
	for used[n] {
		n++
	}
	return fmt.Sprintf("%s-%02d", prefix, n), nil
}

func validRetireOutcome(outcome SpoolRetireOutcome) bool {
	return outcome == SpoolRetiredEmpty || outcome == SpoolRetiredDiscarded
}

// RetireFilamentSpool writes the spool's remaining quantity off (used up when it ran empty, disposed when the
// rest was thrown away), unmounts it, retires its identifiers and archives it into the recycle bin. Its label
// number becomes free for new spools.
func (s *Service) RetireFilamentSpool(
	ctx context.Context,
	p authorization.Principal,
	spoolID uuid.UUID,
	expectedVersion int64,
	outcome SpoolRetireOutcome,
	requestID *uuid.UUID,
) (FilamentSpool, error) {
	if err := require(p, authorization.FilamentSpoolsManage); err != nil {
		return FilamentSpool{}, err
	}
	if err := require(p, authorization.InventoryCorrect); err != nil {
		return FilamentSpool{}, err
	}
	if expectedVersion < 1 || !validRetireOutcome(outcome) {
		return FilamentSpool{}, apperror.Invalid("expectedVersion and a valid outcome are required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FilamentSpool{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	spool, ref, remaining, err := s.lockConsumableSpool(ctx, q, spoolID)
	if err != nil {
		return FilamentSpool{}, err
	}
	if spool.Version != expectedVersion {
		return FilamentSpool{}, apperror.StaleWrite
	}
	material, err := q.GetMaterialForUpdate(ctx, ref.MaterialID)
	if err != nil {
		return FilamentSpool{}, noRows(err)
	}
	if material.DeletedAt.Valid {
		return FilamentSpool{}, errMaterialInBin
	}
	now := s.now().UTC()
	written := decimal.Max(remaining, decimal.Zero)
	if written.IsPositive() {
		kind, reason := InventoryManualConsumption, "unrecorded_consumption"
		if outcome == SpoolRetiredDiscarded {
			kind, reason = InventoryDisposal, "disposed"
		}
		average := decimalFromNumeric(material.AverageUnitCost)
		if _, err = s.applyInventoryMutation(
			ctx,
			tx,
			q,
			p,
			ref.MaterialID,
			anyInventoryVersion,
			inventoryMutation{
				Kind:             kind,
				QuantityDelta:    written.Neg(),
				UnitCost:         average,
				ValueDelta:       written.Mul(average).Neg(),
				OccurredAt:       now,
				Reason:           &reason,
				Spool:            &ref,
				KeepSpoolVersion: true,
				SkipAudit:        true,
			},
			requestID,
		); err != nil {
			return FilamentSpool{}, err
		}
	}
	actor := p.AccountID
	if _, err = q.UnmountFilamentSpool(
		ctx,
		machinelogbookdb.UnmountFilamentSpoolParams{UnmountedAt: now, ActorAccountID: &actor, SpoolID: spoolID},
	); err != nil {
		return FilamentSpool{}, err
	}
	if err = q.RetireSpoolIdentifiers(
		ctx,
		machinelogbookdb.RetireSpoolIdentifiersParams{RetiredAt: pgTimestamp(now), SpoolID: spoolID},
	); err != nil {
		return FilamentSpool{}, err
	}
	outcomeText := string(outcome)
	if _, err = q.RetireFilamentSpool(
		ctx,
		machinelogbookdb.RetireFilamentSpoolParams{
			ArchivedAt:      pgTimestamp(now),
			RetiredOutcome:  &outcomeText,
			RetiredQuantity: numericFromDecimal(written),
			RetiredBy:       accountPointer(p),
			ID:              spoolID,
		},
	); err != nil {
		return FilamentSpool{}, databaseError(err)
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"filament_spool.retired",
		"filament_spool",
		spoolID,
		requestID,
		[]string{"lifecycle", "retiredOutcome", "mounted", "identifiers", "inventory"},
	); err != nil {
		return FilamentSpool{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return FilamentSpool{}, err
	}
	return s.loadSpool(ctx, machinelogbookdb.New(s.pool), spoolID)
}

var errSpoolNotRetired = apperror.Conflicting("spool_not_retired", "The spool is not in the recycle bin")

// RestoreFilamentSpool brings a retired spool back as an active, unmounted spool. A spool retired as discarded
// gets the written-off quantity back. When another active spool took its label meanwhile, it gets the next
// free number of its article's prefix.
func (s *Service) RestoreFilamentSpool(
	ctx context.Context,
	p authorization.Principal,
	spoolID uuid.UUID,
	expectedVersion int64,
	requestID *uuid.UUID,
) (FilamentSpool, error) {
	if err := require(p, authorization.FilamentSpoolsManage); err != nil {
		return FilamentSpool{}, err
	}
	if err := require(p, authorization.InventoryCorrect); err != nil {
		return FilamentSpool{}, err
	}
	if expectedVersion < 1 {
		return FilamentSpool{}, apperror.Invalid("expectedVersion must be positive")
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
	if SpoolLifecycle(spool.Lifecycle) != SpoolArchived {
		return FilamentSpool{}, errSpoolNotRetired
	}
	if spool.Version != expectedVersion {
		return FilamentSpool{}, apperror.StaleWrite
	}
	material, err := q.GetMaterialForUpdate(ctx, spool.MaterialID)
	if err != nil {
		return FilamentSpool{}, noRows(err)
	}
	if material.DeletedAt.Valid {
		return FilamentSpool{}, errMaterialInBin
	}
	label := spool.DisplayID
	taken, err := q.ActiveSpoolLabelTaken(
		ctx,
		machinelogbookdb.ActiveSpoolLabelTakenParams{DisplayID: label, ID: spoolID},
	)
	if err != nil {
		return FilamentSpool{}, err
	}
	if taken {
		detail, detailErr := q.GetMaterial(ctx, spool.MaterialID)
		if detailErr != nil {
			return FilamentSpool{}, detailErr
		}
		prefix := spoolLabelPrefix(detail.MaterialTypeCode, detail.Variant, detail.ColorName)
		if label, err = nextSpoolLabel(ctx, q, prefix); err != nil {
			return FilamentSpool{}, err
		}
	}
	restored, err := q.RestoreFilamentSpool(
		ctx,
		machinelogbookdb.RestoreFilamentSpoolParams{DisplayID: label, ID: spoolID},
	)
	if err != nil {
		return FilamentSpool{}, databaseError(err)
	}
	if spool.ArchivedAt.Valid {
		if err = q.RestoreSpoolIdentifiers(
			ctx,
			machinelogbookdb.RestoreSpoolIdentifiersParams{SpoolID: spoolID, RetiredAt: spool.ArchivedAt.Time},
		); err != nil {
			return FilamentSpool{}, err
		}
	}
	written := decimalFromNumeric(spool.RetiredQuantity)
	if spool.RetiredOutcome != nil && SpoolRetireOutcome(*spool.RetiredOutcome) == SpoolRetiredDiscarded &&
		written.IsPositive() {
		average := decimalFromNumeric(material.AverageUnitCost)
		reason := "other"
		note := "The spool came back from the recycle bin"
		ref := spoolRef{SpoolID: restored.ID, SpoolDisplayID: restored.DisplayID, MaterialID: restored.MaterialID}
		if _, err = s.applyInventoryMutation(
			ctx,
			tx,
			q,
			p,
			restored.MaterialID,
			anyInventoryVersion,
			inventoryMutation{
				Kind:             InventoryAdjustment,
				QuantityDelta:    written,
				UnitCost:         average,
				ValueDelta:       written.Mul(average),
				OccurredAt:       s.now().UTC(),
				Reason:           &reason,
				Note:             &note,
				Spool:            &ref,
				KeepSpoolVersion: true,
				SkipAudit:        true,
			},
			requestID,
		); err != nil {
			return FilamentSpool{}, err
		}
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"filament_spool.restored",
		"filament_spool",
		spoolID,
		requestID,
		[]string{"lifecycle", "displayId", "identifiers", "inventory"},
	); err != nil {
		return FilamentSpool{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return FilamentSpool{}, err
	}
	return s.loadSpool(ctx, machinelogbookdb.New(s.pool), spoolID)
}

// PurgeFilamentSpool deletes a retired spool for good. Ledger entries and run usages keep its label.
func (s *Service) PurgeFilamentSpool(
	ctx context.Context,
	p authorization.Principal,
	spoolID uuid.UUID,
	expectedVersion int64,
	requestID *uuid.UUID,
) error {
	if err := require(p, authorization.FilamentSpoolsManage); err != nil {
		return err
	}
	if err := require(p, authorization.InventoryDelete); err != nil {
		return err
	}
	if expectedVersion < 1 {
		return apperror.Invalid("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	spool, err := q.GetFilamentSpoolForUpdate(ctx, spoolID)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if SpoolLifecycle(spool.Lifecycle) != SpoolArchived {
		return errSpoolNotRetired
	}
	if spool.Version != expectedVersion {
		return apperror.StaleWrite
	}
	if _, err = q.DeleteFilamentSpool(ctx, spoolID); err != nil {
		return databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "filament_spool.purged", "filament_spool", spoolID, requestID, nil); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
