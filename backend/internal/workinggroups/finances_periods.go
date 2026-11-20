package workinggroups

import (
	"context"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	workinggroupsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
)

const MaxPeriodNameRunes = 80

func periodClosedError() error {
	return apperror.Conflicting("budget_period_closed", "The budget period is closed")
}

func (s *Service) newPeriod(
	id uuid.UUID,
	name string,
	startsOn, endsOn pgtype.Date,
	total string,
	closedAt pgtype.Timestamptz,
	version int64,
	createdAt time.Time,
) Period {
	start, end := day(startsOn.Time), day(endsOn.Time)
	closed := timeValue(closedAt)
	today := s.today()
	return Period{
		ID: id, Name: name, StartsOn: start, EndsOn: end, TotalAmount: moneyText(dbMoney(total)),
		Closed: closed != nil, ClosedAt: closed, Current: closed == nil && !today.Before(start) && !today.After(end),
		Version: version, CreatedAt: createdAt,
	}
}

func (s *Service) loadPeriod(ctx context.Context, q *workinggroupsdb.Queries, id uuid.UUID) (Period, error) {
	row, err := q.GetWorkingGroupBudgetPeriod(ctx, id)
	if err != nil {
		return Period{}, noRows(err)
	}
	return s.newPeriod(row.ID, row.Name, row.StartsOn, row.EndsOn, row.TotalAmount, row.ClosedAt, row.Version, row.CreatedAt), nil
}

// ListPeriods lists the budget periods, newest first. Members of a group and finance managers see them; everybody
// else gets an empty list.
func (s *Service) ListPeriods(ctx context.Context, p authorization.Principal) ([]Period, error) {
	if err := requireRead(p); err != nil {
		return nil, err
	}
	q := workinggroupsdb.New(s.pool)
	visible, err := canSeeFinances(ctx, q, p)
	if err != nil {
		return nil, err
	}
	if !visible {
		return []Period{}, nil
	}
	rows, err := q.ListWorkingGroupBudgetPeriods(ctx)
	if err != nil {
		return nil, err
	}
	var figures map[uuid.UUID]incomeFigure
	if isFinance(p) {
		if figures, err = incomeFigures(ctx, q); err != nil {
			return nil, err
		}
	}
	items := make([]Period, 0, len(rows))
	for _, row := range rows {
		period := s.newPeriod(row.ID, row.Name, row.StartsOn, row.EndsOn, row.TotalAmount, row.ClosedAt, row.Version, row.CreatedAt)
		if !isFinance(p) {
			period.TotalAmount = "" // the total from HTU is for finance managers
		} else {
			period.withIncome(figures[row.ID])
		}
		items = append(items, period)
	}
	return items, nil
}

func validatePeriodName(value string) (string, error) {
	return validateText(value, "name", MaxPeriodNameRunes, true)
}

func validatePeriodDates(start, end time.Time) error {
	if start.IsZero() {
		return apperror.InvalidField("startsOn")
	}
	if end.IsZero() || end.Before(start) {
		return apperror.InvalidField("endsOn")
	}
	return nil
}

// CreatePeriod makes a budget period, optionally with the group shares of another period.
func (s *Service) CreatePeriod(
	ctx context.Context,
	p authorization.Principal,
	input PeriodInput,
	requestID *uuid.UUID,
) (result Period, err error) {
	if err := requireRead(p); err != nil {
		return Period{}, err
	}
	if err := requireFinance(p); err != nil {
		return Period{}, err
	}
	name, err := validatePeriodName(input.Name)
	if err != nil {
		return Period{}, err
	}
	start, end := day(input.StartsOn), day(input.EndsOn)
	if err := validatePeriodDates(start, end); err != nil {
		return Period{}, err
	}
	total, err := parseMoney(input.TotalAmount, "totalAmount")
	if err != nil {
		return Period{}, err
	}
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		if input.CopySharesFromPeriodID != nil {
			if _, err := q.GetWorkingGroupBudgetPeriod(ctx, *input.CopySharesFromPeriodID); err != nil {
				return noRows(err)
			}
		}
		id := ids.New()
		if err := q.CreateWorkingGroupBudgetPeriod(ctx, workinggroupsdb.CreateWorkingGroupBudgetPeriodParams{
			ID: id, Name: name, StartsOn: dateParam(&start), EndsOn: dateParam(&end), TotalAmount: moneyText(total),
		}); err != nil {
			return err
		}
		fields := []string{"name", "startsOn", "endsOn", "totalAmount"}
		if input.CopySharesFromPeriodID != nil {
			if err := q.CopyWorkingGroupBudgetShares(ctx, workinggroupsdb.CopyWorkingGroupBudgetSharesParams{
				PeriodID: id, SourcePeriodID: *input.CopySharesFromPeriodID,
			}); err != nil {
				return err
			}
			fields = append(fields, "shares")
		}
		if err := writeTaskAudit(ctx, tx, p, "working_group_budget_period.created", "working_group_budget_period", id, requestID, fields); err != nil {
			return err
		}
		result, err = s.loadPeriod(ctx, q, id)
		return err
	})
	return result, err
}

