package machinelogbook

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
)

// RunReportedUsage is the consumption a machine reported for a run.
type RunReportedUsage struct {
	Quantity, QuantityBasis      string
	SpoolID, MaterialID          *uuid.UUID
	SpoolDisplayID, MaterialName *string
}

type RunReportedUsageItem struct {
	LineNumber, Extruder                                                   *int
	ReportRevision                                                         int64
	SlicerFilamentID, InputUnitExternalID, SlotExternalID                  *string
	PlannedQuantityGrams, PlannedLengthMillimeters, EstimatedQuantityGrams *string
	MaterialID, SpoolID                                                    *uuid.UUID
	Method, CalculationVersion, Quality                                    string
}

type RunJobReference struct {
	ID        uuid.UUID
	DisplayID string
	Title     *string
}

// MachineRun is one period of work on a machine: entered manually by staff or
// recorded by a machine connector. State is derived: a manual run is running
// until its planned end.
type MachineRun struct {
	ID, MachineID           uuid.UUID
	DisplayID, MachineName  string
	Source, State           string
	Job                     *RunJobReference
	ConnectorName, FileName *string
	StartedAt               time.Time
	EndedAt, EstimatedEndAt *time.Time
	DurationSeconds         int64
	ProgressPercent         *int
	Outcome                 *string
	OutcomeFromMachine      bool
	Usages                  []MachineJobUsage
	UsagesFromMachine       bool
	ReportedUsage           *RunReportedUsage
	ReportedUsageItems      []RunReportedUsageItem
	Artifact                *ArtifactReference
	Version                 int64
}

// RunEvent exposes what a machine event reported, never its raw payload.
type RunEvent struct {
	ID              uuid.UUID
	Kind            string
	OccurredAt      time.Time
	State           *string
	ProgressPercent *int
	Quantity        *string
}

type RunDetail struct {
	MachineRun
	Events []RunEvent
}

type RunUpdateResult struct {
	Run MachineRun
	Job *MachineJob
}

type RunFilters struct {
	Search         string
	MachineID      *uuid.UUID
	States         []string
	Source         *string
	Assigned       *bool
	From, To       *time.Time
	Page, PageSize int
}

// RunUpdate changes a run. Times can only change on manual runs; Outcome nil
// clears the outcome.
type RunUpdate struct {
	StartsAt, EndsAt *time.Time
	Outcome          *string
}

// RunJobInput is what staff supply to create a job from a recorded run.
type RunJobInput struct {
	Title            *string
	Customer         PartyReference
	OperatorPersonID uuid.UUID
	Notes            *string
	PricingGroupID   *uuid.UUID
}

var runStates = []string{"running", "finished", "failed", "cancelled", "unknown", "replaced"}

// machineOutcome maps a recorded run's final state to the outcome the machine
// implies.
func machineOutcome(state string) string {
	switch state {
	case "finished":
		return "successful"
	case "failed":
		return "failed"
	case "cancelled":
		return "cancelled"
	}
	return ""
}

func escapeLike(value string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
}

func usageFromRow(u machinelogbookdb.ListRunUsagesForRunsRow) MachineJobUsage {
	return MachineJobUsage{ID: u.ID, MaterialID: u.MaterialID, SpoolID: u.SpoolID, Ownership: u.Ownership, MaterialName: u.MaterialName, Category: u.Category, Unit: u.Unit, Quantity: decimalString(u.Quantity), QuantityBasis: u.QuantityBasis, SpoolDisplayID: u.SpoolDisplayID, FillNumber: u.FillNumber, EstimationMethod: u.EstimationMethod, CalculationVersion: u.CalculationVersion, EstimateQuality: u.EstimateQuality, ReportRevision: u.ReportRevision, StaffCorrected: u.StaffCorrected}
}

