package orders

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
)

// journalFixture records a register history over two days in Vienna:
// 30 Oct 09:00 receipt 40, 10:00 deposit 10; 31 Oct 00:30 withdrawal 5, 12:00 count 44 of 45 (correction -1),
// 14:00 receipt 20, 15:00 refund 20.
func journalFixture(t *testing.T) (*fixture, *time.Location) {
	t.Helper()
	f := newFixture(t)
	vienna, err := time.LoadLocation("Europe/Vienna")
	if err != nil {
		t.Fatal(err)
	}
	f.s.WithLocation(vienna)
	at := func(day, hour, minute int) time.Time { return time.Date(2026, 10, day, hour, minute, 0, 0, vienna) }
	payAt := func(o Order, amount string, when time.Time) Order {
		t.Helper()
		in := receipt("cash", amount)
		in.OccurredAt = when
		o, e := f.s.RecordPayment(
			t.Context(),
			f.p,
			o.ID,
			RecordOrderPayment{OperationKey: ids.New(), ExpectedVersion: o.Version, Payment: in},
			nil,
		)
		if e != nil {
			t.Fatal(e)
		}
		return o
	}
	payAt(f.finalized(t, "40"), "40", at(30, 9, 0))
	if _, e := f.cashMove(f.p, "deposit", "10", "float", "", at(30, 10, 0)); e != nil {
		t.Fatal(e)
	}
	if _, e := f.cashMove(f.p, "withdrawal", "5", "bank_deposit", "", at(31, 0, 30)); e != nil {
		t.Fatal(e)
	}
	f.count(t, countInputAt("44", at(31, 12, 0), CountReasonCountingError, ""))
	second := payAt(f.finalized(t, "20"), "20", at(31, 14, 0))
	paymentID := *second.Allocations[0].PaymentID
	if _, e := f.s.ReversePayment(t.Context(), f.p, paymentID, ReversePaymentCommand{
		OperationKey:    ids.New(),
		ExpectedVersion: second.Version,
		Reversal: PaymentReversalInput{
			PaymentID:  paymentID,
			ReasonKind: "refund",
			Reason:     "returned",
			OccurredAt: at(31, 15, 0),
		},
	}, nil); e != nil {
		t.Fatal(e)
	}
	return f, vienna
}

func day(y int, m time.Month, d int) *time.Time {
	v := time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
	return &v
}

