package orders

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)


func (f *fixture) movementAt(t *testing.T, kind CashMovementKind, amount string, at time.Time) CashMovement {
	t.Helper()
	m, e := f.cashMove(f.p, kind, amount, CashReasonSafe, "", at)
	if e != nil {
		t.Fatal(e)
	}
	return m
}

func (f *fixture) editMovement(t *testing.T, m CashMovement, change CashMovementChange) CashMovement {
	t.Helper()
	change.ExpectedVersion = m.Version
	updated, e := f.s.UpdateCashMovement(t.Context(), f.p, m.ID, change, nil)
	if e != nil {
		t.Fatal(e)
	}
	return updated
}

func (f *fixture) editCount(t *testing.T, c CashCount, change CashCountChange) CashCount {
	t.Helper()
	change.ExpectedVersion = c.Version
	updated, e := f.s.UpdateCashCount(t.Context(), f.p, c.ID, change, nil)
	if e != nil {
		t.Fatal(e)
	}
	return updated
}

func (f *fixture) countByID(t *testing.T, id uuid.UUID) CashCount {
	t.Helper()
	page, e := f.s.ListCashCounts(t.Context(), f.p, nil, nil, 1, 100)
	if e != nil {
		t.Fatal(e)
	}
	for _, c := range page.Items {
		if c.ID == id {
			return c
		}
	}
	t.Fatalf("count %s not found", id)
	return CashCount{}
}

func (f *fixture) expected(t *testing.T) string {
	t.Helper()
	register, e := f.s.CashRegister(t.Context(), f.p, nil)
	if e != nil {
		t.Fatal(e)
	}
	return register.Expected
}

func (f *fixture) auditValue(t *testing.T, action string, resource uuid.UUID, key string) string {
	t.Helper()
	var value string
	if e := f.pool.QueryRow(
		t.Context(),
		"SELECT COALESCE(metadata->>$3,'') FROM audit_events WHERE action=$1 AND resource_id=$2 ORDER BY id LIMIT 1",
		action, resource, key,
	).Scan(&value); e != nil {
		t.Fatalf("audit %s %s: %v", action, key, e)
	}
	return value
}

func TestEditingAWithdrawalRecalculatesTheCountsAfterIt(t *testing.T) {
	f := newFixture(t)
	t0 := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	f.movementAt(t, CashDeposit, "100", t0)
	w := f.movementAt(t, CashWithdrawal, "30", t0.Add(time.Minute))
	k1 := f.count(t, countInputAt("60", t0.Add(2*time.Minute), CountReasonCountingError, ""))
	k2 := f.count(t, countInputAt("60", t0.Add(3*time.Minute), "", ""))
	if k1.Difference != "-10.00" || k1.Correction == nil || k2.Difference != "0.00" || w.Version != 1 {
		t.Fatalf("setup %+v %+v %+v", w, k1, k2)
	}

	// The withdrawal really was 40: the first count now matches, its reason and correction go.
	w = f.editMovement(t, w, CashMovementChange{Amount: new("40")})
	if w.Amount != "40.00" || w.Version != 2 || w.UpdatedAt.Before(w.CreatedAt) {
		t.Fatalf("edited %+v", w)
	}
	first := f.countByID(t, k1.ID)
	if first.ExpectedAmount != "60.00" || first.Difference != "0.00" || first.Reason != nil || first.Correction != nil ||
		first.Version != 2 {
		t.Fatalf("first count %+v", first)
	}
	if second := f.countByID(t, k2.ID); second.Version != 1 || second.ExpectedAmount != "60.00" {
		t.Fatalf("second count changed %+v", second)
	}
	if got := f.expected(t); got != "60.00" {
		t.Fatalf("expected %s", got)
	}
	if got := f.auditValue(t, "cash_movement.updated", w.ID, "previousAmount"); got != "30.00" {
		t.Fatalf("audit previousAmount %q", got)
	}
	_, e := f.s.UpdateCashMovement(t.Context(), f.p, w.ID, CashMovementChange{ExpectedVersion: 1, Note: new("x")}, nil)
	wantCode(t, e, "stale_write")

	// Too much: the matching count now differs, without a reason until someone edits it.
	w = f.editMovement(t, w, CashMovementChange{Amount: new("50")})
	first = f.countByID(t, k1.ID)
	if first.Difference != "10.00" || first.Reason != nil || first.Correction == nil {
		t.Fatalf("first count after 50 %+v", first)
	}

	// Moved after the first count: both counts follow, the register still holds what was counted last.
	w = f.editMovement(t, w, CashMovementChange{OccurredAt: new(t0.Add(150 * time.Second))})
	first, second := f.countByID(t, k1.ID), f.countByID(t, k2.ID)
	if first.ExpectedAmount != "100.00" || first.Difference != "-40.00" || second.ExpectedAmount != "10.00" ||
		second.Difference != "50.00" || second.Correction == nil || f.expected(t) != "60.00" {
		t.Fatalf("after moving %+v %+v", first, second)
	}

	if e = f.s.DeleteCashMovement(t.Context(), f.p, w.ID, CashEntryDeletion{ExpectedVersion: w.Version - 1}, nil); e == nil {
		t.Fatal("stale delete accepted")
	}
	wantCode(t, e, "stale_write")
	if e = f.s.DeleteCashMovement(t.Context(), f.p, w.ID, CashEntryDeletion{ExpectedVersion: w.Version}, nil); e != nil {
		t.Fatal(e)
	}
	second = f.countByID(t, k2.ID)
	if second.ExpectedAmount != "60.00" || second.Difference != "0.00" || second.Correction != nil ||
		f.expected(t) != "60.00" {
		t.Fatalf("after deleting %+v", second)
	}
	if got := f.auditValue(t, "cash_movement.deleted", w.ID, "reference"); got != w.Reference {
		t.Fatalf("audit reference %q", got)
	}
	var left int
	if e = f.pool.QueryRow(t.Context(), "SELECT count(*) FROM cash_movements WHERE id=$1", w.ID).Scan(&left); e != nil ||
		left != 0 {
		t.Fatalf("not deleted %v %d", e, left)
	}
	var recalculated int
	if e = f.pool.QueryRow(t.Context(), "SELECT count(*) FROM audit_events WHERE action='cash_count.recalculated'").
		Scan(&recalculated); e != nil || recalculated < 4 {
		t.Fatalf("recalculations %v %d", e, recalculated)
	}
}