func runFromRow(row machinelogbookdb.ListRunsRow, now time.Time) MachineRun {
	started := row.RunStartedAt.UTC()
	run := MachineRun{ID: row.ID, DisplayID: row.DisplayID, MachineID: row.MachineID, MachineName: row.MachineName, Source: row.Source, State: row.RunState, ConnectorName: row.ConnectorName, FileName: row.FileName,
		StartedAt: started, Outcome: row.Outcome, UsagesFromMachine: row.UsagesFromMachine, Version: row.Version, Usages: []MachineJobUsage{}, ReportedUsageItems: []RunReportedUsageItem{}}
	if row.ArtifactID != nil && row.ArtifactParserStatus != nil {
		run.Artifact = &ArtifactReference{ID: *row.ArtifactID, SHA256: row.ArtifactSha256, ParserStatus: *row.ArtifactParserStatus}
	}
	if row.JobID != nil && row.JobDisplayID != nil {
		run.Job = &RunJobReference{ID: *row.JobID, DisplayID: *row.JobDisplayID, Title: row.JobTitle}
	}
	end := nullableTime(row.EndedAt)
	if row.Source == "manual" {
		// A running manual run ends at its planned end.
		if row.RunState == "running" {
			run.EstimatedEndAt = end
		} else {
			run.EndedAt = end
		}
		if end != nil {
			run.DurationSeconds = max(0, int64(end.Sub(started).Seconds()))
		}
	} else {
		run.EndedAt, run.EstimatedEndAt = end, nullableTime(row.EstimatedEndAt)
		effective := now
		switch {
		case end != nil:
			effective = *end
		case run.EstimatedEndAt != nil && run.EstimatedEndAt.After(now):
			effective = *run.EstimatedEndAt
		}
		run.DurationSeconds = max(0, int64(effective.Sub(started).Seconds()))
		run.OutcomeFromMachine = row.Outcome != nil && *row.Outcome == machineOutcome(row.RunState)
	}
	if row.ProgressPercent != nil {
		percent := int(*row.ProgressPercent)
		run.ProgressPercent = &percent
	}
	if row.ReportedQuantityG.Valid && row.ReportedQuantityBasis != nil {
		run.ReportedUsage = &RunReportedUsage{Quantity: decimalString(row.ReportedQuantityG), QuantityBasis: *row.ReportedQuantityBasis, SpoolID: row.ReportedSpoolID, SpoolDisplayID: row.SpoolDisplayID, MaterialID: row.MaterialID, MaterialName: row.MaterialName}
	}
	return run
}

// queryRuns loads runs with their active usages.
func (s *Service) queryRuns(ctx context.Context, q *machinelogbookdb.Queries, params machinelogbookdb.ListRunsParams) ([]MachineRun, int64, error) {
	now := s.now().UTC()
	params.Now = now
	if params.States == nil {
		params.States = []string{}
	}
	rows, err := q.ListRuns(ctx, params)
	if err != nil {
		return nil, 0, err
	}
	var total int64
	ids := make([]uuid.UUID, 0, len(rows))
	runs := make([]MachineRun, 0, len(rows))
	for _, row := range rows {
		total = row.Total
		ids = append(ids, row.ID)
		runs = append(runs, runFromRow(row, now))
	}
	usages, err := q.ListRunUsagesForRuns(ctx, ids)
	if err != nil {
		return nil, 0, err
	}
	byRun := map[uuid.UUID][]MachineJobUsage{}
	for _, u := range usages {
		byRun[u.RunID] = append(byRun[u.RunID], usageFromRow(u))
	}
	for i := range runs {
		if list := byRun[runs[i].ID]; list != nil {
			runs[i].Usages = list
		}
	}
	reported, err := q.ListLatestReportedUsageItemsForRuns(ctx, ids)
	if err != nil {
		return nil, 0, err
	}
	byReported := map[uuid.UUID][]RunReportedUsageItem{}
	for _, item := range reported {
		line := int(item.LineNumber)
		var extruder *int
		if item.Extruder != nil {
			v := int(*item.Extruder)
			extruder = &v
		}
		toString := func(n pgtype.Numeric) *string {
			if !n.Valid {
				return nil
			}
			v := decimalString(n)
			return &v
		}
		byReported[item.RunID] = append(byReported[item.RunID], RunReportedUsageItem{LineNumber: &line, Extruder: extruder, ReportRevision: item.ReportRevision, SlicerFilamentID: item.SlicerFilamentID, InputUnitExternalID: item.InputUnitExternalID, SlotExternalID: item.SlotExternalID, PlannedQuantityGrams: toString(item.PlannedQuantityG), PlannedLengthMillimeters: toString(item.PlannedLengthMm), EstimatedQuantityGrams: toString(item.EstimatedQuantityG), MaterialID: item.MaterialID, SpoolID: item.SpoolID, Method: item.Method, CalculationVersion: item.CalculationVersion, Quality: item.Quality})
	}
	for i := range runs {
		if list := byReported[runs[i].ID]; list != nil {
			runs[i].ReportedUsageItems = list
		}
	}
	return runs, total, nil
}

// runsForJob returns every run of a job, oldest first, replaced ones included.
func (s *Service) runsForJob(ctx context.Context, q *machinelogbookdb.Queries, jobID uuid.UUID) ([]MachineRun, error) {
	runs, _, err := s.queryRuns(ctx, q, machinelogbookdb.ListRunsParams{JobID: &jobID, OldestFirst: true, PageLimit: 500})
	return runs, err
}

