package orders

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/orders/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

// BudgetIncome is the part of the working-group budget this package uses: cash that is booked ahead or withdrawn
// into the budget of a period. The implementation lives in the working groups and runs inside the caller's
// transaction, so a withdrawal and its income entry commit together. It is declared here so this package does not
// depend on the working groups.
type BudgetIncome interface {
	// BookedAhead is the cash in the register that is booked ahead to the budget.
	// A nil tx reads the committed state.
	BookedAhead(ctx context.Context, tx pgx.Tx) (decimal.Decimal, error)
	// WithdrawalIncome books what a withdrawal means for the budget. mode is "new" or "ahead"; incomeId names the
	// booking ahead for "ahead". The caller must hold the finance permission.
	WithdrawalIncome(
		ctx context.Context, tx pgx.Tx, p authorization.Principal,
		movementID uuid.UUID, amount decimal.Decimal, occurredAt time.Time, mode string, incomeID *uuid.UUID,
	) error
	// LinkedMovements returns those of the movements that are linked to income.
	LinkedMovements(ctx context.Context, tx pgx.Tx, ids []uuid.UUID) (map[uuid.UUID]bool, error)
}

// WithBudget lets withdrawals go into the working-group budget. Without it a budget choice is refused.
func (s *Service) WithBudget(budget BudgetIncome) *Service {
	s.budget = budget
	return s
}

// CashMovementBudget is what a withdrawal means for the working-group budget.
type CashMovementBudget struct {
	Mode     string     `json:"mode"`
	IncomeID *uuid.UUID `json:"incomeId,omitempty"`
}

const (
	budgetNone  = "none"
	budgetNew   = "new"
	budgetAhead = "ahead"
)

func movementInBudgetError() error {
	return apperror.Conflicting(
		"cash_movement_in_budget",
		"This withdrawal went into the working-group budget and cannot be edited or deleted",
	)
}

// checkBudgetChoice validates the choice before anything is written; it returns the mode to apply or "".
func (s *Service) checkBudgetChoice(p authorization.Principal, input CashMovementInput) (string, error) {
	if input.Budget == nil || input.Budget.Mode == "" || input.Budget.Mode == budgetNone {
		return "", nil
	}
	if input.Budget.Mode != budgetNew && input.Budget.Mode != budgetAhead {
		return "", apperror.Invalid("Unsupported budget choice")
	}
	if input.Kind != CashWithdrawal {
		return "", apperror.Invalid("Only a withdrawal can go into the budget")
	}
	if !p.Has(authorization.WorkingGroupFinancesManage) {
		return "", apperror.PermissionDenied
	}
	if s.budget == nil {
		return "", apperror.Invalid("The budget is not available")
	}
	if input.Budget.Mode == budgetAhead && input.Budget.IncomeID == nil {
		return "", apperror.Invalid("Say which booking the withdrawal takes")
	}
	if input.Budget.Mode == budgetNew && input.Budget.IncomeID != nil {
		return "", apperror.Invalid("incomeId is only for money booked ahead")
	}
	return input.Budget.Mode, nil
}

// requireMovementUnlinked refuses to change a withdrawal that the budget counts.
func (s *Service) requireMovementUnlinked(ctx context.Context, tx pgx.Tx, id uuid.UUID) error {
	if s.budget == nil {
		return nil
	}
	linked, err := s.budget.LinkedMovements(ctx, tx, []uuid.UUID{id})
	if err != nil {
		return err
	}
	if linked[id] {
		return movementInBudgetError()
	}
	return nil
}

// markIntoBudget sets IntoBudget on the withdrawals the budget counts; only for finance managers.
func (s *Service) markIntoBudget(ctx context.Context, p authorization.Principal, ids []uuid.UUID) (map[uuid.UUID]bool, error) {
	if s.budget == nil || len(ids) == 0 || !p.Has(authorization.WorkingGroupFinancesManage) {
		return nil, nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	return s.budget.LinkedMovements(ctx, tx, ids)
}

// ExpectedCash is what the register should hold now. It takes the register lock for the transaction, so a booking
// ahead is checked against a stable register.
func (s *Service) ExpectedCash(ctx context.Context, tx pgx.Tx) (decimal.Decimal, error) {
	q := db.New(tx)
	if err := q.LockCashRegister(ctx); err != nil {
		return decimal.Zero, err
	}
	figures, err := cashFiguresUntil(ctx, q, nil)
	if err != nil {
		return decimal.Zero, err
	}
	return figures.expected(), nil
}

func insufficientCashError() error {
	return apperror.Conflicting("insufficient_cash", "The register does not hold enough cash for this change")
}

// requireHeldBack is the one rule that keeps money booked ahead in the register: after any change the register
// must still hold at least what is booked ahead to the budget. The error is the generic insufficient_cash, so people
// without the finance permission do not learn the booked amount. Call it under the register lock.
func (s *Service) requireHeldBack(ctx context.Context, tx pgx.Tx, q *db.Queries) error {
	if s.budget == nil {
		return nil
	}
	ahead, err := s.budget.BookedAhead(ctx, tx)
	if err != nil {
		return err
	}
	if !ahead.IsPositive() {
		return nil
	}
	figures, err := cashFiguresUntil(ctx, q, nil)
	if err != nil {
		return err
	}
	if figures.expected().LessThan(ahead) {
		return insufficientCashError()
	}
	return nil
}
