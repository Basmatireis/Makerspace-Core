package orders

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/orders/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/shopspring/decimal"
)

// CashbookContents says what a cashbook export covers.
type CashbookContents string

const (
	// CashbookCashRegister is the cash register with its balance carried forward; it replaces the handwritten
	// cashbook (Kassabuch).
	CashbookCashRegister CashbookContents = "cash_register"
	// CashbookAllPayments adds card and external (wiRef) payments, without a balance.
	CashbookAllPayments CashbookContents = "all_payments"
)

// CashbookFormat is the file format of a cashbook export.
type CashbookFormat string

const (
	CashbookPDF CashbookFormat = "pdf"
	CashbookCSV CashbookFormat = "csv"
)

// MaxCashbookExportEntries bounds one export; a business year of the makerspace stays far below it.
const MaxCashbookExportEntries = 5000

// CashbookExportQuery selects the whole days From through To (makerspace time zone).
type CashbookExportQuery struct {
	From, To time.Time
	Contents CashbookContents
	Format   CashbookFormat
}

// CashbookFile is a rendered export.
type CashbookFile struct {
	Filename    string
	ContentType string
	Data        []byte
}

// cashbookLine is one money entry of the cashbook.
type cashbookLine struct {
	at             time.Time
	reference      string
	kind           CashJournalKind
	method         PaymentMethod
	effect         decimal.Decimal
	balance        decimal.Decimal
	orderReference string
	customer       string
	paymentReason  string
	movementReason CashMovementReason
	note           string
	countReference string
	countReason    CashCountReason
	recordedBy     string
}

// cashbook is everything an export shows.
type cashbook struct {
	from, to    time.Time
	contents    CashbookContents
	lines       []cashbookLine
	opening     decimal.Decimal
	totalIn     decimal.Decimal
	totalOut    decimal.Decimal
	closing     decimal.Decimal
	location    *time.Location
	withBalance bool
}

func (b cashbook) amounts(line cashbookLine) (in, out decimal.Decimal) {
	if line.effect.IsNegative() {
		return decimal.Zero, line.effect.Neg()
	}
	return line.effect, decimal.Zero
}

// ExportCashbook renders the cashbook of whole days as PDF (the HTU Kassabuch sheet) or CSV. Customer names are
// order data and appear only for people with orders.read.
func (s *Service) ExportCashbook(
	ctx context.Context,
	p authorization.Principal,
	query CashbookExportQuery,
) (CashbookFile, error) {
	if err := require(p, authorization.PaymentsRead, authorization.CashMovementsRead); err != nil {
		return CashbookFile{}, err
	}
	if query.Contents != CashbookCashRegister && query.Contents != CashbookAllPayments {
		return CashbookFile{}, apperror.Invalid("Unsupported cashbook contents")
	}
	if query.Format != CashbookPDF && query.Format != CashbookCSV {
		return CashbookFile{}, apperror.Invalid("Unsupported cashbook format")
	}
	if query.From.IsZero() || query.To.IsZero() {
		return CashbookFile{}, apperror.Invalid("The first and the last day are required")
	}
	span, err := s.days(&query.From, &query.To)
	if err != nil {
		return CashbookFile{}, err
	}
	book := cashbook{
		from:        query.From,
		to:          query.To,
		contents:    query.Contents,
		location:    s.location,
		withBalance: query.Contents == CashbookCashRegister,
	}
	withCustomer := p.Has(authorization.OrdersRead)
	err = s.readOnly(ctx, func(q *db.Queries) error {
		rows, e := q.ListCashbookEntries(ctx, db.ListCashbookEntriesParams{
			RowLimit: MaxCashbookExportEntries + 1,
			CashOnly: book.withBalance,
			FromTime: *span.from,
			ToTime:   *span.to,
		})
		if e != nil {
			return e
		}
		if len(rows) > MaxCashbookExportEntries {
			return apperror.New(
				http.StatusUnprocessableEntity,
				"cashbook_export_too_large",
				"The period has too many entries for one export; choose a shorter period",
			)
		}
		if book.withBalance {
			opening, e := cashFiguresUntil(ctx, q, span.from)
			if e != nil {
				return e
			}
			book.opening = opening.expected()
		}
		balance := book.opening
		for _, row := range rows {
			line := cashbookLine{
				at:             row.OccurredAt,
				reference:      row.Reference,
				kind:           CashJournalKind(row.Kind),
				method:         PaymentMethod(row.Method),
				effect:         d(row.Effect),
				orderReference: row.OrderReference,
				paymentReason:  row.PaymentReason,
				movementReason: CashMovementReason(row.MovementReason),
				note:           row.Note,
				countReference: row.CountReference,
				recordedBy:     row.RecordedByName,
			}
			if withCustomer {
				line.customer = row.CustomerName
			}
			if row.CountReason != nil {
				line.countReason = CashCountReason(*row.CountReason)
			}
			balance = balance.Add(line.effect)
			line.balance = balance
			in, out := book.amounts(line)
			book.totalIn, book.totalOut = book.totalIn.Add(in), book.totalOut.Add(out)
			book.lines = append(book.lines, line)
		}
		book.closing = balance
		return nil
	})
	if err != nil {
		return CashbookFile{}, err
	}
	name := fmt.Sprintf(
		"cashbook-%s-%s-%s",
		strings.ReplaceAll(string(query.Contents), "_", "-"),
		query.From.Format(dayLayout),
		query.To.Format(dayLayout),
	)
	if query.Format == CashbookCSV {
		return CashbookFile{Filename: name + ".csv", ContentType: "text/csv; charset=utf-8", Data: book.csv()}, nil
	}
	data, err := renderCashbookPDF(book)
	if err != nil {
		return CashbookFile{}, err
	}
	return CashbookFile{Filename: name + ".pdf", ContentType: "application/pdf", Data: data}, nil
}

