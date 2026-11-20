package workinggroups

import (
	"context"
	"errors"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	workinggroupsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

const (
	MaxIncomeNoteRunes = 160

	incomeCash = "cash"
	incomeBank = "bank"

	withdrawalNote = "Withdrawal from the cash register"
)

// CashRegister is the part of the cash register income needs: what it should hold now. The implementation takes the
// register's lock for the transaction, so every income check sees a stable register. It is declared here so this
// package does not depend on the orders.
type CashRegister interface {
	ExpectedCash(ctx context.Context, tx pgx.Tx) (decimal.Decimal, error)
}

// WithCashRegister lets finance managers book cash ahead to the budget. Without it booking ahead is refused.
func (s *Service) WithCashRegister(register CashRegister) *Service {
	s.register = register
	return s
}

// Income is money from the cash register that counts in the budget of a period.
type Income struct {
	ID             uuid.UUID
	PeriodID       uuid.UUID
	Amount         string
	OccurredOn     time.Time
	Note           string
	Where          string
	CashMovementID *uuid.UUID
	CreatedByName  *string
	CreatedAt      time.Time
}

// IncomeInput books cash ahead.
type IncomeInput struct {
	Amount string
	Note   string
}

func noOpenPeriodError() error {
	return apperror.Conflicting("no_open_budget_period", "There is no open budget period")
}

func incomeWithdrawnError() error {
	return apperror.Conflicting("income_withdrawn", "This money was withdrawn from the register already")
}

func incomeFrom(row workinggroupsdb.ListWorkingGroupIncomeRow) Income {
	out := Income{
		ID: row.ID, PeriodID: row.PeriodID, Amount: moneyText(dbMoney(row.Amount)), OccurredOn: day(row.OccurredOn.Time),
		Note: row.Note, Where: row.Location, CashMovementID: row.CashMovementID, CreatedAt: row.CreatedAt,
	}
	if row.HasCreator {
		name := row.CreatedByName
		out.CreatedByName = &name
	}
	return out
}

func (s *Service) loadIncome(ctx context.Context, q *workinggroupsdb.Queries, id uuid.UUID) (Income, error) {
	row, err := q.GetWorkingGroupIncome(ctx, id)
	if err != nil {
		return Income{}, noRows(err)
	}
	return incomeFrom(workinggroupsdb.ListWorkingGroupIncomeRow(row)), nil
}

func (s *Service) currentOpenPeriod(ctx context.Context, q *workinggroupsdb.Queries) (uuid.UUID, error) {
	today := s.today()
	id, err := q.CurrentWorkingGroupBudgetPeriod(ctx, dateParam(&today))
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, noOpenPeriodError()
	}
	return id, err
}

// ListIncome lists the income of a period (the current one by default) for finance managers.
func (s *Service) ListIncome(ctx context.Context, p authorization.Principal, periodID *uuid.UUID) ([]Income, error) {
	if err := requireRead(p); err != nil {
		return nil, err
	}
	if err := requireFinance(p); err != nil {
		return nil, err
	}
	q := workinggroupsdb.New(s.pool)
	var id uuid.UUID
	if periodID != nil {
		id = *periodID
	} else {
		today := s.today()
		var err error
		id, err = q.CurrentWorkingGroupBudgetPeriodRead(ctx, dateParam(&today))
		if errors.Is(err, pgx.ErrNoRows) {
			// Without a current period nothing can be booked: the cash register shows an empty list.
			return []Income{}, nil
		}
		if err != nil {
			return nil, err
		}
	}
	if _, err := q.GetWorkingGroupBudgetPeriod(ctx, id); err != nil {
		return nil, noRows(err)
	}
	rows, err := q.ListWorkingGroupIncome(ctx, id)
	if err != nil {
		return nil, err
	}
	items := make([]Income, 0, len(rows))
	for _, row := range rows {
		items = append(items, incomeFrom(row))
	}
	return items, nil
}

