package integration_test

import (
	"errors"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/orders"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups"
	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

type incomeFixture struct {
	financeFixture
	orders *orders.Service
	// fin holds the finance permission, cash only records cash movements without it.
	fin, cash authorization.Principal
}

func newIncomeFixture(t *testing.T, tag string) incomeFixture {
	t.Helper()
	f := incomeFixture{financeFixture: newFinanceFixture(t, tag)}
	o := orders.NewService(f.pool, nil)
	f.service = f.service.WithCashRegister(o)
	f.orders = o.WithBudget(f.service)
	f.fin, _ = groupPrincipal(t, f.pool, tag+"-incfin", "working_groups.read", "working_group_finances.manage",
		"cash_movements.read", "cash_movements.record", "cash_movements.manage", "payments.read")
	f.cash, _ = groupPrincipal(t, f.pool, tag+"-inccash", "working_groups.read", "cash_movements.read", "cash_movements.record", "payments.read")
	// Everything booked ahead by earlier tests is gone, so the figures below start from zero.
	mergeExec(t, f.pool, `DELETE FROM working_group_income WHERE location = 'cash'`)
	return f
}

func (f incomeFixture) deposit(t *testing.T, amount string) {
	t.Helper()
	_, err := f.orders.CreateCashMovement(testContext(t), f.cash, orders.CashMovementInput{
		OperationKey: ids.New(), Kind: orders.CashDeposit, Amount: amount, Reason: orders.CashReasonFloat,
		OccurredAt: time.Now().Add(-time.Minute),
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
}

func (f incomeFixture) withdraw(t *testing.T, p authorization.Principal, amount string, budget *orders.CashMovementBudget) (orders.CashMovement, error) {
	t.Helper()
	return f.orders.CreateCashMovement(testContext(t), p, orders.CashMovementInput{
		OperationKey: ids.New(), Kind: orders.CashWithdrawal, Amount: amount, Reason: orders.CashReasonBankDeposit,
		OccurredAt: time.Now().Add(-time.Second), Budget: budget,
	}, nil)
}

func (f incomeFixture) free(t *testing.T) decimal.Decimal {
	t.Helper()
	register, err := f.orders.CashRegister(testContext(t), f.fin, nil)
	if err != nil || register.BookedAhead == nil {
		t.Fatalf("register: %v", err)
	}
	expected, _ := decimal.NewFromString(register.Expected)
	ahead, _ := decimal.NewFromString(*register.BookedAhead)
	return expected.Sub(ahead)
}

func (f incomeFixture) book(t *testing.T, amount string) workinggroups.Income {
	t.Helper()
	income, err := f.service.BookAhead(testContext(t), f.fin, workinggroups.IncomeInput{Amount: amount, Note: "Sales so far"}, nil)
	if err != nil {
		t.Fatalf("book %s: %v", amount, err)
	}
	return income
}

func wantCode(t *testing.T, err error, status int, code string) {
	t.Helper()
	var appErr *apperror.Error
	if !errors.As(err, &appErr) || appErr.HTTPStatus != status || (code != "" && appErr.Code != code) {
		t.Fatalf("got %v, want %d %s", err, status, code)
	}
}

func TestWorkingGroupIncomeBookAheadLimitUndoAndFigures(t *testing.T) {
	f := newIncomeFixture(t, "incbook")
	ctx := testContext(t)
	f.deposit(t, "300.00")
	free := f.free(t)
	over := free.Add(decimal.RequireFromString("0.01")).StringFixed(2)
	_, err := f.service.BookAhead(ctx, f.fin, workinggroups.IncomeInput{Amount: over, Note: "Too much"}, nil)
	wantCode(t, err, 409, "insufficient_cash")
	income := f.book(t, "120.00")
	if income.Where != "cash" || income.CashMovementID != nil || income.Amount != "120.00" {
		t.Fatalf("income %+v", income)
	}
	// What is booked already reduces the limit.
	_, err = f.service.BookAhead(ctx, f.fin, workinggroups.IncomeInput{Amount: free.Sub(decimal.NewFromInt(119)).StringFixed(2), Note: "x"}, nil)
	wantCode(t, err, 409, "insufficient_cash")
	budget, err := f.service.GetBudget(ctx, f.fin, &f.period.ID)
	if err != nil {
		t.Fatal(err)
	}
	if budget.Period.IncomeTotal != "120.00" || budget.Period.IncomeBookedAhead != "120.00" || budget.Period.IncomeDeposited != "0.00" ||
		budget.Totals.TotalAmount != "5120.00" || budget.Totals.KeptBack != "4120.00" {
		t.Fatalf("figures %+v %+v", budget.Period, budget.Totals)
	}
	periods, err := f.service.ListPeriods(ctx, f.fin)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, period := range periods {
		if period.ID == f.period.ID {
			found = true
			if period.IncomeTotal != "120.00" {
				t.Fatalf("period list figures %+v", period)
			}
		}
	}
	if !found {
		t.Fatal("period missing")
	}
	// Members see neither the income nor its figures.
	if _, err = f.service.ListIncome(ctx, f.third, &f.period.ID); err == nil {
		t.Fatal("a member listed the income")
	}
	wantCode(t, err, 403, "permission_denied")
	memberBudget, err := f.service.GetBudget(ctx, f.third, &f.period.ID)
	if err != nil || memberBudget.Totals != nil || memberBudget.Period.IncomeTotal != "" {
		t.Fatalf("member budget %+v %v", memberBudget, err)
	}
	_, err = f.service.BookAhead(ctx, f.cash, workinggroups.IncomeInput{Amount: "1.00", Note: "x"}, nil)
	wantCode(t, err, 403, "permission_denied")
	if err = f.service.DeleteIncome(ctx, f.cash, income.ID, nil); err == nil {
		t.Fatal("deleted without the finance permission")
	}
	// The cash recorder does not see the register's booked-ahead figure.
	register, err := f.orders.CashRegister(ctx, f.cash, nil)
	if err != nil || register.BookedAhead != nil {
		t.Fatalf("register %+v %v", register.BookedAhead, err)
	}
	items, err := f.service.ListIncome(ctx, f.fin, &f.period.ID)
	if err != nil || len(items) != 1 || items[0].ID != income.ID {
		t.Fatalf("list %+v %v", items, err)
	}
	if err = f.service.DeleteIncome(ctx, f.fin, income.ID, nil); err != nil {
		t.Fatal(err)
	}
	wantCode(t, f.service.DeleteIncome(ctx, f.fin, income.ID, nil), 404, "")
}

func TestWorkingGroupIncomeWithdrawalModes(t *testing.T) {
	f := newIncomeFixture(t, "incwd")
	ctx := testContext(t)
	f.deposit(t, "500.00")
	// Without the finance permission a budget choice is refused and nothing is written.
	_, err := f.withdraw(t, f.cash, "10.00", &orders.CashMovementBudget{Mode: "new"})
	wantCode(t, err, 403, "permission_denied")
	// "none" is today's behaviour for everybody.
	if _, err = f.withdraw(t, f.cash, "10.00", &orders.CashMovementBudget{Mode: "none"}); err != nil {
		t.Fatal(err)
	}
	// Into the budget: an income entry "bank" linked to the withdrawal.
	into, err := f.withdraw(t, f.fin, "40.00", &orders.CashMovementBudget{Mode: "new"})
	if err != nil || into.IntoBudget == nil || !*into.IntoBudget {
		t.Fatalf("into %+v %v", into, err)
	}
	items, err := f.service.ListIncome(ctx, f.fin, &f.period.ID)
	if err != nil || len(items) != 1 || items[0].Where != "bank" || items[0].CashMovementID == nil || *items[0].CashMovementID != into.ID {
		t.Fatalf("income %+v %v", items, err)
	}
	// Booked ahead, taken whole.
	whole := f.book(t, "50.00")
	if _, err = f.withdraw(t, f.fin, "50.00", &orders.CashMovementBudget{Mode: "ahead", IncomeID: &whole.ID}); err != nil {
		t.Fatal(err)
	}
	// Booked ahead, taken in part: the rest stays booked ahead.
	part := f.book(t, "80.00")
	if _, err = f.withdraw(t, f.fin, "30.00", &orders.CashMovementBudget{Mode: "ahead", IncomeID: &part.ID}); err != nil {
		t.Fatal(err)
	}
	// Larger than the booking: 422, and nothing changes.
	_, err = f.withdraw(t, f.fin, "50.01", &orders.CashMovementBudget{Mode: "ahead", IncomeID: &part.ID})
	wantCode(t, err, 422, "")
	// A booking that is withdrawn already cannot be taken again.
	_, err = f.withdraw(t, f.fin, "1.00", &orders.CashMovementBudget{Mode: "ahead", IncomeID: &whole.ID})
	wantCode(t, err, 409, "income_withdrawn")
	// Without the id the choice is invalid.
	_, err = f.withdraw(t, f.fin, "1.00", &orders.CashMovementBudget{Mode: "ahead"})
	wantCode(t, err, 422, "")
	budget, err := f.service.GetBudget(ctx, f.fin, &f.period.ID)
	if err != nil {
		t.Fatal(err)
	}
	// 40 + 50 + 30 deposited, 50 still booked ahead.
	if budget.Period.IncomeDeposited != "120.00" || budget.Period.IncomeBookedAhead != "50.00" || budget.Period.IncomeTotal != "170.00" {
		t.Fatalf("figures %+v", budget.Period)
	}
	var movementRows int
	if err = f.pool.QueryRow(ctx, `SELECT count(*) FROM working_group_income WHERE location = 'bank' AND cash_movement_id IS NULL`).Scan(&movementRows); err != nil || movementRows != 0 {
		t.Fatalf("bank entries without a withdrawal: %d %v", movementRows, err)
	}
	// Undoing a booking that was partly withdrawn removes only what is left.
	if err = f.service.DeleteIncome(ctx, f.fin, part.ID, nil); err != nil {
		t.Fatal(err)
	}
	budget, _ = f.service.GetBudget(ctx, f.fin, &f.period.ID)
	if budget.Period.IncomeDeposited != "120.00" || budget.Period.IncomeBookedAhead != "0.00" {
		t.Fatalf("after undo %+v", budget.Period)
	}
}

func TestWorkingGroupIncomeLinkedWithdrawalIsLocked(t *testing.T) {
	f := newIncomeFixture(t, "inclock")
	ctx := testContext(t)
	f.deposit(t, "200.00")
	into, err := f.withdraw(t, f.fin, "20.00", &orders.CashMovementBudget{Mode: "new"})
	if err != nil {
		t.Fatal(err)
	}
	amount := "19.00"
	_, err = f.orders.UpdateCashMovement(ctx, f.fin, into.ID, orders.CashMovementChange{ExpectedVersion: into.Version, Amount: &amount}, nil)
	wantCode(t, err, 409, "cash_movement_in_budget")
	wantCode(t, f.orders.DeleteCashMovement(ctx, f.fin, into.ID, orders.CashEntryDeletion{ExpectedVersion: into.Version}, nil), 409, "cash_movement_in_budget")
	// A withdrawal that is not for the budget stays editable and deletable.
	plain, err := f.withdraw(t, f.fin, "5.00", nil)
	if err != nil {
		t.Fatal(err)
	}
	note := "changed"
	if _, err = f.orders.UpdateCashMovement(ctx, f.fin, plain.ID, orders.CashMovementChange{ExpectedVersion: plain.Version, Note: &note}, nil); err != nil {
		t.Fatal(err)
	}
	// The journal marks the withdrawal for finance managers only.
	journal := func(p authorization.Principal) map[uuid.UUID]*bool {
		result, err := f.orders.CashJournal(ctx, p, orders.CashJournalQuery{Page: 1, Size: 100, NewestFirst: true})
		if err != nil {
			t.Fatal(err)
		}
		out := map[uuid.UUID]*bool{}
		for _, item := range result.Items {
			out[item.ID] = item.IntoBudget
		}
		return out
	}
	if v := journal(f.fin)[into.ID]; v == nil || !*v {
		t.Fatal("finance manager does not see the budget mark")
	}
	if v := journal(f.cash)[into.ID]; v != nil {
		t.Fatal("the budget mark leaked to a cash recorder")
	}
}

func (f incomeFixture) incomeRows(t *testing.T) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(testContext(t), `SELECT count(*) FROM working_group_income`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestWorkingGroupIncomeBookedAheadStaysInTheRegister(t *testing.T) {
	f := newIncomeFixture(t, "incheld")
	ctx := testContext(t)
	f.deposit(t, "100.00")
	free := f.free(t)
	booking := f.book(t, free.StringFixed(2))
	// Everything in the register is booked ahead: nobody can take cash out any more, and the error does not name the
	// booked amount for people without the finance permission.
	_, err := f.withdraw(t, f.cash, "0.01", nil)
	wantCode(t, err, 409, "insufficient_cash")
	_, err = f.withdraw(t, f.fin, "0.01", &orders.CashMovementBudget{Mode: "new"})
	wantCode(t, err, 409, "insufficient_cash")
	_, err = f.withdraw(t, f.fin, "0.01", nil)
	wantCode(t, err, 409, "insufficient_cash")
	// Taking the booking itself is fine.
	if _, err = f.withdraw(t, f.fin, booking.Amount, &orders.CashMovementBudget{Mode: "ahead", IncomeID: &booking.ID}); err != nil {
		t.Fatal(err)
	}
	// Free cash can be taken, up to what is not booked: book 40 of the 100 just deposited.
	f.deposit(t, "100.00")
	f.book(t, "40.00")
	free = f.free(t)
	_, err = f.withdraw(t, f.fin, free.Add(decimal.RequireFromString("0.01")).StringFixed(2), &orders.CashMovementBudget{Mode: "new"})
	wantCode(t, err, 409, "")
	if _, err = f.withdraw(t, f.cash, free.StringFixed(2), nil); err != nil {
		t.Fatalf("withdrawing the free cash: %v", err)
	}
	// A deposit cannot be deleted when that would leave less in the register than is booked ahead.
	f.deposit(t, "10.00")
	f.book(t, "10.00")
	list, err := f.orders.ListCashMovements(ctx, f.fin, "deposit", nil, nil, 1, 1)
	if err != nil || len(list.Items) != 1 {
		t.Fatalf("deposits %+v %v", list, err)
	}
	last := list.Items[0]
	wantCode(t, f.orders.DeleteCashMovement(ctx, f.fin, last.ID, orders.CashEntryDeletion{ExpectedVersion: last.Version}, nil), 409, "insufficient_cash")
}

func TestWorkingGroupIncomeClosingNeedsTheBookingsGone(t *testing.T) {
	f := newIncomeFixture(t, "incclose")
	ctx := testContext(t)
	f.deposit(t, "50.00")
	booking := f.book(t, "5.00")
	_, err := f.service.ClosePeriod(ctx, f.finance, f.period.ID, f.period.Version, nil)
	wantCode(t, err, 409, "income_booked_ahead")
	if err = f.service.DeleteIncome(ctx, f.fin, booking.ID, nil); err != nil {
		t.Fatal(err)
	}
	// Defence in depth: a period that is closed by other means accepts neither undo nor a withdrawal of a booking.
	again := f.book(t, "5.00")
	mergeExec(t, f.pool, `UPDATE working_group_budget_periods SET closed_at = now() WHERE id = '`+f.period.ID.String()+`'`)
	wantCode(t, f.service.DeleteIncome(ctx, f.fin, again.ID, nil), 409, "budget_period_closed")
	_, err = f.withdraw(t, f.fin, "5.00", &orders.CashMovementBudget{Mode: "ahead", IncomeID: &again.ID})
	wantCode(t, err, 409, "budget_period_closed")
}

func TestWorkingGroupIncomePermissionsAndVisibility(t *testing.T) {
	f := newIncomeFixture(t, "incperm")
	ctx := testContext(t)
	f.deposit(t, "200.00")
	booking := f.book(t, "20.00")
	before := f.incomeRows(t)
	_, err := f.withdraw(t, f.cash, "5.00", &orders.CashMovementBudget{Mode: "ahead", IncomeID: &booking.ID})
	wantCode(t, err, 403, "permission_denied")
	if f.incomeRows(t) != before {
		t.Fatal("a refused budget choice wrote income")
	}
	wantCode(t, f.service.DeleteIncome(ctx, f.cash, booking.ID, nil), 403, "permission_denied")
	into, err := f.withdraw(t, f.fin, "5.00", &orders.CashMovementBudget{Mode: "new"})
	if err != nil {
		t.Fatal(err)
	}
	// A cash recorder sees neither the mark nor the booked-ahead figure.
	list, err := f.orders.ListCashMovements(ctx, f.cash, "withdrawal", nil, nil, 1, 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range list.Items {
		if item.IntoBudget != nil {
			t.Fatalf("movement %s leaked intoBudget", item.ID)
		}
	}
	journal, err := f.orders.CashJournal(ctx, f.cash, orders.CashJournalQuery{Page: 1, Size: 10})
	if err != nil || journal.Register.BookedAhead != nil {
		t.Fatalf("journal register %v %v", journal.Register.BookedAhead, err)
	}
	if journal, err = f.orders.CashJournal(ctx, f.fin, orders.CashJournalQuery{Page: 1, Size: 10}); err != nil || journal.Register.BookedAhead == nil {
		t.Fatalf("finance journal register %v", err)
	}
	periods, err := f.service.ListPeriods(ctx, f.third)
	if err != nil {
		t.Fatal(err)
	}
	for _, period := range periods {
		if period.IncomeTotal != "" || period.IncomeDeposited != "" || period.IncomeBookedAhead != "" {
			t.Fatalf("period %s leaked income figures", period.Name)
		}
	}
	// Somebody who may manage movements but is no finance manager cannot change a withdrawal that went into the budget.
	editor, _ := groupPrincipal(t, f.pool, "incperm-editor", "working_groups.read", "cash_movements.read", "cash_movements.manage", "cash_movements.record")
	amount := "4.00"
	_, err = f.orders.UpdateCashMovement(ctx, editor, into.ID, orders.CashMovementChange{ExpectedVersion: into.Version, Amount: &amount}, nil)
	wantCode(t, err, 409, "cash_movement_in_budget")
	wantCode(t, f.orders.DeleteCashMovement(ctx, editor, into.ID, orders.CashEntryDeletion{ExpectedVersion: into.Version}, nil), 409, "cash_movement_in_budget")
}

func TestWorkingGroupIncomeRetryRepeatsTheBudgetChoice(t *testing.T) {
	f := newIncomeFixture(t, "incretry")
	f.deposit(t, "100.00")
	key := ids.New()
	input := orders.CashMovementInput{
		OperationKey: key, Kind: orders.CashWithdrawal, Amount: "10.00", Reason: orders.CashReasonBankDeposit,
		OccurredAt: time.Now().Add(-time.Second).UTC().Truncate(time.Microsecond), Budget: &orders.CashMovementBudget{Mode: "new"},
	}
	first, err := f.orders.CreateCashMovement(testContext(t), f.fin, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	again, err := f.orders.CreateCashMovement(testContext(t), f.fin, input, nil)
	if err != nil || again.ID != first.ID || again.IntoBudget == nil || !*again.IntoBudget {
		t.Fatalf("retry %+v %v", again, err)
	}
	input.Budget = nil
	_, err = f.orders.CreateCashMovement(testContext(t), f.fin, input, nil)
	wantCode(t, err, 409, "idempotency_conflict")
}