// UpdatePeriod changes name, dates and total of an open period.
func (s *Service) UpdatePeriod(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	input PeriodUpdate,
	requestID *uuid.UUID,
) (result Period, err error) {
	if err := requireRead(p); err != nil {
		return Period{}, err
	}
	if err := requireFinance(p); err != nil {
		return Period{}, err
	}
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		locked, err := q.LockWorkingGroupBudgetPeriod(ctx, id)
		if err != nil {
			return noRows(err)
		}
		if locked.ClosedAt.Valid {
			return periodClosedError()
		}
		if input.ExpectedVersion < 1 {
			return apperror.Invalid("expectedVersion must be positive")
		}
		if locked.Version != input.ExpectedVersion {
			return apperror.StaleWrite
		}
		current, err := s.loadPeriod(ctx, q, id)
		if err != nil {
			return err
		}
		name, start, end, total := current.Name, current.StartsOn, current.EndsOn, dbMoney(current.TotalAmount)
		var fields []string
		if input.Name != nil {
			if name, err = validatePeriodName(*input.Name); err != nil {
				return err
			}
			fields = append(fields, "name")
		}
		if input.StartsOn != nil {
			start = day(*input.StartsOn)
			fields = append(fields, "startsOn")
		}
		if input.EndsOn != nil {
			end = day(*input.EndsOn)
			fields = append(fields, "endsOn")
		}
		if input.TotalAmount != nil {
			if total, err = parseMoney(*input.TotalAmount, "totalAmount"); err != nil {
				return err
			}
			fields = append(fields, "totalAmount")
		}
		if err := validatePeriodDates(start, end); err != nil {
			return err
		}
		if _, err := q.UpdateWorkingGroupBudgetPeriod(ctx, workinggroupsdb.UpdateWorkingGroupBudgetPeriodParams{
			ID: id, Name: name, StartsOn: dateParam(&start), EndsOn: dateParam(&end), TotalAmount: moneyText(total),
		}); err != nil {
			return err
		}
		if err := writeTaskAudit(ctx, tx, p, "working_group_budget_period.updated", "working_group_budget_period", id, requestID, fields); err != nil {
			return err
		}
		result, err = s.loadPeriod(ctx, q, id)
		return err
	})
	return result, err
}

// ClosePeriod closes a period for good: it accepts no new purchases, bookings or share changes afterwards.
func (s *Service) ClosePeriod(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expectedVersion int64,
	requestID *uuid.UUID,
) (result Period, err error) {
	if err := requireRead(p); err != nil {
		return Period{}, err
	}
	if err := requireFinance(p); err != nil {
		return Period{}, err
	}
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		locked, err := q.LockWorkingGroupBudgetPeriod(ctx, id)
		if err != nil {
			return noRows(err)
		}
		if locked.ClosedAt.Valid {
			return periodClosedError()
		}
		if expectedVersion < 1 {
			return apperror.Invalid("expectedVersion must be positive")
		}
		if locked.Version != expectedVersion {
			return apperror.StaleWrite
		}
		ahead, err := q.WorkingGroupPeriodHasBookedAhead(ctx, id)
		if err != nil {
			return err
		}
		if ahead {
			return apperror.Conflicting("income_booked_ahead", "Withdraw or undo the money booked ahead first.")
		}
		if _, err := q.CloseWorkingGroupBudgetPeriod(ctx, id); err != nil {
			return err
		}
		if err := writeTaskAudit(ctx, tx, p, "working_group_budget_period.closed", "working_group_budget_period", id, requestID, []string{"closed"}); err != nil {
			return err
		}
		result, err = s.loadPeriod(ctx, q, id)
		return err
	})
	return result, err
}

func figuresOf(row workinggroupsdb.ListWorkingGroupBudgetFiguresRow) (GroupBudget, decimal.Decimal, decimal.Decimal, decimal.Decimal) {
	given, spent, reserved := dbMoney(row.Given), dbMoney(row.Spent), dbMoney(row.Reserved)
	return GroupBudget{
		GroupID: row.GroupID, GroupName: row.GroupName,
		Given: moneyText(given), Spent: moneyText(spent), Reserved: moneyText(reserved),
		Free: moneyText(given.Sub(spent).Sub(reserved)),
	}, given, spent, reserved
}