// BookAhead books an amount that is still in the cash register into the budget of the current open period. It cannot
// exceed what the register should hold minus what is booked ahead already.
func (s *Service) BookAhead(
	ctx context.Context,
	p authorization.Principal,
	input IncomeInput,
	requestID *uuid.UUID,
) (result Income, err error) {
	if err := requireRead(p); err != nil {
		return Income{}, err
	}
	if err := requireFinance(p); err != nil {
		return Income{}, err
	}
	amount, err := parseMoney(input.Amount, "amount")
	if err != nil {
		return Income{}, err
	}
	if !amount.IsPositive() {
		return Income{}, apperror.InvalidField("amount")
	}
	note, err := validateText(input.Note, "note", MaxIncomeNoteRunes, true)
	if err != nil {
		return Income{}, err
	}
	if s.register == nil {
		return Income{}, apperror.Invalid("The cash register is not available")
	}
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		// The register lock comes first, like in a withdrawal, so both see the same booked-ahead amount.
		expected, err := s.register.ExpectedCash(ctx, tx)
		if err != nil {
			return err
		}
		periodID, err := s.currentOpenPeriod(ctx, q)
		if err != nil {
			return err
		}
		ahead, err := q.WorkingGroupBookedAheadTotal(ctx)
		if err != nil {
			return err
		}
		if amount.GreaterThan(expected.Sub(dbMoney(ahead))) {
			return apperror.Conflicting("insufficient_cash", "The register does not hold that much cash that is not booked yet")
		}
		id := ids.New()
		if err := q.InsertWorkingGroupIncome(ctx, workinggroupsdb.InsertWorkingGroupIncomeParams{
			ID: id, PeriodID: periodID, Amount: moneyText(amount), OccurredOn: dateParam(ptr(s.today())), Note: note, Location: incomeCash,
			CreatedByPersonID: actorRef(p),
		}); err != nil {
			return err
		}
		if err := writeTaskAudit(ctx, tx, p, "working_group_income.booked_ahead", "working_group_income", id, requestID,
			[]string{"periodId", "amount", "note", "where"}); err != nil {
			return err
		}
		result, err = s.loadIncome(ctx, q, id)
		return err
	})
	return result, err
}

func actorRef(p authorization.Principal) *uuid.UUID {
	if p.PersonID == uuid.Nil {
		return nil
	}
	id := p.PersonID
	return &id
}

// DeleteIncome undoes a booking ahead. Money that was withdrawn is final.
func (s *Service) DeleteIncome(ctx context.Context, p authorization.Principal, id uuid.UUID, requestID *uuid.UUID) error {
	if err := requireRead(p); err != nil {
		return err
	}
	if err := requireFinance(p); err != nil {
		return err
	}
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		row, err := q.LockWorkingGroupIncome(ctx, id)
		if err != nil {
			return noRows(err)
		}
		if row.Location != incomeCash {
			return incomeWithdrawnError()
		}
		period, err := q.ShareLockWorkingGroupBudgetPeriod(ctx, row.PeriodID)
		if err != nil {
			return noRows(err)
		}
		if period.ClosedAt.Valid {
			return periodClosedError()
		}
		if _, err := q.DeleteWorkingGroupIncome(ctx, id); err != nil {
			return err
		}
		return writeTaskAudit(ctx, tx, p, "working_group_income.undone", "working_group_income", id, requestID,
			[]string{"periodId", "amount"})
	})
}

// BookedAhead is the cash that is booked ahead and still in the register, over all periods. A nil tx reads committed
// state.
func (s *Service) BookedAhead(ctx context.Context, tx pgx.Tx) (decimal.Decimal, error) {
	var q *workinggroupsdb.Queries
	if tx != nil {
		q = workinggroupsdb.New(tx)
	} else {
		q = workinggroupsdb.New(s.pool)
	}
	total, err := q.WorkingGroupBookedAheadTotal(ctx)
	if err != nil {
		return decimal.Zero, err
	}
	return dbMoney(total), nil
}

