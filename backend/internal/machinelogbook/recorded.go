package machinelogbook

import (
	"context"
	"errors"
	"sort"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

// RecordedRunEvent tells the logbook that a machine connector changed a
// recorded run. The connector's event ingest calls it in the transaction that
// stored the event.
type RecordedRunEvent struct {
	RunID uuid.UUID
	// Kind is the connector event kind; it is a RunEventKind value.
	Kind string
}

// RecordedRunChange is what ApplyRecordedRunEvent changed. The connector
// records it in its activity log; these automatic changes are not audited.
type RecordedRunChange struct {
	RunID uuid.UUID
	// RunFields are the changed run fields; empty when the run did not change.
	RunFields []string
	// JobID is the run's job when the job was settled again; JobFields are its changed fields.
	JobID     *uuid.UUID
	JobFields []string
}

// ApplyRecordedRunEvent settles what a connector event implies for a recorded
// run, in the connector's transaction and attributed to the connector (a
// system actor, not an account):
//
//   - when the machine reports the run's final state, the run's outcome is set
//     from it unless staff set one;
//   - when an ended run has a reported quantity on a resolvable spool, the
//     material is recorded as the run's usage and consumed from inventory,
//     whether or not the run has a job. A later report replaces the machine's
//     usage with compensating transactions; usage that staff entered is never
//     replaced. Consumption that inventory rules reject (no stock, spool not
//     consumable) is skipped and left to staff;
//   - when the run belongs to a job, the job is repriced. Final state and
//     usage changes advance the job version and are reported as changes;
//     progress only refreshes the price of the running job.
func (s *Service) ApplyRecordedRunEvent(
	ctx context.Context,
	tx pgx.Tx,
	event RecordedRunEvent,
) (RecordedRunChange, error) {
	q := machinelogbookdb.New(tx)
	// The job is locked before the run, like every job operation does.
	run, lockedJob, err := LockRunChain(ctx, tx, event.RunID)
	if err != nil {
		return RecordedRunChange{}, err
	}
	change := RecordedRunChange{RunID: run.ID}
	if RunSource(run.Source) != RunSourceRecorded {
		return change, nil
	}
	connector := authorization.Principal{}
	var fields []string
	if RunEventKind(event.Kind) == RunEventTerminalOutcome {
		updated, err := q.SetRecordedRunOutcomeFromMachine(ctx, run.ID)
		if err == nil {
			run = updated
			fields = append(fields, "outcome")
			// The outcome is set once, by the machine's final report, so the operator is told once.
			if err := s.inbox.RunFinished(ctx, tx, run.ID); err != nil {
				return RecordedRunChange{}, err
			}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return RecordedRunChange{}, err
		}
	}
	changed, err := s.consumeReportedUsage(ctx, tx, q, connector, run)
	if err != nil {
		return RecordedRunChange{}, err
	}
	if changed {
		fields = append(fields, "usages", "inventory")
	}
	change.RunFields = fields
	if run.JobID == nil {
		return change, nil
	}
	job := *lockedJob
	if len(fields) == 0 && RunEventKind(event.Kind) != RunEventTerminalOutcome {
		_, err = s.refreshPriceKeepingVersion(ctx, q, job)
		return change, err
	}
	if _, err = s.settleJob(ctx, q, job.ID); err != nil {
		return RecordedRunChange{}, err
	}
	change.JobID = &job.ID
	change.JobFields = dedupe(append(append([]string{"runs"}, fields...), "calculatedPrice", "effectivePrice"))
	return change, nil
}

// consumeReportedUsage records the machine's reported consumption as the usage
// of an ended run. It reports whether the usage changed.
func (s *Service) consumeReportedUsage(
	ctx context.Context,
	tx pgx.Tx,
	q *machinelogbookdb.Queries,
	actor authorization.Principal,
	run machinelogbookdb.MachineRun,
) (bool, error) {
	if run.State == nil || RunState(*run.State) == RunStateRunning {
		return false, nil
	}
	items, err := q.ListLatestReportedUsageItemsForRuns(ctx, []uuid.UUID{run.ID})
	if err != nil {
		return false, err
	}
	if len(items) != 0 {
		return s.consumeItemizedReportedUsage(ctx, tx, q, actor, run, items)
	}
	if !run.ReportedQuantityG.Valid || run.ReportedQuantityBasis == nil || run.ReportedSpoolID == nil ||
		run.ReportedEventID == nil {
		return false, nil
	}
	old, err := q.ListActiveRunUsagesForUpdate(ctx, run.ID)
	if err != nil {
		return false, err
	}
	// Inactive rows count too: once staff set or cleared the usage, or this
	// report was applied before, the machine report must not be booked again.
	// A newer report revision may only replace an active machine report.
	provenance, err := q.GetRunUsageProvenance(
		ctx,
		machinelogbookdb.GetRunUsageProvenanceParams{RunID: run.ID, EventID: run.ReportedEventID},
	)
	if err != nil {
		return false, err
	}
	if provenance.StaffUsage || provenance.ReportApplied || (provenance.AnyUsage && !provenance.ActiveMachineUsage) {
		return false, nil
	}
	spool, err := q.GetFilamentSpool(ctx, *run.ReportedSpoolID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if SpoolLifecycle(spool.Lifecycle) != SpoolActive || spool.MaterialDeletedAt.Valid {
		return false, nil
	}
	parsed, err := parseUsages(
		[]UsageInput{
			{
				MaterialID:    spool.MaterialID,
				SpoolID:       run.ReportedSpoolID,
				Ownership:     OwnershipMakerspace,
				Quantity:      decimalString(run.ReportedQuantityG),
				QuantityBasis: QuantityBasis(*run.ReportedQuantityBasis),
			},
		},
	)
	if err != nil {
		return false, nil
	}
	parsed[0].SourcePrinterEventID = run.ReportedEventID
	occurredAt := s.now()
	if run.EndedAt.Valid {
		occurredAt = run.EndedAt.Time
	}
	savepoint, err := tx.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = savepoint.Rollback(ctx) }()
	if err = s.replaceRunUsages(
		ctx,
		savepoint,
		machinelogbookdb.New(savepoint),
		actor,
		run.ID,
		old,
		parsed,
		occurredAt,
		nil,
	); err != nil {
		var appErr *apperror.Error
		if errors.As(err, &appErr) && appErr.HTTPStatus == 409 {
			return false, nil
		}
		return false, err
	}
	if _, err = machinelogbookdb.New(savepoint).BumpRunVersion(
		ctx,
		machinelogbookdb.BumpRunVersionParams{ID: run.ID, ExpectedVersion: run.Version},
	); err != nil {
		return false, err
	}
	if err = savepoint.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Service) consumeItemizedReportedUsage(
	ctx context.Context,
	tx pgx.Tx,
	q *machinelogbookdb.Queries,
	actor authorization.Principal,
	run machinelogbookdb.MachineRun,
	items []machinelogbookdb.MachineRunReportedUsageItem,
) (bool, error) {
	eventID := items[0].SourcePrinterEventID
	old, err := q.ListActiveRunUsagesForUpdate(ctx, run.ID)
	if err != nil {
		return false, err
	}
	provenance, err := q.GetRunUsageProvenance(
		ctx,
		machinelogbookdb.GetRunUsageProvenanceParams{RunID: run.ID, EventID: &eventID},
	)
	if err != nil {
		return false, err
	}
	if provenance.StaffUsage || provenance.ReportApplied || (provenance.AnyUsage && !provenance.ActiveMachineUsage) {
		return false, nil
	}
	segmentRows, err := q.ListLatestReportedUsageSegmentsForRuns(ctx, []uuid.UUID{run.ID})
	if err != nil {
		return false, err
	}
	segments := segmentsFromRows(segmentRows)
	parsed := make([]parsedUsage, 0, len(items))
	byKey := map[string]int{}
	// merge adds a quantity to the usage already booked for the same source: a run holds one active usage per
	// spool, and one per customer filament mount.
	merge := func(key string, item machinelogbookdb.MachineRunReportedUsageItem, quantity decimal.Decimal) bool {
		index, seen := byKey[key]
		if !seen {
			return false
		}
		parsed[index].Quantity = parsed[index].Quantity.Add(quantity)
		if estimateQualityRank(item.Quality) < estimateQualityRank(*parsed[index].EstimateQuality) {
			quality := item.Quality
			parsed[index].EstimateQuality = &quality
		}
		return true
	}
	add := func(key string, item machinelogbookdb.MachineRunReportedUsageItem, usage parsedUsage) {
		method, version, quality, revision := item.Method, item.CalculationVersion, item.Quality, item.ReportRevision
		usage.QuantityBasis = string(QuantityBasisEstimated)
		usage.UsageID = ids.New()
		usage.SourcePrinterEventID = &eventID
		usage.EstimationMethod, usage.CalculationVersion = &method, &version
		usage.EstimateQuality, usage.ReportRevision = &quality, &revision
		byKey[key] = len(parsed)
		parsed = append(parsed, usage)
	}
	book := func(item machinelogbookdb.MachineRunReportedUsageItem, spoolID *uuid.UUID, quantity decimal.Decimal) error {
		if spoolID == nil || !quantity.IsPositive() {
			return nil
		}
		spool, err := q.GetFilamentSpool(ctx, *spoolID)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && (SpoolLifecycle(spool.Lifecycle) != SpoolActive || spool.MaterialDeletedAt.Valid)) {
			return nil
		}
		if err != nil {
			return err
		}
		// Lines or segments that drew from the same spool are one usage: a run holds one active usage per spool.
		key := "spool/" + spoolID.String()
		if merge(key, item, quantity) {
			return nil
		}
		add(key, item, parsedUsage{
			MaterialID: &spool.MaterialID,
			SpoolID:    spoolID,
			Ownership:  string(OwnershipMakerspace),
			Quantity:   quantity,
		})
		return nil
	}
	// bookCustomer records filament the customer brought: no spool, no stock movement, never charged. The mount
	// says what the filament is.
	bookCustomer := func(item machinelogbookdb.MachineRunReportedUsageItem, assignmentID *uuid.UUID, quantity decimal.Decimal) error {
		if assignmentID == nil || !quantity.IsPositive() {
			return nil
		}
		key := "customer/" + assignmentID.String()
		if merge(key, item, quantity) {
			return nil
		}
		usage := parsedUsage{Ownership: string(OwnershipExternal), Quantity: quantity}
		mount, err := q.GetCustomerFilamentMount(ctx, *assignmentID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err == nil {
			usage.MaterialTypeID, usage.ExternalMaterialName = mount.CustomerMaterialTypeID, mount.CustomerColorName
		}
		add(key, item, usage)
		return nil
	}
	for _, item := range items {
		if item.SourcePrinterEventID != eventID || !item.EstimatedQuantityG.Valid ||
			EstimateQuality(item.Quality) == EstimateQualityUnresolved {
			continue
		}
		// A line fed by several spools is booked per segment, each on the spool it resolved to and with its
		// share of the line; a segment without spool or quantity is left to staff.
		if lineSegments := segments[item.ID]; len(lineSegments) > 0 {
			for _, segment := range lineSegments {
				if segment.EstimatedQuantityGrams == nil {
					continue
				}
				quantity, parseErr := decimal.NewFromString(*segment.EstimatedQuantityGrams)
				if parseErr != nil {
					continue
				}
				if err = book(item, segment.SpoolID, quantity); err != nil {
					return false, err
				}
				if err = bookCustomer(item, segment.CustomerAssignmentID, quantity); err != nil {
					return false, err
				}
			}
			continue
		}
		quantity := decimalFromNumeric(item.EstimatedQuantityG)
		if err = book(item, item.SpoolID, quantity); err != nil {
			return false, err
		}
		if err = bookCustomer(item, item.CustomerAssignmentID, quantity); err != nil {
			return false, err
		}
	}
	sort.Slice(parsed, func(i, j int) bool { return usageSortKey(parsed[i]) < usageSortKey(parsed[j]) })
	if len(parsed) == 0 {
		return false, nil
	}
	occurredAt := s.now()
	if run.EndedAt.Valid {
		occurredAt = run.EndedAt.Time
	}
	savepoint, err := tx.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = savepoint.Rollback(ctx) }()
	if err = s.replaceRunUsages(
		ctx,
		savepoint,
		machinelogbookdb.New(savepoint),
		actor,
		run.ID,
		old,
		parsed,
		occurredAt,
		nil,
	); err != nil {
		var appErr *apperror.Error
		if errors.As(err, &appErr) && appErr.HTTPStatus == 409 {
			return false, nil
		}
		return false, err
	}
	if _, err = machinelogbookdb.New(savepoint).BumpRunVersion(
		ctx,
		machinelogbookdb.BumpRunVersionParams{ID: run.ID, ExpectedVersion: run.Version},
	); err != nil {
		return false, err
	}
	if err = savepoint.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

// estimateQualityRank orders estimate qualities from worst to best, so a usage merged from several reported
// lines keeps the weakest one.
func estimateQualityRank(quality string) int {
	switch EstimateQuality(quality) {
	case EstimateQualityHigh:
		return 3
	case EstimateQualityMedium:
		return 2
	case EstimateQualityLow:
		return 1
	}
	return 0
}
