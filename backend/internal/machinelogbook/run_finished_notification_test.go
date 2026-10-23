package machinelogbook

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

// TestCancelManualRunNotifiesTheOperatorUnlessTheyCancelledIt covers the run_finished notification:
// the operator of the run's job is told in the cancelling transaction, except when they cancelled it.
func TestCancelManualRunNotifiesTheOperatorUnlessTheyCancelledIt(t *testing.T) {
	f := newLiveJobFixture(t)
	ctx := t.Context()
	operatorPerson, operatorAccount := ids.New(), ids.New()
	suffix := strings.ReplaceAll(operatorPerson.String(), "-", "")[:12]
	if _, err := f.pool.Exec(
		ctx, `INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Run', 'Operator', $2)`,
		operatorPerson, "run-operator-"+suffix+"@example.test",
	); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(
		ctx, `INSERT INTO accounts (id, person_id, status) VALUES ($1, $2, 'enabled')`, operatorAccount, operatorPerson,
	); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = f.pool.Exec(
			cleanup, `DELETE FROM inbox_notifications WHERE id IN (
				SELECT notification_id FROM inbox_recipients WHERE account_id = ANY($1::text[]::uuid[]))`,
			[]string{operatorAccount.String(), f.p.AccountID.String()},
		)
		_, _ = f.pool.Exec(cleanup, `DELETE FROM people WHERE id = $1`, operatorPerson)
	})
	notified := func(account uuid.UUID) int {
		t.Helper()
		var count int
		if err := f.pool.QueryRow(
			ctx, `SELECT count(*) FROM inbox_recipients r JOIN inbox_notifications n ON n.id = r.notification_id
				WHERE r.account_id = $1 AND n.kind = 'run_finished'`, account,
		).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}

	input := f.input(-time.Hour, 4*time.Hour, "unknown")
	input.OperatorPersonID = operatorPerson
	job := f.create(t, input)
	if _, err := f.s.CancelRun(ctx, f.p, job.Runs[0].ID, job.Runs[0].Version, &f.request); err != nil {
		t.Fatal(err)
	}
	if got := notified(operatorAccount); got != 1 {
		t.Fatalf("operator notifications = %d, want 1", got)
	}
	if got := notified(f.p.AccountID); got != 0 {
		t.Fatalf("canceller notifications = %d, want 0", got)
	}

	// The operator cancelling their own run, or a job without an operator, notifies nobody.
	own := f.create(t, f.input(-time.Hour, 4*time.Hour, "unknown"))
	if _, err := f.s.CancelRun(ctx, f.p, own.Runs[0].ID, own.Runs[0].Version, &f.request); err != nil {
		t.Fatal(err)
	}
	if got := notified(f.p.AccountID); got != 0 {
		t.Fatalf("self-cancelled run notified its operator: %d", got)
	}
}