func TestCashMovementEditRules(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	t0 := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	deposit := f.movementAt(t, CashDeposit, "100", t0)
	w1 := f.movementAt(t, CashWithdrawal, "30", t0.Add(time.Minute))
	w2 := f.movementAt(t, CashWithdrawal, "60", t0.Add(2*time.Minute))

	refuse := func(id uuid.UUID, change CashMovementChange, code string) {
		t.Helper()
		_, e := f.s.UpdateCashMovement(ctx, f.p, id, change, nil)
		wantCode(t, e, code)
	}
	// The register cannot hold less than nothing at any later moment.
	refuse(w1.ID, CashMovementChange{ExpectedVersion: 1, Amount: new("50")}, "cash_balance_negative")
	refuse(w1.ID, CashMovementChange{ExpectedVersion: 1, OccurredAt: new(t0.Add(-time.Minute))}, "cash_balance_negative")
	refuse(deposit.ID, CashMovementChange{ExpectedVersion: 1, Amount: new("89.99")}, "cash_balance_negative")
	wantCode(t, f.s.DeleteCashMovement(ctx, f.p, deposit.ID, CashEntryDeletion{ExpectedVersion: 1}, nil),
		"cash_balance_negative")
	refuse(w2.ID, CashMovementChange{ExpectedVersion: 1, Reason: new(CashReasonOther)}, "validation_failed")
	refuse(w2.ID, CashMovementChange{ExpectedVersion: 1, Reason: new(CashReasonCountDifference)}, "validation_failed")
	refuse(w2.ID, CashMovementChange{ExpectedVersion: 1, Amount: new("0")}, "validation_failed")
	refuse(w2.ID, CashMovementChange{ExpectedVersion: 1, OccurredAt: new(time.Now().Add(time.Hour))}, "validation_failed")
	refuse(w2.ID, CashMovementChange{Note: new("x")}, "validation_failed")
	refuse(ids.New(), CashMovementChange{ExpectedVersion: 1, Note: new("x")}, "not_found")

	// Nothing changed keeps the version; a note alone is an edit.
	same := f.editMovement(t, w2, CashMovementChange{Amount: new("60.00")})
	if same.Version != 1 {
		t.Fatalf("unchanged edit bumped the version %+v", same)
	}
	w2 = f.editMovement(t, w2, CashMovementChange{Reason: new(CashReasonOther), Note: new(" to the bank ")})
	if w2.Version != 2 || w2.Note != "to the bank" || w2.Reason != CashReasonOther || w2.Kind != CashWithdrawal {
		t.Fatalf("note edit %+v", w2)
	}

	// A correction belongs to its count.
	count := f.count(t, countInputAt("5", t0.Add(3*time.Minute), CountReasonCountingError, ""))
	if count.Correction == nil {
		t.Fatalf("count %+v", count)
	}
	refuse(count.Correction.ID, CashMovementChange{ExpectedVersion: 1, Note: new("x")}, "cash_movement_is_correction")
	wantCode(t, f.s.DeleteCashMovement(ctx, f.p, count.Correction.ID, CashEntryDeletion{ExpectedVersion: 1}, nil),
		"cash_movement_is_correction")

	// The database keeps a record's identity whatever the service does.
	for _, sql := range []string{
		"UPDATE cash_movements SET reference='C-2000-000001' WHERE kind='withdrawal'",
		"UPDATE cash_movements SET kind='deposit' WHERE kind='withdrawal'",
		"UPDATE cash_counts SET created_at=now()-interval '1 day'",
	} {
		if _, e := f.pool.Exec(ctx, sql); e == nil {
			t.Fatalf("allowed %s", sql)
		}
	}
}

