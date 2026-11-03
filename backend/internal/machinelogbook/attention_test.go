package machinelogbook

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

func attentionCodes(items []Attention) []AttentionCode {
	codes := make([]AttentionCode, 0, len(items))
	for _, item := range items {
		codes = append(codes, item.Code)
	}
	return codes
}

func TestJobsCarryWhatNeedsAttention(t *testing.T) {
	f := newJobFixture(t)
	ctx := t.Context()
	done := f.create(t, f.input(-3*time.Hour, time.Hour, JobOutcomeSuccessful))
	if codes := attentionCodes(done.Attention); !slices.Equal(codes, []AttentionCode{AttentionNotOnOrder}) {
		t.Fatalf("finished priced job = %v", codes)
	}
	failed := f.create(t, f.input(-3*time.Hour, time.Hour, JobOutcomeFailed))
	if codes := attentionCodes(failed.Attention); !slices.Contains(codes, AttentionRunFailed) {
		t.Fatalf("failed job = %v", codes)
	}
	open := f.create(t, f.input(-3*time.Hour, time.Hour, JobOutcomeUnknown))
	if codes := attentionCodes(open.Attention); !slices.Contains(codes, AttentionNeedsOutcome) {
		t.Fatalf("job without outcome = %v", codes)
	}
	unpriced := f.input(-3*time.Hour, time.Hour, JobOutcomeSuccessful)
	unpriced.MachineID = f.bareMachine.ID
	incomplete := f.create(t, unpriced)
	if codes := attentionCodes(incomplete.Attention); !slices.Contains(codes, AttentionPriceIncomplete) {
		t.Fatalf("job without price rule = %v", codes)
	}
	// The job table carries the same flags.
	items, _, err := f.s.ListWorkItems(ctx, f.p, WorkItemFilters{MachineIDs: []uuid.UUID{f.machine.ID}, PageSize: 50, Page: 1})
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string][]AttentionCode{}
	for _, item := range items {
		byID[item.ID.String()] = attentionCodes(item.Attention)
	}
	if !slices.Equal(byID[done.ID.String()], attentionCodes(done.Attention)) ||
		!slices.Contains(byID[failed.ID.String()], AttentionRunFailed) {
		t.Fatalf("work items = %v", byID)
	}
}

func TestMachinesCarryWhatNeedsAttention(t *testing.T) {
	h := newRunHarness(t)
	ctx := t.Context()
	// The harness connector never sent a heartbeat.
	machine, err := h.s.GetMachine(ctx, h.p, h.machine.ID)
	if err != nil {
		t.Fatal(err)
	}
	if codes := attentionCodes(machine.Attention); !slices.Equal(codes, []AttentionCode{AttentionConnectorOffline}) {
		t.Fatalf("silent connector = %v", codes)
	}
	if _, err = h.pool.Exec(
		ctx,
		`UPDATE printer_connectors SET last_heartbeat_at = $2 WHERE id = $1`,
		h.connectorID,
		h.now,
	); err != nil {
		t.Fatal(err)
	}
	if _, err = h.pool.Exec(
		ctx,
		`UPDATE printer_connector_assignments SET runtime_state = 'degraded', runtime_error_code = 'auth_failed' WHERE id = $1`,
		h.assignments[h.machine.ID],
	); err != nil {
		t.Fatal(err)
	}
	if _, err = h.pool.Exec(
		ctx,
		`INSERT INTO printer_error_occurrences (id, machine_id, assignment_id, source_family, original_code, first_observed_at, last_observed_at)
		 VALUES ($1, $2, $3, 'hms', '0300-0100-0001-0001', $4, $4)`,
		ids.New(),
		h.machine.ID,
		h.assignments[h.machine.ID],
		h.now,
	); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = h.pool.Exec(context.Background(), `DELETE FROM printer_error_occurrences WHERE machine_id = $1`, h.machine.ID)
	})
	if _, err = h.pool.Exec(ctx, `UPDATE machines SET status = 'maintenance' WHERE id = $1`, h.machine.ID); err != nil {
		t.Fatal(err)
	}
	h.insertRun(t, runSpec{machine: h.machine.ID, state: "finished", started: at(h.now, -2*time.Hour), ended: at(h.now, -time.Hour)})
	machines, _, err := h.s.ListMachines(ctx, h.p, "", nil, 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range machines {
		if m.ID != h.machine.ID {
			continue
		}
		want := []AttentionCode{AttentionConnectorError, AttentionPrinterErrorOpen, AttentionOutOfOrder, AttentionRunsUnassigned}
		if codes := attentionCodes(m.Attention); !slices.Equal(codes, want) {
			t.Fatalf("machine = %v, want %v", codes, want)
		}
		return
	}
	t.Fatal("machine not listed")
}
