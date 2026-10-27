package machinelogbook

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"
	"github.com/google/uuid"
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
	Source                  RunSource
	State                   RunState
	Job                     *RunJobReference
	ConnectorName, FileName *string
	StartedAt               time.Time
	EndedAt, EstimatedEndAt *time.Time
	DurationSeconds         int64
	ProgressPercent         *int
	Outcome                 *RunOutcome
	OutcomeFromMachine      bool
	Usages                  []MachineJobUsage
	Measures                RunMeasures
	UsagesFromMachine       bool
	ReportedUsage           *RunReportedUsage
	ReportedUsageItems      []RunReportedUsageItem
	Artifact                *ArtifactReference
	// ConsumptionStatus explains a recorded run's consumption; nil for manual runs.
	ConsumptionStatus *ConsumptionStatus
	// HiddenFromSignage hides the machine from signage displays while the run is running.
	HiddenFromSignage bool
	Version           int64
}

// RunEvent exposes what a machine event reported, never its raw payload.
type RunEvent struct {
	ID              uuid.UUID
	Kind            RunEventKind
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
	States         []RunState
	Source         *RunSource
	Assigned       *bool
	From, To       *time.Time
	Page, PageSize int
}

// RunUpdate changes a run. Times can only change on manual runs; Outcome nil
// clears the outcome.
type RunUpdate struct {
	StartsAt, EndsAt *time.Time
	Outcome          *RunOutcome
	// Measures nil leaves the measures unchanged; non-nil (even empty) replaces them.
	Measures RunMeasures
}

// RunJobInput is what staff supply to create a job from a recorded run.
type RunJobInput struct {
	Title            *string
	Customer         PartyReference
	OperatorPersonID uuid.UUID
	Notes            *string
	PricingGroupID   *uuid.UUID
}

var runStates = []RunState{
	RunStateRunning, RunStateFinished, RunStateFailed, RunStateCancelled, RunStateUnknown, RunStateReplaced,
}

// machineOutcome maps a recorded run's final state to the outcome the machine
// implies.
func machineOutcome(state RunState) RunOutcome {
	switch state {
	case RunStateFinished:
		return RunOutcomeSuccessful
	case RunStateFailed:
		return RunOutcomeFailed
	case RunStateCancelled:
		return RunOutcomeCancelled
	}
	return ""
}

func escapeLike(value string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
}

func usageFromRow(u machinelogbookdb.ListRunUsagesForRunsRow) MachineJobUsage {
	return MachineJobUsage{
		ID:                 u.ID,
		MaterialID:         u.MaterialID,
		SpoolID:            u.SpoolID,
		Ownership:          UsageOwnership(u.Ownership),
		MaterialName:       u.MaterialName,
		MaterialTypeID:     u.MaterialTypeID,
		MaterialTypeName:   u.MaterialTypeName,
		Unit:               u.Unit,
		Quantity:           decimalString(u.Quantity),
		QuantityBasis:      QuantityBasis(u.QuantityBasis),
		SpoolDisplayID:     u.SpoolDisplayID,
		FillNumber:         u.FillNumber,
		EstimationMethod:   u.EstimationMethod,
		CalculationVersion: u.CalculationVersion,
		EstimateQuality:    optional.Convert[EstimateQuality](u.EstimateQuality),
		ReportRevision:     u.ReportRevision,
		StaffCorrected:     u.StaffCorrected,
	}
}