func (s *Service) loadRun(ctx context.Context, q *machinelogbookdb.Queries, id uuid.UUID) (MachineRun, error) {
	runs, _, err := s.queryRuns(ctx, q, machinelogbookdb.ListRunsParams{RunID: &id, PageLimit: 1})
	if err != nil {
		return MachineRun{}, err
	}
	if len(runs) == 0 {
		return MachineRun{}, apperror.NotFound
	}
	return runs[0], nil
}

func (s *Service) ListRuns(ctx context.Context, p authorization.Principal, filters RunFilters) ([]MachineRun, int64, error) {
	if err := require(p, authorization.MachineJobsRead); err != nil {
		return nil, 0, err
	}
	offset, limit, err := pageBounds(filters.Page, filters.PageSize)
	if err != nil {
		return nil, 0, err
	}
	if filters.From != nil && filters.To != nil && !filters.To.After(*filters.From) {
		return nil, 0, validation("to must be after from")
	}
	if !containsAll(runStates, filters.States) || (filters.Source != nil && *filters.Source != "manual" && *filters.Source != "recorded") {
		return nil, 0, validation("unsupported run filter")
	}
	return s.queryRuns(ctx, machinelogbookdb.New(s.pool), machinelogbookdb.ListRunsParams{Search: escapeLike(strings.TrimSpace(filters.Search)), MachineID: filters.MachineID, States: filters.States, Source: filters.Source, Assigned: filters.Assigned,
		FromTime: pgTime(filters.From), ToTime: pgTime(filters.To), PageOffset: offset, PageLimit: limit})
}

func (s *Service) GetRun(ctx context.Context, p authorization.Principal, id uuid.UUID) (RunDetail, error) {
	if err := require(p, authorization.MachineJobsRead); err != nil {
		return RunDetail{}, err
	}
	q := machinelogbookdb.New(s.pool)
	run, err := s.loadRun(ctx, q, id)
	if err != nil {
		return RunDetail{}, err
	}
	events, err := q.ListRunEvents(ctx, &id)
	if err != nil {
		return RunDetail{}, err
	}
	detail := RunDetail{MachineRun: run, Events: make([]RunEvent, 0, len(events))}
	for _, event := range events {
		detail.Events = append(detail.Events, runEventFromRow(event))
	}
	return detail, nil
}

// runEventFromRow keeps the few reported facts the run page shows and drops
// everything else in the connector payload.
func runEventFromRow(row machinelogbookdb.ListRunEventsRow) RunEvent {
	event := RunEvent{ID: row.ID, Kind: row.Kind, OccurredAt: row.OccurredAt}
	var values map[string]any
	if json.Unmarshal(row.Payload, &values) != nil {
		return event
	}
	key := "state"
	if row.Kind == "terminal_outcome" {
		key = "outcome"
	}
	if value, ok := values[key].(string); ok && value != "" && len(value) <= 64 {
		event.State = &value
	}
	if value, ok := values["percent"].(float64); ok && value >= 0 && value <= 100 {
		percent := int(value + 0.5)
		event.ProgressPercent = &percent
	}
	if value, ok := values["quantityGrams"].(string); ok && row.Kind == "consumption_report" {
		if parsed, err := decimal.NewFromString(strings.TrimSpace(value)); err == nil && parsed.IsPositive() {
			quantity := parsed.String()
			event.Quantity = &quantity
		}
	}
	return event
}