var (
	movementReasonGerman = map[CashMovementReason]string{
		CashReasonBankDeposit:     "Bankeinzahlung",
		CashReasonSafe:            "Tresor",
		CashReasonFloat:           "Wechselgeld",
		CashReasonOther:           "Sonstiges",
		CashReasonCountDifference: "Zählungsdifferenz",
	}
	movementReasonEnglish = map[CashMovementReason]string{
		CashReasonBankDeposit:     "Bank deposit",
		CashReasonSafe:            "Moved to safe",
		CashReasonFloat:           "Change float",
		CashReasonOther:           "Other",
		CashReasonCountDifference: "Count difference",
	}
	countReasonGerman = map[CashCountReason]string{
		CountReasonCountingError:      "Zählfehler",
		CountReasonChangeGivenWrong:   "Falsches Wechselgeld",
		CountReasonReceiptNotRecorded: "Einnahme nicht erfasst",
		CountReasonUnknown:            "Unbekannt",
		CountReasonOther:              "Sonstiges",
	}
	countReasonEnglish = map[CashCountReason]string{
		CountReasonCountingError:      "Counting error",
		CountReasonChangeGivenWrong:   "Change given wrong",
		CountReasonReceiptNotRecorded: "Receipt not recorded",
		CountReasonUnknown:            "Unknown",
		CountReasonOther:              "Other",
	}
	methodGerman  = map[PaymentMethod]string{PaymentCash: "Bar", PaymentCard: "Karte", PaymentExternal: "Rechnung wiRef"}
	methodEnglish = map[PaymentMethod]string{PaymentCash: "cash", PaymentCard: "card", PaymentExternal: "wiRef invoice"}
)

type cashbookWords struct {
	receipt, refund, correction, withdrawal, deposit string
	movementReasons                                  map[CashMovementReason]string
	countReasons                                     map[CashCountReason]string
	methods                                          map[PaymentMethod]string
}

var (
	germanWords = cashbookWords{
		receipt: "Einnahme", refund: "Rückzahlung", correction: "Korrektur", withdrawal: "Entnahme", deposit: "Einlage",
		movementReasons: movementReasonGerman, countReasons: countReasonGerman, methods: methodGerman,
	}
	englishWords = cashbookWords{
		receipt: "Receipt", refund: "Refund", correction: "Correction", withdrawal: "Withdrawal", deposit: "Deposit",
		movementReasons: movementReasonEnglish, countReasons: countReasonEnglish, methods: methodEnglish,
	}
)