func runFromRow(row machinelogbookdb.ListRunsRow, now time.Time) MachineRun {
	started := row.RunStartedAt.UTC()
	run := MachineRun{
		ID:                 row.ID,
		DisplayID:          row.DisplayID,
		MachineID:          row.MachineID,
		MachineName:        row.MachineName,
		Source:             RunSource(row.Source),
		State:              RunState(row.RunState),
		ConnectorName:      row.ConnectorName,
		FileName:           row.FileName,
		StartedAt:          started,
		Outcome:            optional.Convert[RunOutcome](row.Outcome),
		UsagesFromMachine:  row.UsagesFromMachine,
		HiddenFromSignage:  row.HiddenFromSignage,
		Version:            row.Version,
		Usages:             []MachineJobUsage{},
		Measures:           RunMeasures{},
		ReportedUsageItems: []RunReportedUsageItem{},
	}
	if row.ArtifactID != nil && row.ArtifactParserStatus != nil {
		run.Artifact = &ArtifactReference{
			ID:           *row.ArtifactID,
			SHA256:       row.ArtifactSha256,
			ParserStatus: *row.ArtifactParserStatus,
		}
	}
	if row.JobID != nil && row.JobDisplayID != nil {
		run.Job = &RunJobReference{ID: *row.JobID, DisplayID: *row.JobDisplayID, Title: row.JobTitle}
	}
	end := nullableTime(row.EndedAt)
	if RunSource(row.Source) == RunSourceManual {
		// A running manual run ends at its planned end.
		if RunState(row.RunState) == RunStateRunning {
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
		run.OutcomeFromMachine = row.Outcome != nil && RunOutcome(*row.Outcome) == machineOutcome(RunState(row.RunState))
	}
	if row.ProgressPercent != nil {
		percent := int(*row.ProgressPercent)
		run.ProgressPercent = &percent
	}
	if row.ReportedQuantityG.Valid && row.ReportedQuantityBasis != nil {
		run.ReportedUsage = &RunReportedUsage{
			Quantity:       decimalString(row.ReportedQuantityG),
			QuantityBasis:  *row.ReportedQuantityBasis,
			SpoolID:        row.ReportedSpoolID,
			SpoolDisplayID: row.SpoolDisplayID,
			MaterialID:     row.MaterialID,
			MaterialName:   row.MaterialName,
		}
	}
	return run
}

// queryRuns loads runs with their active usages.
func (s *Service) queryRuns(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	params machinelogbookdb.ListRunsParams,
) ([]MachineRun, int64, error) {
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
	measures, err := q.ListRunMeasuresForRuns(ctx, ids)
	if err != nil {
		return nil, 0, err
	}
	byMeasures := map[uuid.UUID]RunMeasures{}
	for _, m := range measures {
		if byMeasures[m.RunID] == nil {
			byMeasures[m.RunID] = RunMeasures{}
		}
		byMeasures[m.RunID][m.Measure] = m.Value
	}
	for i := range runs {
		if list := byMeasures[runs[i].ID]; list != nil {
			runs[i].Measures = list
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
		byReported[item.RunID] = append(
			byReported[item.RunID],
			RunReportedUsageItem{
				LineNumber:               &line,
				Extruder:                 extruder,
				ReportRevision:           item.ReportRevision,
				SlicerFilamentID:         item.SlicerFilamentID,
				InputUnitExternalID:      item.InputUnitExternalID,
				SlotExternalID:           item.SlotExternalID,
				PlannedQuantityGrams:     toString(item.PlannedQuantityG),
				PlannedLengthMillimeters: toString(item.PlannedLengthMm),
				EstimatedQuantityGrams:   toString(item.EstimatedQuantityG),
				MaterialID:               item.MaterialID,
				SpoolID:                  item.SpoolID,
				Method:                   item.Method,
				CalculationVersion:       item.CalculationVersion,
				Quality:                  item.Quality,
			},
		)
	}
	for i := range runs {
		if list := byReported[runs[i].ID]; list != nil {
			runs[i].ReportedUsageItems = list
		}
	}
	if err = s.attachConsumptionStatuses(ctx, q, runs, ids, now); err != nil {
		return nil, 0, err
	}
	return runs, total, nil
}

// attachConsumptionStatuses derives why each recorded run's consumption is (not) booked.
func (s *Service) attachConsumptionStatuses(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	runs []MachineRun,
	ids []uuid.UUID,
	now time.Time,
) error {
	if len(ids) == 0 {
		return nil
	}
	rows, err := q.ListRunConsumptionFacts(ctx, ids)
	if err != nil {
		return err
	}
	byRun := make(map[uuid.UUID]machinelogbookdb.ListRunConsumptionFactsRow, len(rows))
	for _, row := range rows {
		byRun[row.RunID] = row
	}
	for i := range runs {
		run := &runs[i]
		row, recorded := byRun[run.ID]
		if !recorded || run.Source != RunSourceRecorded {
			continue
		}
		facts := ConsumptionFacts{
			Recorded:          true,
			State:             run.State,
			EndedAt:           run.EndedAt,
			HasArtifact:       run.Artifact != nil,
			Items:             run.ReportedUsageItems,
			Legacy:            run.ReportedUsage,
			ConnectorState:    row.ConsumptionState,
			ConnectorReason:   row.ConsumptionReason,
			ConnectorDetail:   row.ConsumptionDetail,
			TerminalReason:    row.TerminalReason,
			AssignmentRemoved: row.AssignmentRemoved,
		}
		if run.UsagesFromMachine {
			facts.MachineUsages = len(run.Usages)
		} else {
			facts.StaffUsages = len(run.Usages)
		}
		run.ConsumptionStatus = DeriveConsumptionStatus(facts, now)
	}
	return nil
}

// runsForJob returns every run of a job, oldest first, replaced ones included.
func (s *Service) runsForJob(ctx context.Context, q *machinelogbookdb.Queries, jobID uuid.UUID) ([]MachineRun, error) {
	runs, _, err := s.queryRuns(
		ctx,
		q,
		machinelogbookdb.ListRunsParams{JobID: &jobID, OldestFirst: true, PageLimit: 500},
	)
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

func (s *Service) ListRuns(
	ctx context.Context,
	p authorization.Principal,
	filters RunFilters,
) ([]MachineRun, int64, error) {
	if err := require(p, authorization.MachineJobsRead); err != nil {
		return nil, 0, err
	}
	offset, limit, err := pageBounds(filters.Page, filters.PageSize)
	if err != nil {
		return nil, 0, err
	}
	if filters.From != nil && filters.To != nil && !filters.To.After(*filters.From) {
		return nil, 0, apperror.Invalid("to must be after from")
	}
	if !containsAll(runStates, filters.States) ||
		(filters.Source != nil && *filters.Source != RunSourceManual && *filters.Source != RunSourceRecorded) {
		return nil, 0, apperror.Invalid("unsupported run filter")
	}
	return s.queryRuns(
		ctx,
		machinelogbookdb.New(s.pool),
		machinelogbookdb.ListRunsParams{
			Search:     escapeLike(strings.TrimSpace(filters.Search)),
			MachineID:  filters.MachineID,
			States:     optional.ConvertSlice[string](filters.States),
			Source:     optional.Convert[string](filters.Source),
			Assigned:   filters.Assigned,
			FromTime:   pgTime(filters.From),
			ToTime:     pgTime(filters.To),
			PageOffset: offset,
			PageLimit:  limit,
		},
	)
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
	event := RunEvent{ID: row.ID, Kind: RunEventKind(row.Kind), OccurredAt: row.OccurredAt}
	var values map[string]any
	if json.Unmarshal(row.Payload, &values) != nil {
		return event
	}
	key := "state"
	if RunEventKind(row.Kind) == RunEventTerminalOutcome {
		key = "outcome"
	}
	if value, ok := values[key].(string); ok && value != "" && len(value) <= 64 {
		event.State = &value
	}
	if value, ok := values["percent"].(float64); ok && value >= 0 && value <= 100 {
		percent := int(value + 0.5)
		event.ProgressPercent = &percent
	}
	if value, ok := values["quantityGrams"].(string); ok && RunEventKind(row.Kind) == RunEventConsumptionReport {
		if parsed, err := decimal.NewFromString(strings.TrimSpace(value)); err == nil && parsed.IsPositive() {
			quantity := parsed.String()
			event.Quantity = &quantity
		}
	}
	return event
}
