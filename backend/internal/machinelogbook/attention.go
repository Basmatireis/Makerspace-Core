package machinelogbook

import (
	"context"
	"fmt"
	"time"

	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/google/uuid"
)

// ConnectorHeartbeatStale is how long a connector may stay silent before its machine counts as offline. The
// frontend reads a heartbeat of the same age as disconnected.
const ConnectorHeartbeatStale = 90 * time.Second

// runNeedsConsumptionConfirmation says whether a recorded run's material still needs someone: missing or only
// partly booked, or still pending although the run has ended.
func runNeedsConsumptionConfirmation(run MachineRun) bool {
	if run.Source != RunSourceRecorded || run.ConsumptionStatus == nil || run.State == RunStateReplaced {
		return false
	}
	switch run.ConsumptionStatus.State {
	case ConsumptionMissing, ConsumptionPartial:
		return true
	case ConsumptionPending:
		return run.State != RunStateRunning
	}
	return false
}

// runFailed says whether a run that counts for its job ended failed or cancelled.
func runFailed(run MachineRun) bool {
	if run.State == RunStateReplaced || run.Outcome == nil {
		return false
	}
	return *run.Outcome == RunOutcomeFailed || *run.Outcome == RunOutcomeCancelled
}

// runsAttention lists what the runs of a job (or one unassigned run) need.
func runsAttention(runs []MachineRun) []Attention {
	result := []Attention{}
	failed, unconfirmed := 0, 0
	for _, run := range runs {
		if runFailed(run) {
			failed++
		}
		if runNeedsConsumptionConfirmation(run) {
			unconfirmed++
		}
	}
	if failed > 0 {
		result = append(result, Attention{Code: AttentionRunFailed, Message: plural(failed, "A run failed.", "%d runs failed.")})
	}
	if unconfirmed > 0 {
		result = append(result, Attention{
			Code:    AttentionConsumptionUnconfirmed,
			Message: plural(unconfirmed, "Material of a run is not confirmed.", "Material of %d runs is not confirmed."),
		})
	}
	return result
}

func plural(count int, one, many string) string {
	if count == 1 {
		return one
	}
	return fmt.Sprintf(many, count)
}

// jobFacts are the job facts beyond its runs that decide its attention flags.
type jobFacts struct {
	ended, hasRecipient, onOrder, orderOutdated, priced bool
	status                                              JobStatus
	pricing                                             PricingStatus
}

func jobAttentionFrom(runs []MachineRun, facts jobFacts) []Attention {
	result := runsAttention(runs)
	if facts.status == JobStatusNeedsOutcome {
		result = append(result, Attention{Code: AttentionNeedsOutcome, Message: "The outcome is not recorded."})
	}
	if !facts.hasRecipient {
		result = append(result, Attention{Code: AttentionNoRecipient, Message: "The job has no recipient."})
	}
	if facts.pricing == PricingIncomplete {
		result = append(result, Attention{Code: AttentionPriceIncomplete, Message: "The price is incomplete."})
	}
	if facts.ended && facts.priced && !facts.onOrder {
		result = append(result, Attention{Code: AttentionNotOnOrder, Message: "The job is not on an order."})
	}
	if facts.orderOutdated {
		result = append(result, Attention{Code: AttentionOrderOutdated, Message: "The job changed after it was put on an order."})
	}
	return result
}

// pricedAboveZero says whether an effective price is set and above zero.
func pricedAboveZero(price *string) bool {
	if price == nil {
		return false
	}
	value, err := parseDecimal(*price, false)
	return err == nil && value.IsPositive()
}

// jobAttention derives the attention flags of a loaded job.
func jobAttention(ctx context.Context, q *machinelogbookdb.Queries, job MachineJob) ([]Attention, error) {
	rows, err := q.ListJobAttentionFacts(ctx, []uuid.UUID{job.ID})
	if err != nil {
		return nil, err
	}
	facts := jobFacts{
		ended:        job.Status != JobStatusRunning && job.Status != JobStatusPlanned,
		hasRecipient: job.Customer != nil,
		priced:       pricedAboveZero(job.EffectivePrice),
		status:       job.Status,
		pricing:      job.PricingStatus,
	}
	if len(rows) > 0 {
		facts.onOrder, facts.orderOutdated = rows[0].OnOrder, rows[0].OrderOutdated
	}
	return jobAttentionFrom(job.Runs, facts), nil
}