func TestEditingAndDeletingACount(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	t0 := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	f.movementAt(t, CashDeposit, "100", t0)
	k1 := f.count(t, countInputAt("100", t0.Add(time.Minute), "", ""))
	f.movementAt(t, CashWithdrawal, "20", t0.Add(2*time.Minute))
	k2 := f.count(t, countInputAt("75", t0.Add(3*time.Minute), CountReasonUnknown, "missing"))
	if k1.Version != 1 || k2.Difference != "-5.00" {
		t.Fatalf("setup %+v %+v", k1, k2)
	}

	k1 = f.editCount(t, k1, CashCountChange{CountedAmount: new("98"), Reason: new(CountReasonCountingError)})
	if k1.ExpectedAmount != "100.00" || k1.Difference != "-2.00" || k1.Correction == nil || k1.Version != 2 ||
		k1.Reason == nil || *k1.Reason != CountReasonCountingError {
		t.Fatalf("edited first %+v", k1)
	}
	second := f.countByID(t, k2.ID)
	if second.ExpectedAmount != "78.00" || second.Difference != "-3.00" || second.Reason == nil ||
		*second.Reason != CountReasonUnknown || second.Correction == nil || second.Version != 2 {
		t.Fatalf("recalculated second %+v", second)
	}
	if got := f.auditValue(t, "cash_count.updated", k1.ID, "previousCountedAmount"); got != "100.00" {
		t.Fatalf("audit %q", got)
	}

	// Counts keep their order.
	for _, at := range []time.Time{t0.Add(3 * time.Minute), t0.Add(4 * time.Minute)} {
		_, e := f.s.UpdateCashCount(ctx, f.p, k1.ID, CashCountChange{ExpectedVersion: k1.Version, CountedAt: &at}, nil)
		wantCode(t, e, "cash_count_out_of_order")
	}
	k1 = f.editCount(t, k1, CashCountChange{CountedAt: new(t0.Add(30 * time.Second))})
	if !k1.CountedAt.Equal(t0.Add(30*time.Second)) || k1.Difference != "-2.00" || k1.Version != 3 {
		t.Fatalf("moved first %+v", k1)
	}
	corrections, e := f.s.ListCashMovements(ctx, f.p, "correction", nil, nil, 1, 25)
	if e != nil {
		t.Fatal(e)
	}
	for _, c := range corrections.Items {
		if c.CashCountID != nil && *c.CashCountID == k1.ID && !c.OccurredAt.Equal(k1.CountedAt) {
			t.Fatalf("correction stayed behind %+v", c)
		}
	}

	// A matching count keeps no reason and books nothing.
	second = f.editCount(t, second, CashCountChange{CountedAmount: new("78")})
	if second.Difference != "0.00" || second.Reason != nil || second.Correction != nil {
		t.Fatalf("matching second %+v", second)
	}
	_, e = f.s.UpdateCashCount(ctx, f.p, second.ID,
		CashCountChange{ExpectedVersion: second.Version, CountedAmount: new("70")}, nil)
	wantCode(t, e, "cash_count_reason_required")
	_, e = f.s.UpdateCashCount(ctx, f.p, second.ID, CashCountChange{
		ExpectedVersion: second.Version,
		CountedAmount:   new("70"),
		Reason:          new(CountReasonOther),
		Note:            new(" "),
	}, nil)
	wantCode(t, e, "validation_failed")
	_, e = f.s.UpdateCashCount(ctx, f.p, second.ID, CashCountChange{
		ExpectedVersion: second.Version,
		CountedAmount:   new("70"),
		Reason:          new(CountReasonCountingError),
		ExpectedAmount:  new("99"),
	}, nil)
	wantCode(t, e, "cash_expected_changed")
	_, e = f.s.UpdateCashCount(ctx, f.p, second.ID, CashCountChange{ExpectedVersion: 1, Note: new("x")}, nil)
	wantCode(t, e, "stale_write")

	// Deleting the first count removes its correction; the second absorbs what the first had found.
	wantCode(t, f.s.DeleteCashCount(ctx, f.p, k1.ID, CashEntryDeletion{ExpectedVersion: 1}, nil), "stale_write")
	if e = f.s.DeleteCashCount(ctx, f.p, k1.ID, CashEntryDeletion{ExpectedVersion: k1.Version}, nil); e != nil {
		t.Fatal(e)
	}
	second = f.countByID(t, k2.ID)
	if second.ExpectedAmount != "80.00" || second.Difference != "-2.00" || second.Reason != nil ||
		second.Correction == nil || f.expected(t) != "78.00" {
		t.Fatalf("after deleting the first %+v", second)
	}
	if got := f.auditValue(t, "cash_count.deleted", k1.ID, "reference"); got != k1.Reference {
		t.Fatalf("audit %q", got)
	}
	if e = f.s.DeleteCashCount(ctx, f.p, second.ID, CashEntryDeletion{ExpectedVersion: second.Version}, nil); e != nil {
		t.Fatal(e)
	}
	var left int
	if e = f.pool.QueryRow(ctx, "SELECT (SELECT count(*) FROM cash_counts)+(SELECT count(*) FROM cash_movements WHERE kind='correction')").
		Scan(&left); e != nil || left != 0 || f.expected(t) != "80.00" {
		t.Fatalf("left %v %d", e, left)
	}
	wantCode(t, f.s.DeleteCashCount(ctx, f.p, second.ID, CashEntryDeletion{ExpectedVersion: 1}, nil), "not_found")
}

