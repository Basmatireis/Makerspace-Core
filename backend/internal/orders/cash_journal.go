package orders

import (
	"context"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/orders/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

// CashJournalKind is the kind of a cash register entry.
type CashJournalKind string

const (
	JournalReceipt    CashJournalKind = "receipt"
	JournalRefund     CashJournalKind = "refund"
	JournalCorrection CashJournalKind = "correction"
	JournalWithdrawal CashJournalKind = "withdrawal"
	JournalDeposit    CashJournalKind = "deposit"
	JournalCount      CashJournalKind = "count"
)

// MaxCashJournalSearchLength bounds the free-text search of the journal.
const MaxCashJournalSearchLength = 200

const dayLayout = "2006-01-02"

// CashJournalQuery selects journal entries. From and To are calendar days (only their date counts), both inclusive,
// in the makerspace time zone.
type CashJournalQuery struct {
	From, To    *time.Time
	Kinds       []CashJournalKind
	Search      string
	NewestFirst bool
	Page, Size  int
}

type CashJournalOrder struct {
	ID           *uuid.UUID `json:"id"`
	Reference    string     `json:"reference"`
	CustomerName *string    `json:"customerName"`
}

type CashJournalCount struct {
	ID             uuid.UUID        `json:"id"`
	Reference      string           `json:"reference"`
	CountedAmount  string           `json:"countedAmount"`
	ExpectedAmount string           `json:"expectedAmount"`
	Difference     string           `json:"difference"`
	Reason         *CashCountReason `json:"reason"`
}

type CashJournalEntry struct {
	ID                       uuid.UUID           `json:"id"`
	Source                   string              `json:"source"`
	Kind                     CashJournalKind     `json:"kind"`
	Reference                string              `json:"reference"`
	OccurredAt               time.Time           `json:"occurredAt"`
	Day                      string              `json:"day"`
	AmountIn                 *string             `json:"amountIn"`
	AmountOut                *string             `json:"amountOut"`
	BalanceAfter             string              `json:"balanceAfter"`
	RecordedBy               *Actor              `json:"recordedBy"`
	Order                    *CashJournalOrder   `json:"order"`
	PaymentReason            string              `json:"paymentReason"`
	ReversedPaymentReference *string             `json:"reversedPaymentReference"`
	MovementReason           *CashMovementReason `json:"movementReason"`
	Note                     string              `json:"note"`
	Count                    *CashJournalCount   `json:"count"`
	// effect is the signed change of the register, for the exports.
	effect decimal.Decimal
}

type CashJournalDay struct {
	Date           string `json:"date"`
	OpeningBalance string `json:"openingBalance"`
	ClosingBalance string `json:"closingBalance"`
	CashIn         string `json:"cashIn"`
	CashOut        string `json:"cashOut"`
}

type CashJournalFacts struct {
	CashIn         string `json:"cashIn"`
	CashInEntries  int64  `json:"cashInEntries"`
	Receipts       int64  `json:"receipts"`
	Deposits       int64  `json:"deposits"`
	CashOut        string `json:"cashOut"`
	CashOutEntries int64  `json:"cashOutEntries"`
	Refunds        int64  `json:"refunds"`
	Corrections    int64  `json:"corrections"`
	Withdrawals    int64  `json:"withdrawals"`
	Net            string `json:"net"`
	Counts         int64  `json:"counts"`
}

type CashJournal struct {
	From           *string            `json:"from"`
	To             *string            `json:"to"`
	Items          []CashJournalEntry `json:"items"`
	Page           int64              `json:"page"`
	PageSize       int64              `json:"pageSize"`
	Total          int64              `json:"total"`
	Days           []CashJournalDay   `json:"days"`
	OpeningBalance string             `json:"openingBalance"`
	Register       CashRegister       `json:"register"`
	Facts          CashJournalFacts   `json:"facts"`
}

// dayRange turns calendar days into instants: the start of `from` and the start of the day after `to`.
type dayRange struct {
	from, to *time.Time
}

func (s *Service) startOfDay(day time.Time) time.Time {
	return time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, s.location)
}

func (s *Service) days(from, to *time.Time) (dayRange, error) {
	var r dayRange
	if from != nil {
		start := s.startOfDay(*from)
		r.from = &start
	}
	if to != nil {
		end := s.startOfDay(to.AddDate(0, 0, 1))
		r.to = &end
	}
	if from != nil && to != nil && !r.from.Before(*r.to) {
		return r, apperror.Invalid("The first day must not be after the last day")
	}
	return r, nil
}

