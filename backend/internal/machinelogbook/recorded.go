package machinelogbook

import (
	"context"
	"errors"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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
	if spool.MaterialID == nil {
		return false, nil
	}
	parsed, err := parseUsages(
		[]UsageInput{
			{
				MaterialID:    *spool.MaterialID,
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
	parsed := make([]parsedUsage, 0, len(items))
	for _, item := range items {
		if item.SourcePrinterEventID != eventID || item.SpoolID == nil || !item.EstimatedQuantityG.Valid ||
			EstimateQuality(item.Quality) == EstimateQualityUnresolved {
			continue
		}
		quantity := decimalFromNumeric(item.EstimatedQuantityG)
		if !quantity.IsPositive() {
			continue
		}
		spool, spoolErr := q.GetFilamentSpool(ctx, *item.SpoolID)
		if errors.Is(spoolErr, pgx.ErrNoRows) || (spoolErr == nil && spool.MaterialID == nil) {
			continue
		}
		if spoolErr != nil {
			return false, spoolErr
		}
		method, version, quality, revision := item.Method, item.CalculationVersion, item.Quality, item.ReportRevision
		parsed = append(
			parsed,
			parsedUsage{
				MaterialID:           spool.MaterialID,
				SpoolID:              item.SpoolID,
				Ownership:            string(OwnershipMakerspace),
				QuantityBasis:        string(QuantityBasisEstimated),
				Quantity:             quantity,
				UsageID:              ids.New(),
				SourcePrinterEventID: &eventID,
				EstimationMethod:     &method,
				CalculationVersion:   &version,
				EstimateQuality:      &quality,
				ReportRevision:       &revision,
			},
		)
	}
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