// replaceRunUsages reverses the given active usages with compensating
// inventory transactions, deactivates them and records the new usages with
// their consumption. The caller holds the locks on the run (and its job).
func (s *Service) replaceRunUsages(ctx context.Context, tx pgx.Tx, q *machinelogbookdb.Queries, p authorization.Principal, runID uuid.UUID, old []machinelogbookdb.MachineRunUsage, parsed []parsedUsage, occurredAt time.Time, requestID *uuid.UUID) error {
	materialIDs := map[uuid.UUID]bool{}
	for _, u := range old {
		if u.Ownership == "makerspace" && u.MaterialID != nil {
			materialIDs[*u.MaterialID] = true
		}
	}
	for _, u := range parsed {
		if u.Ownership == "makerspace" && u.MaterialID != nil {
			materialIDs[*u.MaterialID] = true
		}
	}
	ordered := make([]uuid.UUID, 0, len(materialIDs))
	for materialID := range materialIDs {
		ordered = append(ordered, materialID)
	}
	sort.Slice(ordered, func(i, j int) bool { return bytes.Compare(ordered[i][:], ordered[j][:]) < 0 })
	versions := map[uuid.UUID]int64{}
	for _, materialID := range ordered {
		row, err := q.GetMaterialForUpdate(ctx, materialID)
		if err != nil {
			return noRows(err)
		}
		versions[materialID] = row.InventoryVersion
	}
	for _, u := range old {
		if u.Ownership != "external" {
			row, err := q.GetMaterialForUpdate(ctx, *u.MaterialID)
			if err != nil {
				return err
			}
			average := decimalFromNumeric(row.AverageUnitCost)
			quantity := decimalFromNumeric(u.Quantity)
			reversal, err := s.reversalFill(ctx, q, u)
			if err != nil {
				return err
			}
			usageID := u.ID
			if _, err = s.applyInventoryMutation(ctx, tx, q, p, *u.MaterialID, versions[*u.MaterialID], inventoryMutation{Kind: "adjustment", QuantityDelta: quantity, UnitCost: average, ValueDelta: quantity.Mul(average), OccurredAt: time.Now().UTC(), Reason: stringPointer("job_corrected"), UsageID: &usageID, Fill: reversal}, requestID); err != nil {
				return err
			}
			versions[*u.MaterialID]++
		}
		if err := q.DeactivateRunUsage(ctx, u.ID); err != nil {
			return err
		}
	}
	if err := s.resolveUsageFills(ctx, q, parsed); err != nil {
		return err
	}
	if err := s.insertUsages(ctx, q, runID, parsed); err != nil {
		return err
	}
	for _, u := range parsed {
		if u.Ownership == "external" {
			continue
		}
		row, err := q.GetMaterialForUpdate(ctx, *u.MaterialID)
		if err != nil {
			return err
		}
		average := decimalFromNumeric(row.AverageUnitCost)
		usageID := u.UsageID
		if _, err = s.applyInventoryMutation(ctx, tx, q, p, *u.MaterialID, versions[*u.MaterialID], inventoryMutation{Kind: "machine_run_consumption", QuantityDelta: u.Quantity.Neg(), UnitCost: average, ValueDelta: u.Quantity.Mul(average).Neg(), OccurredAt: occurredAt, UsageID: &usageID, Fill: u.Fill}, requestID); err != nil {
			return err
		}
		versions[*u.MaterialID]++
	}
	return nil
}

// lockedRun locks a run and, when it belongs to a job, the job. The job is
// always locked before its runs, the order of every job operation.
func (s *Service) lockedRun(ctx context.Context, tx pgx.Tx, id uuid.UUID) (machinelogbookdb.MachineRun, *machinelogbookdb.MachineJob, error) {
	run, job, err := LockRunChain(ctx, tx, id)
	if err != nil {
		return run, nil, err
	}
	return run, job, nil
}

// LockRunChain locks the job of a run and then the run, never the other way
// around, so it cannot deadlock with job operations that lock a job before its
// runs. The run's job is read without a lock; once the job is locked the run is
// locked and its job re-checked. If the run moved to another job meanwhile, the
// locks of the attempt are released and the attempt is repeated once. It
// returns apperror.NotFound for an unknown run.
func LockRunChain(ctx context.Context, tx pgx.Tx, id uuid.UUID) (machinelogbookdb.MachineRun, *machinelogbookdb.MachineJob, error) {
	for attempt := 0; attempt < 2; attempt++ {
		run, job, ok, err := tryLockRunChain(ctx, tx, id)
		if err != nil {
			return run, nil, err
		}
		if ok {
			return run, job, nil
		}
	}
	return machinelogbookdb.MachineRun{}, nil, apperror.New(409, "retry_conflict", "The request conflicted with a concurrent change; try again")
}

func tryLockRunChain(ctx context.Context, tx pgx.Tx, id uuid.UUID) (machinelogbookdb.MachineRun, *machinelogbookdb.MachineJob, bool, error) {
	attempt, err := tx.Begin(ctx) // a savepoint, so a failed attempt releases its row locks
	if err != nil {
		return machinelogbookdb.MachineRun{}, nil, false, err
	}
	defer attempt.Rollback(ctx)
	q := machinelogbookdb.New(attempt)
	base, err := q.GetRunBase(ctx, id)
	if err != nil {
		return base, nil, false, noRows(err)
	}
	var job *machinelogbookdb.MachineJob
	if base.JobID != nil {
		locked, err := q.GetMachineJobForUpdate(ctx, *base.JobID)
		if err != nil {
			return base, nil, false, noRows(err)
		}
		job = &locked
	}
	run, err := q.GetRunForUpdate(ctx, id)
	if err != nil {
		return run, nil, false, noRows(err)
	}
	if (run.JobID == nil) != (base.JobID == nil) || (run.JobID != nil && *run.JobID != *base.JobID) {
		return run, nil, false, nil
	}
	if err = attempt.Commit(ctx); err != nil {
		return run, nil, false, err
	}
	return run, job, true, nil
}