func TestCashJournalRunningBalancesDaysAndFacts(t *testing.T) {
	f, _ := journalFixture(t)
	ctx := t.Context()

	all, e := f.s.CashJournal(ctx, f.p, CashJournalQuery{Page: 1, Size: 25})
	if e != nil {
		t.Fatal(e)
	}
	wantKinds := []CashJournalKind{"receipt", "deposit", "withdrawal", "count", "correction", "receipt", "refund"}
	wantBalances := []string{"40.00", "50.00", "45.00", "45.00", "44.00", "64.00", "44.00"}
	if all.Total != 7 || len(all.Items) != 7 {
		t.Fatalf("journal %+v", all)
	}
	for i, item := range all.Items {
		if item.Kind != wantKinds[i] || item.BalanceAfter != wantBalances[i] {
			t.Fatalf("entry %d = %s %s, want %s %s", i, item.Kind, item.BalanceAfter, wantKinds[i], wantBalances[i])
		}
	}
	// The withdrawal at 00:30 in Vienna is on 31 October although it is 30 October in UTC.
	if all.Items[2].Day != "2026-10-31" || all.Items[1].Day != "2026-10-30" {
		t.Fatalf("days %s %s", all.Items[1].Day, all.Items[2].Day)
	}
	receipt, count, correction, refund := all.Items[0], all.Items[3], all.Items[4], all.Items[6]
	if receipt.AmountIn == nil || *receipt.AmountIn != "40.00" || receipt.Order == nil ||
		receipt.Order.CustomerName == nil || *receipt.Order.CustomerName != "Example institute" || receipt.RecordedBy == nil {
		t.Fatalf("receipt %+v", receipt)
	}
	if count.AmountIn != nil || count.AmountOut != nil || count.Count == nil || count.Count.ExpectedAmount != "45.00" ||
		count.Count.Difference != "-1.00" || count.Count.Reason == nil {
		t.Fatalf("count %+v", count)
	}
	if correction.AmountOut == nil || *correction.AmountOut != "1.00" || correction.Count == nil ||
		correction.Count.ID != count.ID || correction.MovementReason == nil {
		t.Fatalf("correction %+v", correction)
	}
	if refund.PaymentReason != "returned" || refund.ReversedPaymentReference == nil || refund.AmountOut == nil {
		t.Fatalf("refund %+v", refund)
	}
	if len(all.Days) != 2 || all.Days[0].Date != "2026-10-30" || all.Days[0].OpeningBalance != "0.00" ||
		all.Days[0].ClosingBalance != "50.00" || all.Days[1].OpeningBalance != "50.00" ||
		all.Days[1].ClosingBalance != "44.00" || all.Days[1].CashIn != "20.00" || all.Days[1].CashOut != "26.00" {
		t.Fatalf("days %+v", all.Days)
	}

	one, e := f.s.CashJournal(ctx, f.p, CashJournalQuery{
		From: day(2026, 10, 31), To: day(2026, 10, 31), Page: 1, Size: 25,
	})
	if e != nil || one.Total != 5 || one.OpeningBalance != "50.00" || *one.From != "2026-10-31" {
		t.Fatalf("%v %+v", e, one)
	}
	r := one.Register
	if r.Receipts != "60.00" || r.Refunds != "20.00" || r.Corrections != "1.00" || r.RefundsAndCorrections != "21.00" ||
		r.Withdrawals != "5.00" || r.Deposits != "10.00" || r.Expected != "44.00" || r.LastCount == nil {
		t.Fatalf("register %+v", r)
	}
	facts := one.Facts
	if facts.CashIn != "20.00" || facts.CashInEntries != 1 || facts.Receipts != 1 || facts.CashOut != "26.00" ||
		facts.CashOutEntries != 3 || facts.Refunds != 1 || facts.Corrections != 1 || facts.Withdrawals != 1 ||
		facts.Net != "-6.00" || facts.Counts != 1 {
		t.Fatalf("facts %+v", facts)
	}
	first, e := f.s.CashJournal(ctx, f.p, CashJournalQuery{
		From: day(2026, 10, 30), To: day(2026, 10, 30), Page: 1, Size: 25,
	})
	if e != nil || first.Total != 2 || first.Register.Expected != "50.00" || first.Register.LastCount != nil {
		t.Fatalf("%v %+v", e, first)
	}

	counts, e := f.s.CashJournal(ctx, f.p, CashJournalQuery{Kinds: []CashJournalKind{"count"}, Page: 1, Size: 25})
	if e != nil || counts.Total != 1 || counts.Items[0].BalanceAfter != "45.00" {
		t.Fatalf("%v %+v", e, counts)
	}
	newest, e := f.s.CashJournal(ctx, f.p, CashJournalQuery{NewestFirst: true, Page: 1, Size: 2})
	if e != nil || newest.Total != 7 || newest.Items[0].Kind != "refund" || newest.Items[1].Kind != "receipt" ||
		len(newest.Days) != 1 {
		t.Fatalf("%v %+v", e, newest)
	}
	beyond, e := f.s.CashJournal(ctx, f.p, CashJournalQuery{Page: 9, Size: 2})
	if e != nil || beyond.Total != 7 || len(beyond.Items) != 0 {
		t.Fatalf("%v %+v", e, beyond)
	}
	found, e := f.s.CashJournal(ctx, f.p, CashJournalQuery{Search: "example inst", Page: 1, Size: 25})
	if e != nil || found.Total != 3 {
		t.Fatalf("customer search %v %+v", e, found)
	}

	_, e = f.s.CashJournal(ctx, f.p, CashJournalQuery{From: day(2026, 11, 2), To: day(2026, 11, 1), Page: 1, Size: 25})
	wantCode(t, e, "validation_failed")
	_, e = f.s.CashJournal(ctx, f.p, CashJournalQuery{Kinds: []CashJournalKind{"bogus"}, Page: 1, Size: 25})
	wantCode(t, e, "validation_failed")
}

func TestCashJournalPermissionsAndCustomerNames(t *testing.T) {
	f, _ := journalFixture(t)
	ctx := t.Context()
	query := CashJournalQuery{Page: 1, Size: 25}
	_, e := f.s.CashJournal(ctx, f.principal(t, authorization.PaymentsRead), query)
	denied(t, e)
	_, e = f.s.CashJournal(ctx, f.principal(t, authorization.CashMovementsRead), query)
	denied(t, e)
	cashier := f.principal(t, authorization.PaymentsRead, authorization.CashMovementsRead)
	journal, e := f.s.CashJournal(ctx, cashier, query)
	if e != nil || journal.Total != 7 || journal.Items[0].Order == nil || journal.Items[0].Order.CustomerName != nil {
		t.Fatalf("%v %+v", e, journal.Items)
	}
	// Without orders.read a customer name is not even searchable.
	query.Search = "example inst"
	journal, e = f.s.CashJournal(ctx, cashier, query)
	if e != nil || journal.Total != 0 {
		t.Fatalf("%v %+v", e, journal)
	}
	withOrders := f.principal(t, authorization.PaymentsRead, authorization.CashMovementsRead, authorization.OrdersRead)
	journal, e = f.s.CashJournal(ctx, withOrders, query)
	if e != nil || journal.Total != 3 || journal.Items[0].Order.CustomerName == nil {
		t.Fatalf("%v %+v", e, journal)
	}
}