// attachWorkItemAttention fills the attention flags of a page of work items with one batch of queries.
func (s *Service) attachWorkItemAttention(ctx context.Context, q *machinelogbookdb.Queries, items []WorkItem) error {
	if len(items) == 0 {
		return nil
	}
	ids := make([]uuid.UUID, 0, len(items))
	jobIDs := []uuid.UUID{}
	for _, item := range items {
		ids = append(ids, item.ID)
		if item.Kind == WorkItemJob {
			jobIDs = append(jobIDs, item.ID)
		}
	}
	runs, _, err := s.queryRuns(ctx, q, machinelogbookdb.ListRunsParams{ItemIds: ids, OldestFirst: true, PageLimit: 10000})
	if err != nil {
		return err
	}
	runsByItem := map[uuid.UUID][]MachineRun{}
	for _, run := range runs {
		key := run.ID
		if run.Job != nil {
			key = run.Job.ID
		}
		runsByItem[key] = append(runsByItem[key], run)
	}
	facts, err := q.ListJobAttentionFacts(ctx, jobIDs)
	if err != nil {
		return err
	}
	factsByJob := map[uuid.UUID]machinelogbookdb.ListJobAttentionFactsRow{}
	for _, row := range facts {
		factsByJob[row.JobID] = row
	}
	for i := range items {
		item := &items[i]
		if item.Kind != WorkItemJob {
			item.Attention = runsAttention(runsByItem[item.ID])
			continue
		}
		row := factsByJob[item.ID]
		pricing := PricingComplete
		if item.Billing != nil && item.Billing.State == BillingPriceIncomplete {
			pricing = PricingIncomplete
		}
		item.Attention = jobAttentionFrom(runsByItem[item.ID], jobFacts{
			ended:         item.Status != WorkItemRunning,
			hasRecipient:  item.Customer != nil,
			onOrder:       row.OnOrder,
			orderOutdated: row.OrderOutdated,
			priced:        pricedAboveZero(item.EffectivePrice),
			status:        JobStatus(item.Status),
			pricing:       pricing,
		})
	}
	return nil
}

// attachMachineAttention fills the attention flags of machines with one query.
func (s *Service) attachMachineAttention(ctx context.Context, q *machinelogbookdb.Queries, machines ...*Machine) error {
	if len(machines) == 0 {
		return nil
	}
	ids := make([]uuid.UUID, 0, len(machines))
	for _, m := range machines {
		ids = append(ids, m.ID)
	}
	rows, err := q.ListMachineAttentionFacts(ctx, ids)
	if err != nil {
		return err
	}
	byMachine := map[uuid.UUID]machinelogbookdb.ListMachineAttentionFactsRow{}
	for _, row := range rows {
		byMachine[row.MachineID] = row
	}
	now := s.now().UTC()
	for _, m := range machines {
		row, ok := byMachine[m.ID]
		if !ok {
			m.Attention = []Attention{}
			continue
		}
		m.Attention = machineAttentionFrom(row, now)
	}
	return nil
}

func machineAttentionFrom(row machinelogbookdb.ListMachineAttentionFactsRow, now time.Time) []Attention {
	result := []Attention{}
	if MachineStatus(row.Status) == MachineStatusRetired {
		return result
	}
	if row.HasConnector {
		stale := !row.LastHeartbeatAt.Valid || now.Sub(row.LastHeartbeatAt.Time) > ConnectorHeartbeatStale
		state := ""
		if row.RuntimeState != nil {
			state = *row.RuntimeState
		}
		switch {
		case stale || state == "disconnected":
			result = append(result, Attention{Code: AttentionConnectorOffline, Message: "The printer connector is offline."})
		case state == "degraded" || row.RuntimeErrorCode != nil || (row.HealthState != nil && *row.HealthState == "degraded"):
			message := "The printer connector reports a problem."
			if row.RuntimeErrorCode != nil {
				message = "The printer connector reports " + *row.RuntimeErrorCode + "."
			}
			result = append(result, Attention{Code: AttentionConnectorError, Message: message})
		}
	}
	if row.PrinterErrorOpen {
		result = append(result, Attention{Code: AttentionPrinterErrorOpen, Message: "The printer reports an error."})
	}
	if MachineStatus(row.Status) == MachineStatusMaintenance {
		result = append(result, Attention{Code: AttentionOutOfOrder, Message: "The machine is in maintenance."})
	}
	if row.UnassignedRuns > 0 {
		result = append(result, Attention{
			Code: AttentionRunsUnassigned,
			Message: plural(
				int(row.UnassignedRuns),
				"A recorded run waits for a job.",
				"%d recorded runs wait for a job.",
			),
		})
	}
	return result
}