// manualRunState is the state a manual run has at a point in time.
func manualRunState(run machinelogbookdb.MachineRun, now time.Time) string {
	if run.State != nil {
		return *run.State
	}
	if run.EndedAt.Valid && run.EndedAt.Time.After(now) {
		return "running"
	}
	return "finished"
}

// finishRunChange reprices the run's job, audits the change and returns the
// updated run with its job.
func (s *Service) finishRunChange(ctx context.Context, tx pgx.Tx, q *machinelogbookdb.Queries, p authorization.Principal, run machinelogbookdb.MachineRun, action string, fields []string, requestID *uuid.UUID) error {
	if err := writeAudit(ctx, tx, p, action, "machine_run", run.ID, requestID, fields); err != nil {
		return err
	}
	if run.JobID == nil {
		return nil
	}
	if _, err := s.settleJob(ctx, q, *run.JobID); err != nil {
		return err
	}
	return writeAudit(ctx, tx, p, "machine_job.repriced", "machine_job", *run.JobID, requestID, []string{"runs", "calculatedPrice", "effectivePrice"})
}

func (s *Service) runResult(ctx context.Context, id uuid.UUID) (RunUpdateResult, error) {
	q := machinelogbookdb.New(s.pool)
	run, err := s.loadRun(ctx, q, id)
	if err != nil {
		return RunUpdateResult{}, err
	}
	result := RunUpdateResult{Run: run}
	if run.Job != nil {
		job, err := s.loadJob(ctx, run.Job.ID)
		if err != nil {
			return RunUpdateResult{}, err
		}
		result.Job = &job
	}
	return result, nil
}