func formatDay(day *time.Time) *string {
	if day == nil {
		return nil
	}
	v := day.Format(dayLayout)
	return &v
}

func validJournalKind(kind CashJournalKind) bool {
	switch kind {
	case JournalReceipt, JournalRefund, JournalCorrection, JournalWithdrawal, JournalDeposit, JournalCount:
		return true
	}
	return false
}

// readOnly runs fn in a read-only snapshot, so the figures of one report agree with each other.
func (s *Service) readOnly(ctx context.Context, fn func(q *db.Queries) error) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = fn(db.New(tx)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) journalEntry(row db.ListCashJournalRow, withCustomer bool) CashJournalEntry {
	effect := d(row.Effect)
	v := CashJournalEntry{
		ID:            row.ID,
		Source:        row.Source,
		Kind:          CashJournalKind(row.Kind),
		Reference:     row.Reference,
		OccurredAt:    row.OccurredAt,
		Day:           row.OccurredAt.In(s.location).Format(dayLayout),
		BalanceAfter:  d(row.Balance).StringFixed(2),
		PaymentReason: row.PaymentReason,
		Note:          row.Note,
		effect:        effect,
	}
	switch {
	case effect.IsPositive():
		amount := effect.StringFixed(2)
		v.AmountIn = &amount
	case effect.IsNegative():
		amount := effect.Neg().StringFixed(2)
		v.AmountOut = &amount
	}
	if row.RecordedByID != nil {
		v.RecordedBy = &Actor{ID: *row.RecordedByID, DisplayName: row.RecordedByName}
	}
	if row.OrderReference != "" {
		v.Order = &CashJournalOrder{ID: row.OrderID, Reference: row.OrderReference}
		if withCustomer && row.CustomerName != "" {
			name := row.CustomerName
			v.Order.CustomerName = &name
		}
	}
	if row.ReversedPaymentReference != "" {
		reversed := row.ReversedPaymentReference
		v.ReversedPaymentReference = &reversed
	}
	if row.MovementReason != "" {
		reason := CashMovementReason(row.MovementReason)
		v.MovementReason = &reason
	}
	if row.CountID != nil {
		v.Count = &CashJournalCount{
			ID:             *row.CountID,
			Reference:      row.CountReference,
			CountedAmount:  money(row.CountedAmount),
			ExpectedAmount: money(row.ExpectedAmount),
			Difference:     money(row.Difference),
		}
		if row.CountReason != nil {
			reason := CashCountReason(*row.CountReason)
			v.Count.Reason = &reason
		}
	}
	return v
}

// journalDays gives the opening and closing balance of every day the entries fall on, in the order they appear.
func (s *Service) journalDays(ctx context.Context, q *db.Queries, entries []CashJournalEntry) ([]CashJournalDay, error) {
	result := []CashJournalDay{}
	if len(entries) == 0 {
		return result, nil
	}
	first, last := entries[0].OccurredAt, entries[0].OccurredAt
	for _, entry := range entries {
		if entry.OccurredAt.Before(first) {
			first = entry.OccurredAt
		}
		if entry.OccurredAt.After(last) {
			last = entry.OccurredAt
		}
	}
	start := s.startOfDay(first.In(s.location))
	end := s.startOfDay(last.In(s.location).AddDate(0, 0, 1))
	opening, err := cashFiguresUntil(ctx, q, &start)
	if err != nil {
		return nil, err
	}
	totals, err := q.CashJournalDayTotals(ctx, db.CashJournalDayTotalsParams{
		TimeZone: s.location.String(),
		FromTime: start,
		ToTime:   end,
	})
	if err != nil {
		return nil, err
	}
	balance := opening.expected()
	byDay := map[string]CashJournalDay{}
	for _, total := range totals {
		cashIn, cashOut := d(total.CashIn), d(total.CashOut)
		closing := balance.Add(cashIn).Sub(cashOut)
		byDay[total.Day] = CashJournalDay{
			Date:           total.Day,
			OpeningBalance: balance.StringFixed(2),
			ClosingBalance: closing.StringFixed(2),
			CashIn:         cashIn.StringFixed(2),
			CashOut:        cashOut.StringFixed(2),
		}
		balance = closing
	}
	seen := map[string]bool{}
	for _, entry := range entries {
		if seen[entry.Day] {
			continue
		}
		seen[entry.Day] = true
		if day, ok := byDay[entry.Day]; ok {
			result = append(result, day)
		}
	}
	return result, nil
}

