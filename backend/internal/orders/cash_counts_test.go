package orders

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
)

func countInputAt(amount string, at time.Time, reason CashCountReason, note string) CashCountInput {
	in := CashCountInput{OperationKey: ids.New(), CountedAmount: amount, CountedAt: at, Note: note}
	if reason != "" {
		in.Reason = &reason
	}
	return in
}

func (f *fixture) count(t *testing.T, in CashCountInput) CashCount {
	t.Helper()
	c, e := f.s.RecordCashCount(t.Context(), f.p, in, nil)
	if e != nil {
		t.Fatal(e)
	}
	return c
}

func TestCashCountBooksTheDifferenceAsACorrection(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	o := f.finalized(t, "40")
	f.pay(t, o, "cash", "40")
	start := time.Now().UTC().Add(time.Second)

	matching := f.count(t, countInputAt("40", start, CountReasonCountingError, ""))
	if matching.ExpectedAmount != "40.00" || matching.Difference != "0.00" || matching.Reason != nil ||
		matching.Correction != nil || matching.RecordedBy == nil || len(matching.Reference) != len("K-2026-0001") {
		t.Fatalf("matching count %+v", matching)
	}

	short := f.count(t, countInputAt("37.50", start.Add(time.Second), CountReasonCountingError, "coins"))
	if short.ExpectedAmount != "40.00" || short.Difference != "-2.50" || short.Correction == nil ||
		short.Reason == nil || *short.Reason != CountReasonCountingError || short.Note != "coins" {
		t.Fatalf("short count %+v", short)
	}
	over := f.count(t, countInputAt("38", start.Add(2*time.Second), CountReasonChangeGivenWrong, ""))
	if over.ExpectedAmount != "37.50" || over.Difference != "0.50" || over.Correction == nil {
		t.Fatalf("over count %+v", over)
	}

	register, e := f.s.CashRegister(ctx, f.p, nil)
	if e != nil || register.Expected != "38.00" || register.Corrections != "2.00" ||
		register.RefundsAndCorrections != "2.00" || register.LastCount == nil || register.LastCount.ID != over.ID {
		t.Fatalf("%v %+v", e, register)
	}
	before := start.Add(1500 * time.Millisecond)
	bounded, e := f.s.CashRegister(ctx, f.p, &before)
	if e != nil || bounded.LastCount == nil || bounded.LastCount.ID != short.ID || bounded.Expected != "37.50" {
		t.Fatalf("bounded %v %+v", e, bounded)
	}

	corrections, e := f.s.ListCashMovements(ctx, f.p, "correction", nil, nil, 1, 25)
	if e != nil || corrections.Total != 2 {
		t.Fatalf("%v %+v", e, corrections)
	}
	newest, oldest := corrections.Items[0], corrections.Items[1]
	if newest.Direction != CashIn || newest.Amount != "0.50" || newest.CashCountReference == nil ||
		*newest.CashCountReference != over.Reference || newest.Reason != CashReasonCountDifference ||
		!newest.OccurredAt.Equal(over.CountedAt) {
		t.Fatalf("surplus correction %+v", newest)
	}
	if oldest.Direction != CashOut || oldest.Amount != "2.50" || oldest.CashCountID == nil ||
		*oldest.CashCountID != short.ID || short.Correction.ID != oldest.ID {
		t.Fatalf("shortfall correction %+v", oldest)
	}

	page, e := f.s.ListCashCounts(ctx, f.p, nil, nil, 1, 2)
	if e != nil || page.Total != 3 || len(page.Items) != 2 || page.Items[0].ID != over.ID || page.Items[1].ID != short.ID {
		t.Fatalf("%v %+v", e, page)
	}

	var audits int
	if e = f.pool.QueryRow(
		ctx,
		"SELECT count(*) FROM audit_events WHERE action IN ('cash_count.recorded','cash_movement.recorded')",
	).Scan(&audits); e != nil || audits != 5 {
		t.Fatalf("audit events %v %d", e, audits)
	}
	// Counts are immutable, like the movements they book.
	for _, sql := range []string{"UPDATE cash_counts SET note='x'", "UPDATE cash_counts SET counted_amount=1"} {
		if _, e = f.pool.Exec(ctx, sql); e == nil {
			t.Fatalf("allowed %s", sql)
		}
	}
	// A withdrawal is limited by the corrected expectation.
	_, e = f.cashMove(f.p, "withdrawal", "38.01", "safe", "", time.Now().UTC().Add(5*time.Second))
	wantCode(t, e, "insufficient_cash")
}