// WithdrawalIncome books what a withdrawal means for the budget, inside the withdrawal's transaction. mode "new" makes
// the withdrawn money income of the current period; "ahead" takes the booking ahead incomeID, wholly or in part (a
// larger withdrawal is refused). The caller (the orders) holds the register lock already.
func (s *Service) WithdrawalIncome(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	movementID uuid.UUID,
	amount decimal.Decimal,
	occurredAt time.Time,
	mode string,
	incomeID *uuid.UUID,
) error {
	if err := requireFinance(p); err != nil {
		return err
	}
	q := workinggroupsdb.New(tx)
	when := day(occurredAt.In(s.location))
	switch mode {
	case "new":
		periodID, err := s.currentOpenPeriod(ctx, q)
		if err != nil {
			return err
		}
		id := ids.New()
		if err := q.InsertWorkingGroupIncome(ctx, workinggroupsdb.InsertWorkingGroupIncomeParams{
			ID: id, PeriodID: periodID, Amount: moneyText(amount), OccurredOn: dateParam(&when), Note: withdrawalNote,
			Location: incomeBank, CashMovementID: &movementID, CreatedByPersonID: actorRef(p),
		}); err != nil {
			return err
		}
		return writeTaskAudit(ctx, tx, p, "working_group_income.created", "working_group_income", id, nil,
			[]string{"periodId", "amount", "where", "cashMovementId"})
	case "ahead":
		if incomeID == nil {
			return apperror.InvalidField("budget.incomeId")
		}
		row, err := q.LockWorkingGroupIncome(ctx, *incomeID)
		if err != nil {
			return noRows(err)
		}
		if row.Location != incomeCash {
			return incomeWithdrawnError()
		}
		period, err := q.ShareLockWorkingGroupBudgetPeriod(ctx, row.PeriodID)
		if err != nil {
			return noRows(err)
		}
		if period.ClosedAt.Valid {
			return periodClosedError()
		}
		booked := dbMoney(row.Amount)
		if amount.GreaterThan(booked) {
			return apperror.Invalid("The withdrawal is larger than the money booked ahead")
		}
		if amount.Equal(booked) {
			if err := q.MoveWorkingGroupIncomeToBank(ctx, workinggroupsdb.MoveWorkingGroupIncomeToBankParams{
				ID: row.ID, CashMovementID: movementID, OccurredOn: dateParam(&when),
			}); err != nil {
				return err
			}
			return writeTaskAudit(ctx, tx, p, "working_group_income.withdrawn", "working_group_income", row.ID, nil,
				[]string{"where", "cashMovementId", "occurredOn"})
		}
		if err := q.ReduceWorkingGroupIncome(ctx, workinggroupsdb.ReduceWorkingGroupIncomeParams{
			ID: row.ID, Amount: moneyText(booked.Sub(amount)),
		}); err != nil {
			return err
		}
		// The withdrawn part is a new bank entry dated at the withdrawal; the rest keeps its date, note and creator.
		id := ids.New()
		if err := q.InsertWorkingGroupIncome(ctx, workinggroupsdb.InsertWorkingGroupIncomeParams{
			ID: id, PeriodID: row.PeriodID, Amount: moneyText(amount), OccurredOn: dateParam(&when), Note: row.Note,
			Location: incomeBank, CashMovementID: &movementID, CreatedByPersonID: actorRef(p),
		}); err != nil {
			return err
		}
		return writeTaskAudit(ctx, tx, p, "working_group_income.split", "working_group_income", row.ID, nil,
			[]string{"amount", "splitInto", "cashMovementId"})
	}
	return apperror.InvalidField("budget.mode")
}

// LinkedMovements returns those of the cash movements that income points at.
func (s *Service) LinkedMovements(ctx context.Context, tx pgx.Tx, movementIDs []uuid.UUID) (map[uuid.UUID]bool, error) {
	texts := make([]string, 0, len(movementIDs))
	for _, id := range movementIDs {
		texts = append(texts, id.String())
	}
	linked, err := workinggroupsdb.New(tx).WorkingGroupMovementsWithIncome(ctx, texts)
	if err != nil {
		return nil, err
	}
	out := make(map[uuid.UUID]bool, len(linked))
	for _, id := range linked {
		out[id] = true
	}
	return out, nil
}

type incomeFigure struct{ deposited, bookedAhead decimal.Decimal }

func incomeFigures(ctx context.Context, q *workinggroupsdb.Queries) (map[uuid.UUID]incomeFigure, error) {
	rows, err := q.ListWorkingGroupIncomeFigures(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[uuid.UUID]incomeFigure, len(rows))
	for _, row := range rows {
		out[row.PeriodID] = incomeFigure{deposited: dbMoney(row.Deposited), bookedAhead: dbMoney(row.BookedAhead)}
	}
	return out, nil
}

// withIncome fills the income figures of a period; the caller passes them for finance managers only.
func (period *Period) withIncome(f incomeFigure) {
	period.IncomeDeposited = moneyText(f.deposited)
	period.IncomeBookedAhead = moneyText(f.bookedAhead)
	period.IncomeTotal = moneyText(f.deposited.Add(f.bookedAhead))
}
