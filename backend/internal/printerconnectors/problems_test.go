package printerconnectors

import (
	"context"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// problemRecorder records the connector problems raised and cleared for one machine.
type problemRecorder struct {
	*notifyrules.SystemEvents
	machineID uuid.UUID
	mu        sync.Mutex
	events    []string
}

func (r *problemRecorder) PrinterConnectorProblem(
	_ context.Context, _ pgx.Tx, machineID uuid.UUID, problem, code, message string,
) error {
	if machineID == r.machineID {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.events = append(r.events, "raised "+problem+" "+code)
		if message == "" {
			r.events = append(r.events, "without message")
		}
	}
	return nil
}

func (r *problemRecorder) PrinterConnectorProblemCleared(_ context.Context, _ pgx.Tx, machineID uuid.UUID, problem string) error {
	if machineID == r.machineID {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.events = append(r.events, "cleared "+problem)
	}
	return nil
}

func (r *problemRecorder) take() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	events := r.events
	r.events = nil
	return events
}

func TestConnectorProblemsAreNotifiedOnceTheyLastAndResolvedWhenTheyClear(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	recorder := &problemRecorder{SystemEvents: notifyrules.NewSystemEvents(nil), machineID: h.machine.ID}
	h.service.emitter = recorder
	start := time.Now().UTC().Truncate(time.Second)
	report := func(at time.Time, state string, code *string) {
		t.Helper()
		if _, err := h.pool.Exec(ctx, `UPDATE printer_connectors SET last_heartbeat_at = $2 WHERE id = $1`, h.connector.ID, at); err != nil {
			t.Fatal(err)
		}
		if _, err := h.pool.Exec(
			ctx,
			`UPDATE printer_connector_assignments SET runtime_state = $2, runtime_error_code = $3 WHERE id = $1`,
			h.assignment.ID, state, code,
		); err != nil {
			t.Fatal(err)
		}
	}
	watch := func(at time.Time) []string {
		t.Helper()
		if _, _, err := h.service.WatchProblems(ctx, at); err != nil {
			t.Fatal(err)
		}
		return recorder.take()
	}
	timeout := "ftps_timeout"

	report(start, "degraded", &timeout)
	if events := watch(start); len(events) != 0 {
		t.Fatalf("a fresh problem was notified at once: %v", events)
	}
	report(start.Add(time.Minute), "degraded", &timeout)
	if events := watch(start.Add(time.Minute)); len(events) != 0 {
		t.Fatalf("a problem shorter than two minutes was notified: %v", events)
	}
	report(start.Add(2*time.Minute), "degraded", &timeout)
	if events := watch(start.Add(2 * time.Minute)); !slices.Equal(events, []string{"raised storage ftps_timeout"}) {
		t.Fatalf("lasting storage problem = %v", events)
	}
	report(start.Add(5*time.Minute), "degraded", &timeout)
	if events := watch(start.Add(5 * time.Minute)); len(events) != 0 {
		t.Fatalf("the same problem was notified twice: %v", events)
	}
	report(start.Add(6*time.Minute), "connected", nil)
	if events := watch(start.Add(6 * time.Minute)); !slices.Equal(events, []string{"cleared storage"}) {
		t.Fatalf("cleared problem = %v", events)
	}
	var kind *string
	if err := h.pool.QueryRow(ctx, `SELECT problem_kind FROM printer_connector_assignments WHERE id = $1`, h.assignment.ID).Scan(&kind); err != nil {
		t.Fatal(err)
	}
	if kind != nil {
		t.Fatalf("problem kept after it cleared: %s", *kind)
	}

	// A silent connector is offline; a short problem that clears again stays quiet.
	report(start.Add(7*time.Minute), "connected", nil)
	if events := watch(start.Add(9 * time.Minute)); len(events) != 0 {
		t.Fatalf("offline was notified at once: %v", events)
	}
	if events := watch(start.Add(10 * time.Minute)); len(events) != 0 {
		t.Fatalf("offline was notified before two minutes: %v", events)
	}
	report(start.Add(10*time.Minute), "connected", nil)
	if events := watch(start.Add(10 * time.Minute)); len(events) != 0 {
		t.Fatalf("a problem that never was notified was cleared: %v", events)
	}
	if events := watch(start.Add(12*time.Minute + time.Second)); len(events) != 0 {
		// The heartbeat is 2 minutes old by now: offline again, but freshly.
		t.Fatalf("offline was notified before it lasted: %v", events)
	}
}

func TestEndedAssignmentResolvesItsNotifiedProblem(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	recorder := &problemRecorder{SystemEvents: notifyrules.NewSystemEvents(nil), machineID: h.machine.ID}
	h.service.emitter = recorder
	now := time.Now().UTC()
	if _, err := h.pool.Exec(
		ctx,
		`UPDATE printer_connector_assignments SET problem_kind = 'offline', problem_since = $2, problem_notified_at = $2,
		 enabled = false WHERE id = $1`,
		h.assignment.ID, now.Add(-time.Hour),
	); err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.service.WatchProblems(ctx, now); err != nil {
		t.Fatal(err)
	}
	if events := recorder.take(); !slices.Equal(events, []string{"cleared offline"}) {
		t.Fatalf("disabled assignment = %v", events)
	}
}