func TestCashCountRules(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	o := f.finalized(t, "20")
	f.pay(t, o, "cash", "20")
	now := time.Now().UTC()

	_, e := f.s.RecordCashCount(ctx, f.p, countInputAt("19", now, "", ""), nil)
	wantCode(t, e, "cash_count_reason_required")
	_, e = f.s.RecordCashCount(ctx, f.p, countInputAt("19", now, CountReasonUnknown, " "), nil)
	wantCode(t, e, "validation_failed")
	_, e = f.s.RecordCashCount(ctx, f.p, countInputAt("19", now, "bogus", ""), nil)
	wantCode(t, e, "validation_failed")
	_, e = f.s.RecordCashCount(ctx, f.p, countInputAt("-1", now, "", ""), nil)
	wantCode(t, e, "validation_failed")
	_, e = f.s.RecordCashCount(ctx, f.p, countInputAt("20", now.Add(time.Hour), "", ""), nil)
	wantCode(t, e, "validation_failed")
	stale := countInputAt("20", now, "", "")
	seen := "25.00"
	stale.ExpectedAmount = &seen
	_, e = f.s.RecordCashCount(ctx, f.p, stale, nil)
	wantCode(t, e, "cash_expected_changed")

	in := countInputAt("19", now, CountReasonOther, "a coin rolled away")
	shown := "20"
	in.ExpectedAmount = &shown
	first, e := f.s.RecordCashCount(ctx, f.p, in, nil)
	if e != nil {
		t.Fatal(e)
	}
	again, e := f.s.RecordCashCount(ctx, f.p, in, nil)
	if e != nil || again.ID != first.ID || again.Correction == nil || again.Correction.ID != first.Correction.ID {
		t.Fatalf("retry %v %+v", e, again)
	}
	in.CountedAmount = "18"
	_, e = f.s.RecordCashCount(ctx, f.p, in, nil)
	wantCode(t, e, "idempotency_conflict")
	var movements int
	if e = f.pool.QueryRow(ctx, "SELECT count(*) FROM cash_movements").Scan(&movements); e != nil || movements != 1 {
		t.Fatalf("movements %v %d", e, movements)
	}

	// Counts follow each other in time.
	_, e = f.s.RecordCashCount(ctx, f.p, countInputAt("19", now, "", ""), nil)
	wantCode(t, e, "cash_count_out_of_order")
	_, e = f.s.RecordCashCount(ctx, f.p, countInputAt("19", now.Add(-time.Hour), "", ""), nil)
	wantCode(t, e, "cash_count_out_of_order")

	// A count that found less than later withdrawals took is refused.
	later := now.Add(2 * time.Second)
	if _, e = f.cashMove(f.p, "withdrawal", "19", "bank_deposit", "", later); e != nil {
		t.Fatal(e)
	}
	_, e = f.s.RecordCashCount(ctx, f.p, countInputAt("5", now.Add(time.Second), CountReasonCountingError, ""), nil)
	wantCode(t, e, "cash_count_inconsistent")
}

func TestCashCountPermissions(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	now := time.Now().UTC()
	reader := f.principal(t, authorization.PaymentsRead, authorization.CashMovementsRead)
	movementsOnly := f.principal(t, authorization.CashMovementsRead, authorization.CashMovementsRecord)
	counter := f.principal(
		t,
		authorization.PaymentsRead,
		authorization.CashMovementsRead,
		authorization.CashMovementsRecord,
	)
	_, e := f.s.RecordCashCount(ctx, reader, countInputAt("0", now, "", ""), nil)
	denied(t, e)
	_, e = f.s.RecordCashCount(ctx, movementsOnly, countInputAt("0", now, "", ""), nil)
	denied(t, e)
	if _, e = f.s.RecordCashCount(ctx, counter, countInputAt("0", now, "", ""), nil); e != nil {
		t.Fatal(e)
	}
	if _, e = f.s.ListCashCounts(ctx, reader, nil, nil, 1, 25); e != nil {
		t.Fatal(e)
	}
	_, e = f.s.ListCashCounts(ctx, f.principal(t, authorization.CashMovementsRead), nil, nil, 1, 25)
	denied(t, e)
	_, e = f.s.ListCashCounts(ctx, f.principal(t, authorization.PaymentsRead), nil, nil, 1, 25)
	denied(t, e)
}