// UpdateRun corrects a run: the outcome of any run and the times of manual
// runs. An outcome cannot be recorded while the run is running.
func (s *Service) UpdateRun(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, input RunUpdate, requestID *uuid.UUID) (RunUpdateResult, error) {
	if err := require(p, authorization.MachineJobsEdit); err != nil {
		return RunUpdateResult{}, err
	}
	if expected < 1 {
		return RunUpdateResult{}, validation("expectedVersion must be positive")
	}
	outcome, err := validateOptionalOutcome(input.Outcome)
	if err != nil {
		return RunUpdateResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return RunUpdateResult{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	run, _, err := s.lockedRun(ctx, tx, id)
	if err != nil {
		return RunUpdateResult{}, err
	}
	if run.Version != expected {
		return RunUpdateResult{}, apperror.StaleWrite
	}
	now := s.now()
	fields := []string{"outcome"}
	var updated machinelogbookdb.MachineRun
	if run.Source == "manual" {
		if manualRunState(run, now) == "replaced" {
			return RunUpdateResult{}, conflict("run_replaced", "A replaced run cannot be changed")
		}
		startsAt, endsAt := run.StartedAt.Time, run.EndedAt.Time
		if input.StartsAt != nil {
			startsAt = input.StartsAt.UTC()
			fields = append(fields, "startsAt")
		}
		if input.EndsAt != nil {
			endsAt = input.EndsAt.UTC()
			fields = append(fields, "endsAt")
		}
		if err = validateInterval(startsAt, endsAt); err != nil {
			return RunUpdateResult{}, err
		}
		if err = validateOutcomeTiming(endsAt, outcome, now); err != nil {
			return RunUpdateResult{}, err
		}
		updated, err = q.UpdateManualRunFacts(ctx, machinelogbookdb.UpdateManualRunFactsParams{StartedAt: pgTime(&startsAt), EndedAt: pgTime(&endsAt), Outcome: outcome, ID: id, ExpectedVersion: expected})
	} else {
		if input.StartsAt != nil || input.EndsAt != nil {
			return RunUpdateResult{}, apperror.New(422, "run_times_read_only", "The times of a recorded run come from the machine")
		}
		if run.State != nil && *run.State == "running" && outcome != nil {
			return RunUpdateResult{}, apperror.New(422, "outcome_before_run_end", "An outcome cannot be recorded before the run has ended")
		}
		updated, err = q.UpdateRecordedRunOutcome(ctx, machinelogbookdb.UpdateRecordedRunOutcomeParams{Outcome: outcome, ID: id, ExpectedVersion: expected})
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return RunUpdateResult{}, apperror.StaleWrite
	}
	if err != nil {
		return RunUpdateResult{}, databaseError(err)
	}
	if err = s.finishRunChange(ctx, tx, q, p, updated, "machine_run.updated", fields, requestID); err != nil {
		return RunUpdateResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return RunUpdateResult{}, err
	}
	return s.runResult(ctx, id)
}

// ReplaceRunUsages swaps the run's material usage for the given one with
// compensating inventory transactions. Usage set by staff replaces what the
// machine reported.
func (s *Service) ReplaceRunUsages(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, inputs []UsageInput, requestID *uuid.UUID) (RunUpdateResult, error) {
	if err := require(p, authorization.MachineJobsEdit); err != nil {
		return RunUpdateResult{}, err
	}
	if expected < 1 {
		return RunUpdateResult{}, validation("expectedVersion must be positive")
	}
	parsed, err := parseUsages(inputs)
	if err != nil {
		return RunUpdateResult{}, err
	}
	for i := range parsed {
		parsed[i].StaffCorrected = true
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return RunUpdateResult{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	run, _, err := s.lockedRun(ctx, tx, id)
	if err != nil {
		return RunUpdateResult{}, err
	}
	if run.Version != expected {
		return RunUpdateResult{}, apperror.StaleWrite
	}
	if run.State != nil && *run.State == "replaced" {
		return RunUpdateResult{}, conflict("run_replaced", "A replaced run cannot be changed")
	}
	old, err := q.ListActiveRunUsagesForUpdate(ctx, id)
	if err != nil {
		return RunUpdateResult{}, err
	}
	if err = s.replaceRunUsages(ctx, tx, q, p, id, old, parsed, time.Now().UTC(), requestID); err != nil {
		return RunUpdateResult{}, err
	}
	updated, err := q.BumpRunVersion(ctx, machinelogbookdb.BumpRunVersionParams{ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return RunUpdateResult{}, apperror.StaleWrite
	}
	if err != nil {
		return RunUpdateResult{}, err
	}
	if err = s.finishRunChange(ctx, tx, q, p, updated, "machine_run.usages_replaced", []string{"usages", "inventory"}, requestID); err != nil {
		return RunUpdateResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return RunUpdateResult{}, err
	}
	return s.runResult(ctx, id)
}

// CancelRun ends a running manual run now and records it as cancelled.
func (s *Service) CancelRun(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, requestID *uuid.UUID) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsEdit); err != nil {
		return MachineJob{}, err
	}
	if expected < 1 {
		return MachineJob{}, validation("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	run, _, err := s.lockedRun(ctx, tx, id)
	if err != nil {
		return MachineJob{}, err
	}
	if run.Version != expected {
		return MachineJob{}, apperror.StaleWrite
	}
	now := s.now()
	if run.Source != "manual" || manualRunState(run, now) != "running" {
		return MachineJob{}, conflict("run_not_running", "Only a running manual run can be cancelled")
	}
	endsAt := now.UTC().Truncate(time.Second)
	if earliest := run.StartedAt.Time.Add(time.Second); endsAt.Before(earliest) {
		endsAt = earliest
	}
	updated, err := q.CancelManualRun(ctx, machinelogbookdb.CancelManualRunParams{EndedAt: pgTime(&endsAt), ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return MachineJob{}, apperror.StaleWrite
	}
	if err != nil {
		return MachineJob{}, err
	}
	if err = s.finishRunChange(ctx, tx, q, p, updated, "machine_run.cancelled", []string{"endedAt", "state", "outcome"}, requestID); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, *run.JobID)
}

// AddManualRun adds a manual run, for example a reprint, to a job.
func (s *Service) AddManualRun(ctx context.Context, p authorization.Principal, jobID uuid.UUID, expectedJobVersion int64, input ManualRunInput, requestID *uuid.UUID) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsEdit); err != nil {
		return MachineJob{}, err
	}
	if expectedJobVersion < 1 {
		return MachineJob{}, validation("expectedJobVersion must be positive")
	}
	plan, err := planManualRun(input, s.now())
	if err != nil {
		return MachineJob{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	job, err := q.GetMachineJobForUpdate(ctx, jobID)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	if job.Version != expectedJobVersion {
		return MachineJob{}, apperror.StaleWrite
	}
	machine, err := q.GetMachineForUpdate(ctx, job.MachineID)
	if err != nil {
		return MachineJob{}, err
	}
	if machine.Status == "retired" {
		return MachineJob{}, conflict("machine_retired", "Retired machines cannot receive new runs")
	}
	if _, err = s.storeManualRun(ctx, tx, q, p, job, plan, requestID); err != nil {
		return MachineJob{}, err
	}
	if _, err = s.settleJob(ctx, q, jobID); err != nil {
		return MachineJob{}, err
	}
	if err = writeAudit(ctx, tx, p, "machine_job.run_added", "machine_job", jobID, requestID, []string{"runs", "usages", "calculatedPrice", "effectivePrice"}); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, jobID)
}

// CreateJobFromRun creates a job for an unassigned recorded run; the run may
// still be running.
func (s *Service) CreateJobFromRun(ctx context.Context, p authorization.Principal, runID uuid.UUID, input RunJobInput, requestID *uuid.UUID) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsCreate); err != nil {
		return MachineJob{}, err
	}
	title, err := cleanTitle(input.Title)
	if err != nil {
		return MachineJob{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	run, err := q.GetRunForUpdate(ctx, runID)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	if run.JobID != nil {
		return MachineJob{}, conflict("run_already_assigned", "The run already belongs to a job")
	}
	machine, err := q.GetMachineForUpdate(ctx, run.MachineID)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	if machine.Status == "retired" {
		return MachineJob{}, conflict("machine_retired", "Retired machines cannot receive new jobs")
	}
	personID, organizationID, err := validateJobAssignments(ctx, q, input.Customer, input.OperatorPersonID, false)
	if err != nil {
		return MachineJob{}, err
	}
	group, err := resolvePricingGroup(ctx, q, personID, organizationID, input.PricingGroupID)
	if err != nil {
		return MachineJob{}, err
	}
	job, err := s.insertJob(ctx, q, s.now(), run.MachineID, personID, organizationID, input.OperatorPersonID, title, cleanOptional(input.Notes))
	if err != nil {
		return MachineJob{}, err
	}
	if _, err = q.AssignRunToJob(ctx, machinelogbookdb.AssignRunToJobParams{JobID: &job.ID, ID: runID, MachineID: run.MachineID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return MachineJob{}, conflict("run_already_assigned", "The run already belongs to a job")
		}
		return MachineJob{}, databaseError(err)
	}
	job, err = s.capturePricingSnapshot(ctx, q, p, job, group, "initial")
	if err != nil {
		return MachineJob{}, err
	}
	if err = writeAudit(ctx, tx, p, "machine_job.created", "machine_job", job.ID, requestID, []string{"machineId", "title", "customer", "operatorPersonId", "notes", "runs", "pricingSnapshot"}); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, job.ID)
}

// AttachRun attaches an unassigned recorded run to a job on the same machine.
// With replaceManualRuns the job's manual runs are marked replaced and their
// material is reversed with compensating transactions, so the recorded run
// stands in for the manually entered work.
func (s *Service) AttachRun(ctx context.Context, p authorization.Principal, runID, jobID uuid.UUID, replaceManualRuns bool, expectedJobVersion int64, requestID *uuid.UUID) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsEdit); err != nil {
		return MachineJob{}, err
	}
	if expectedJobVersion < 1 {
		return MachineJob{}, validation("expectedJobVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	job, err := q.GetMachineJobForUpdate(ctx, jobID)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	run, err := q.GetRunForUpdate(ctx, runID)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	if run.JobID != nil {
		return MachineJob{}, conflict("run_already_assigned", "The run already belongs to a job")
	}
	if job.MachineID != run.MachineID {
		return MachineJob{}, conflict("run_machine_mismatch", "The run was recorded on another machine than the job")
	}
	if job.ArtifactID != nil && run.ArtifactID != nil && *job.ArtifactID != *run.ArtifactID {
		return MachineJob{}, conflict("artifact_mismatch", "Run and job reference different print artifacts")
	}
	if job.Version != expectedJobVersion {
		return MachineJob{}, apperror.StaleWrite
	}
	fields := []string{"runs", "calculatedPrice", "effectivePrice"}
	if replaceManualRuns {
		runs, err := q.ListJobRunsForUpdate(ctx, &jobID)
		if err != nil {
			return MachineJob{}, err
		}
		for _, existing := range runs {
			if existing.Source != "manual" || (existing.State != nil && *existing.State == "replaced") {
				continue
			}
			old, err := q.ListActiveRunUsagesForUpdate(ctx, existing.ID)
			if err != nil {
				return MachineJob{}, err
			}
			if len(old) > 0 {
				if err = s.replaceRunUsages(ctx, tx, q, p, existing.ID, old, nil, time.Now().UTC(), requestID); err != nil {
					return MachineJob{}, err
				}
				fields = append(fields, "usages", "inventory")
			}
			if err = q.MarkManualRunReplaced(ctx, existing.ID); err != nil {
				return MachineJob{}, databaseError(err)
			}
		}
	}
	if _, err = q.AssignRunToJob(ctx, machinelogbookdb.AssignRunToJobParams{JobID: &jobID, ID: runID, MachineID: job.MachineID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return MachineJob{}, conflict("run_already_assigned", "The run already belongs to a job")
		}
		return MachineJob{}, databaseError(err)
	}
	if _, err = s.settleJob(ctx, q, jobID); err != nil {
		return MachineJob{}, err
	}
	if err = writeAudit(ctx, tx, p, "machine_job.run_attached", "machine_job", jobID, requestID, dedupe(fields)); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, jobID)
}

// AttachPlannedRunSystem performs the connector-only exact-artifact attach in
// the caller's transaction. It never replaces a staff assignment and only
// accepts a job that still has no active runs and references the same artifact.
func (s *Service) AttachPlannedRunSystem(ctx context.Context, tx pgx.Tx, connectorID, assignmentID, runID, jobID, artifactID uuid.UUID, requestID *uuid.UUID) (bool, error) {
	q := machinelogbookdb.New(tx)
	job, err := q.GetMachineJobForUpdate(ctx, jobID)
	if err != nil {
		return false, noRows(err)
	}
	run, err := q.GetRunForUpdate(ctx, runID)
	if err != nil {
		return false, noRows(err)
	}
	if run.JobID != nil {
		return false, nil
	}
	if job.ArtifactID == nil || run.ArtifactID == nil || *job.ArtifactID != artifactID || *run.ArtifactID != artifactID || job.MachineID != run.MachineID {
		return false, conflict("artifact_mismatch", "Run and planned job artifacts must match exactly")
	}
	active, err := q.ListActiveJobRunIDs(ctx, &jobID)
	if err != nil {
		return false, err
	}
	if len(active) != 0 {
		return false, nil
	}
	if _, err = q.AssignRunToJob(ctx, machinelogbookdb.AssignRunToJobParams{JobID: &jobID, ID: runID, MachineID: job.MachineID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	if _, err = s.settleJob(ctx, q, jobID); err != nil {
		return false, err
	}
	if err = audit.Write(ctx, tx, audit.Event{ActorType: "system", Action: "machine_run.artifact_auto_attached", ResourceType: "machine_run", ResourceID: &runID, RequestID: requestID, Source: "system", ChangedFields: []string{"jobId"}, Metadata: map[string]any{"connectorId": connectorID.String(), "assignmentId": assignmentID.String(), "runId": runID.String(), "jobId": jobID.String(), "artifactId": artifactID.String()}}); err != nil {
		return false, err
	}
	return true, nil
}

func dedupe(values []string) []string {
	seen := map[string]bool{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		if !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	return result
}

// DetachRun detaches a recorded run from its job. The run keeps its material
// and its consumption. When it was the job's only run that is not replaced,
// the job gets a manual run with the same start, end (now while the run still
// runs) and outcome but no material, so the job keeps its times and its
// material then comes only from its remaining runs.
func (s *Service) DetachRun(ctx context.Context, p authorization.Principal, runID uuid.UUID, expectedJobVersion int64, requestID *uuid.UUID) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsEdit); err != nil {
		return MachineJob{}, err
	}
	if expectedJobVersion < 1 {
		return MachineJob{}, validation("expectedJobVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	run, job, err := s.lockedRun(ctx, tx, runID)
	if err != nil {
		return MachineJob{}, err
	}
	if run.Source != "recorded" {
		return MachineJob{}, conflict("run_not_recorded", "Only recorded runs can be detached")
	}
	if job == nil {
		return MachineJob{}, conflict("run_not_assigned", "The run does not belong to a job")
	}
	if job.Version != expectedJobVersion {
		return MachineJob{}, apperror.StaleWrite
	}
	active, err := q.ListActiveJobRunIDs(ctx, &job.ID)
	if err != nil {
		return MachineJob{}, err
	}
	if len(active) == 1 {
		now := s.now().UTC().Truncate(time.Second)
		start := run.FirstObservedAt.Time
		if run.StartedAt.Valid {
			start = run.StartedAt.Time
		}
		end := now
		if run.EndedAt.Valid {
			end = run.EndedAt.Time
		}
		if earliest := start.Add(time.Second); end.Before(earliest) {
			end = earliest
		}
		plan := manualRunPlan{StartsAt: start.UTC(), EndsAt: end.UTC(), Outcome: run.Outcome}
		if _, err = s.storeManualRun(ctx, tx, q, p, *job, plan, requestID); err != nil {
			return MachineJob{}, err
		}
	}
	if _, err = q.DetachRunFromJob(ctx, runID); err != nil {
		return MachineJob{}, databaseError(err)
	}
	if _, err = s.settleJob(ctx, q, job.ID); err != nil {
		return MachineJob{}, err
	}
	if err = writeAudit(ctx, tx, p, "machine_job.run_detached", "machine_job", job.ID, requestID, []string{"runs", "calculatedPrice", "effectivePrice"}); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, job.ID)
}