func TestEditingCashEntriesNeedsCashMovementsManage(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	t0 := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	m := f.movementAt(t, CashDeposit, "10", t0)
	c := f.count(t, countInputAt("10", t0.Add(time.Minute), "", ""))
	recorder := f.principal(t, authorization.PaymentsRead, authorization.CashMovementsRead, authorization.CashMovementsRecord)
	movementManager := f.principal(t, authorization.CashMovementsRead, authorization.CashMovementsManage)
	manager := f.principal(t, authorization.PaymentsRead, authorization.CashMovementsRead, authorization.CashMovementsManage)
	note := CashMovementChange{ExpectedVersion: 1, Note: new("float")}
	countNote := CashCountChange{ExpectedVersion: 1, Note: new("checked twice")}

	_, e := f.s.UpdateCashMovement(ctx, recorder, m.ID, note, nil)
	denied(t, e)
	denied(t, f.s.DeleteCashMovement(ctx, recorder, m.ID, CashEntryDeletion{ExpectedVersion: 1}, nil))
	_, e = f.s.UpdateCashCount(ctx, recorder, c.ID, countNote, nil)
	denied(t, e)
	denied(t, f.s.DeleteCashCount(ctx, recorder, c.ID, CashEntryDeletion{ExpectedVersion: 1}, nil))
	// Counts show expected amounts derived from payments, so they also need payments.read.
	_, e = f.s.UpdateCashCount(ctx, movementManager, c.ID, countNote, nil)
	denied(t, e)
	denied(t, f.s.DeleteCashCount(ctx, movementManager, c.ID, CashEntryDeletion{ExpectedVersion: 1}, nil))

	if m, e = f.s.UpdateCashMovement(ctx, movementManager, m.ID, note, nil); e != nil || m.Note != "float" {
		t.Fatalf("%v %+v", e, m)
	}
	if c, e = f.s.UpdateCashCount(ctx, manager, c.ID, countNote, nil); e != nil || c.Note != "checked twice" {
		t.Fatalf("%v %+v", e, c)
	}
	if e = f.s.DeleteCashCount(ctx, manager, c.ID, CashEntryDeletion{ExpectedVersion: c.Version}, nil); e != nil {
		t.Fatal(e)
	}
	if e = f.s.DeleteCashMovement(ctx, manager, m.ID, CashEntryDeletion{ExpectedVersion: m.Version}, nil); e != nil {
		t.Fatal(e)
	}
}