func journalFacts(row db.CashJournalFactsRow) CashJournalFacts {
	cashIn, cashOut := d(row.CashIn), d(row.CashOut)
	return CashJournalFacts{
		CashIn:         cashIn.StringFixed(2),
		CashInEntries:  row.CashInEntries,
		Receipts:       row.Receipts,
		Deposits:       row.Deposits,
		CashOut:        cashOut.StringFixed(2),
		CashOutEntries: row.CashOutEntries,
		Refunds:        row.Refunds,
		Corrections:    row.Corrections,
		Withdrawals:    row.Withdrawals,
		Net:            cashIn.Sub(cashOut).StringFixed(2),
		Counts:         row.Counts,
	}
}

func kindTexts(kinds []CashJournalKind) ([]string, error) {
	result := make([]string, 0, len(kinds))
	for _, kind := range kinds {
		if !validJournalKind(kind) {
			return nil, apperror.Invalid("Unsupported cash journal kind")
		}
		result = append(result, string(kind))
	}
	return result, nil
}

// CashJournal lists the register's entries with running balances, the balances of the days on the page, the
// expected cash at the end of the range with its derivation and what happened in the range.
func (s *Service) CashJournal(ctx context.Context, p authorization.Principal, query CashJournalQuery) (CashJournal, error) {
	if err := require(p, authorization.PaymentsRead, authorization.CashMovementsRead); err != nil {
		return CashJournal{}, err
	}
	limit, offset, err := pageBounds(query.Page, query.Size)
	if err != nil {
		return CashJournal{}, err
	}
	span, err := s.days(query.From, query.To)
	if err != nil {
		return CashJournal{}, err
	}
	kinds, err := kindTexts(query.Kinds)
	if err != nil {
		return CashJournal{}, err
	}
	search := strings.TrimSpace(query.Search)
	if len(search) > MaxCashJournalSearchLength {
		return CashJournal{}, apperror.Invalid("The search can have up to 200 characters")
	}
	// Customer names are order data: without orders.read they are neither shown nor searchable.
	withCustomer := p.Has(authorization.OrdersRead)
	result := CashJournal{
		From:     formatDay(query.From),
		To:       formatDay(query.To),
		Items:    []CashJournalEntry{},
		Page:     int64(query.Page),
		PageSize: int64(query.Size),
	}
	err = s.readOnly(ctx, func(q *db.Queries) error {
		params := db.ListCashJournalParams{
			Search:       search,
			WithCustomer: withCustomer,
			NewestFirst:  query.NewestFirst,
			PageOffset:   offset,
			PageLimit:    limit,
			ToTime:       nullableTime(span.to),
			FromTime:     nullableTime(span.from),
			Kinds:        kinds,
		}
		rows, e := q.ListCashJournal(ctx, params)
		if e != nil {
			return e
		}
		if len(rows) == 0 && offset > 0 {
			// Past the last page: ask for the first entry only to learn the total.
			params.PageOffset, params.PageLimit = 0, 1
			first, e := q.ListCashJournal(ctx, params)
			if e != nil {
				return e
			}
			if len(first) > 0 {
				result.Total = first[0].Total
			}
		}
		for _, row := range rows {
			result.Total = row.Total
			result.Items = append(result.Items, s.journalEntry(row, withCustomer))
		}
		if result.Days, e = s.journalDays(ctx, q, result.Items); e != nil {
			return e
		}
		result.OpeningBalance = "0.00"
		if span.from != nil {
			opening, e := cashFiguresUntil(ctx, q, span.from)
			if e != nil {
				return e
			}
			result.OpeningBalance = opening.expected().StringFixed(2)
		}
		closing, e := cashFiguresUntil(ctx, q, span.to)
		if e != nil {
			return e
		}
		result.Register = closing.register()
		if span.to != nil {
			end := span.to.UTC()
			result.Register.To = &end
		}
		if result.Register.LastCount, e = s.latestCashCount(ctx, q, span.to); e != nil {
			return e
		}
		facts, e := q.CashJournalFacts(ctx, db.CashJournalFactsParams{
			FromTime: nullableTime(span.from),
			ToTime:   nullableTime(span.to),
		})
		if e != nil {
			return e
		}
		result.Facts = journalFacts(facts)
		return nil
	})
	return result, err
}