func joinParts(parts ...string) string {
	kept := parts[:0]
	for _, part := range parts {
		if part = strings.TrimSpace(part); part != "" {
			kept = append(kept, part)
		}
	}
	return strings.Join(kept, " · ")
}

// describe is the text of a cashbook line, e.g. "Einnahme O-2026-000012 · Name" or "Entnahme · Tresor · note".
func (w cashbookWords) describe(line cashbookLine, withMethod bool) string {
	var text string
	switch {
	case line.kind == JournalReceipt:
		text = joinParts(w.receipt+" "+line.orderReference, line.customer)
	case line.kind == JournalRefund:
		text = joinParts(w.refund+" "+line.orderReference, line.paymentReason)
	case line.kind == JournalCorrection && line.countReference != "":
		text = joinParts(
			w.correction,
			w.movementReasons[CashReasonCountDifference]+" "+line.countReference,
			w.countReasons[line.countReason],
			line.note,
		)
	case line.kind == JournalCorrection:
		text = joinParts(w.correction+" "+line.orderReference, line.paymentReason)
	case line.kind == JournalWithdrawal:
		text = joinParts(w.withdrawal, w.movementReasons[line.movementReason], line.note)
	default:
		text = joinParts(w.deposit, w.movementReasons[line.movementReason], line.note)
	}
	if withMethod {
		text += " (" + w.methods[line.method] + ")"
	}
	return text
}

// germanAmount writes 1234.5 as 1.234,50.
func germanAmount(v decimal.Decimal) string {
	text := v.Abs().StringFixed(2)
	whole, fraction, _ := strings.Cut(text, ".")
	var grouped strings.Builder
	for i, digit := range whole {
		if i > 0 && (len(whole)-i)%3 == 0 {
			grouped.WriteByte('.')
		}
		grouped.WriteRune(digit)
	}
	sign := ""
	if v.IsNegative() {
		sign = "-"
	}
	return sign + grouped.String() + "," + fraction
}

// csvAmount writes 1234.5 as 1234,50: spreadsheets set to German read it as a number.
func csvAmount(v decimal.Decimal) string {
	return strings.Replace(v.StringFixed(2), ".", ",", 1)
}

var (
	csvFormula     = regexp.MustCompile(`^[=+\-@\t\r]`)
	csvPlainNumber = regexp.MustCompile(`^-?[0-9]+([.,][0-9]+)?$`)
)

// csvCell quotes cells with separators and defuses text a spreadsheet would run as a formula.
func csvCell(value string) string {
	if csvFormula.MatchString(value) && !csvPlainNumber.MatchString(value) {
		value = "'" + value
	}
	if strings.ContainsAny(value, "\";\r\n") {
		value = `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
	}
	return value
}

// csv writes the semicolon-separated cashbook with a UTF-8 byte order mark, so Excel opens it with umlauts and in
// columns. The cash register has a balance column and starts with the opening balance.
func (b cashbook) csv() []byte {
	var out bytes.Buffer
	out.WriteString("\xef\xbb\xbf") // UTF-8 byte order mark
	write := func(cells ...string) {
		for i, cell := range cells {
			if i > 0 {
				out.WriteByte(';')
			}
			out.WriteString(csvCell(cell))
		}
		out.WriteString("\r\n")
	}
	header := []string{"Date", "Reference", "Description", "In", "Out"}
	if b.withBalance {
		header = append(header, "Balance")
		write(header...)
		write(b.from.Format("02.01.2006"), "", "Opening balance", "", "", csvAmount(b.opening))
	} else {
		write(header...)
	}
	for _, line := range b.lines {
		in, out := b.amounts(line)
		cells := []string{
			line.at.In(b.location).Format("02.01.2006"),
			line.reference,
			englishWords.describe(line, !b.withBalance),
			optionalAmount(in, csvAmount),
			optionalAmount(out, csvAmount),
		}
		if b.withBalance {
			cells = append(cells, csvAmount(line.balance))
		}
		write(cells...)
	}
	return out.Bytes()
}

func optionalAmount(v decimal.Decimal, format func(decimal.Decimal) string) string {
	if v.IsZero() {
		return ""
	}
	return format(v)
}