// SetShare sets what a group is given in a period; 0 is allowed.
func (s *Service) SetShare(
	ctx context.Context,
	p authorization.Principal,
	periodID, groupID uuid.UUID,
	amount string,
	requestID *uuid.UUID,
) (result GroupBudget, err error) {
	if err := requireRead(p); err != nil {
		return GroupBudget{}, err
	}
	if err := requireFinance(p); err != nil {
		return GroupBudget{}, err
	}
	given, err := parseMoney(amount, "amount")
	if err != nil {
		return GroupBudget{}, err
	}
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		// Group before period, like every change that books into a period; the share's foreign key to the group
		// would otherwise wait for a purchase that holds the group and waits for this period.
		if _, err := q.LockWorkingGroup(ctx, groupID); err != nil {
			return noRows(err)
		}
		locked, err := q.LockWorkingGroupBudgetPeriod(ctx, periodID)
		if err != nil {
			return noRows(err)
		}
		if locked.ClosedAt.Valid {
			return periodClosedError()
		}
		if err := q.UpsertWorkingGroupBudgetShare(ctx, workinggroupsdb.UpsertWorkingGroupBudgetShareParams{
			PeriodID: periodID, GroupID: groupID, Amount: moneyText(given),
		}); err != nil {
			if isForeignKeyViolation(err) {
				return apperror.NotFound
			}
			return err
		}
		if err := writeTaskAudit(ctx, tx, p, "working_group_budget_period.share_set", "working_group_budget_period", periodID, requestID, []string{"share"}); err != nil {
			return err
		}
		rows, err := q.ListWorkingGroupBudgetFigures(ctx, workinggroupsdb.ListWorkingGroupBudgetFiguresParams{
			PeriodID: periodID, AllGroups: true, CallerPersonID: p.PersonID, GroupID: &groupID, Today: dateParam(ptr(s.today())),
		})
		if err != nil {
			return err
		}
		if len(rows) != 1 {
			return apperror.NotFound
		}
		result, _, _, _ = figuresOf(rows[0])
		return nil
	})
	return result, err
}

// GetBudget returns the figures of a period (the current one by default): every group for finance managers, the
// caller's groups for members. Nobody else sees a period (404).
func (s *Service) GetBudget(ctx context.Context, p authorization.Principal, periodID *uuid.UUID) (Budget, error) {
	if err := requireRead(p); err != nil {
		return Budget{}, err
	}
	q := workinggroupsdb.New(s.pool)
	visible, err := canSeeFinances(ctx, q, p)
	if err != nil {
		return Budget{}, err
	}
	if !visible {
		return Budget{}, apperror.NotFound
	}
	var id uuid.UUID
	if periodID != nil {
		id = *periodID
	} else {
		today := s.today()
		if id, err = q.CurrentWorkingGroupBudgetPeriodRead(ctx, dateParam(&today)); err != nil {
			return Budget{}, noRows(err)
		}
	}
	period, err := s.loadPeriod(ctx, q, id)
	if err != nil {
		return Budget{}, err
	}
	finance := isFinance(p)
	rows, err := q.ListWorkingGroupBudgetFigures(ctx, workinggroupsdb.ListWorkingGroupBudgetFiguresParams{
		PeriodID: id, AllGroups: finance, CallerPersonID: p.PersonID, Today: dateParam(ptr(s.today())),
	})
	if err != nil {
		return Budget{}, err
	}
	budget := Budget{Period: period, Groups: make([]GroupBudget, 0, len(rows))}
	givenSum, spentSum, reservedSum := decimal.Zero, decimal.Zero, decimal.Zero
	for _, row := range rows {
		group, given, spent, reserved := figuresOf(row)
		budget.Groups = append(budget.Groups, group)
		givenSum, spentSum, reservedSum = givenSum.Add(given), spentSum.Add(spent), reservedSum.Add(reserved)
	}
	if finance {
		figures, err := incomeFigures(ctx, q)
		if err != nil {
			return Budget{}, err
		}
		income := figures[id]
		budget.Period.withIncome(income)
		// The budget of the period is the total from HTU plus the income from the cash register.
		total := dbMoney(period.TotalAmount).Add(income.deposited).Add(income.bookedAhead)
		budget.Totals = &BudgetTotals{
			TotalAmount: moneyText(total), GivenSum: moneyText(givenSum), KeptBack: moneyText(total.Sub(givenSum)),
			SpentSum: moneyText(spentSum), ReservedSum: moneyText(reservedSum), FreeSum: moneyText(givenSum.Sub(spentSum).Sub(reservedSum)),
		}
	}
	if !finance {
		budget.Period.TotalAmount = ""
	}
	return budget, nil
}

// validateShortText trims and checks a required text of at most max runes.
func validateShortText(value, field string, max int) (string, error) {
	clean := strings.TrimSpace(value)
	if clean == "" || utf8.RuneCountInString(clean) > max {
		return "", apperror.InvalidField(field)
	}
	return clean, nil
}
