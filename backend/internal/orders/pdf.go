package orders

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/invoicing"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/orders/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/engine"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

// PDFRenderer renders the effective template of an export (the published version, or the built-in default). The
// PDF template service implements it; without one the built-in defaults are used.
type PDFRenderer interface {
	RenderEffective(
		ctx context.Context,
		kind engine.Kind,
		data engine.Data,
		can func(permission string) bool,
	) (pdf []byte, filename string, err error)
}

// WithPDFTemplates makes the cashbook and receipt PDFs follow the published templates and show the branding logo.
func (s *Service) WithPDFTemplates(renderer PDFRenderer) *Service {
	s.pdf = renderer
	return s
}

// principalCan is the permission test of the renderer for a signed-in reader.
func principalCan(p authorization.Principal) func(string) bool {
	return func(permission string) bool { return p.Has(authorization.Permission(permission)) }
}

// PDFSource is one real record a template preview can render.
type PDFSource struct {
	ID    string
	Label string
}

// maxPreviewRecords bounds how many recent records a preview offers.
const maxPreviewRecords = 10

// The Kassabuch form is the HTU Graz cashbook; its head block names the unit the cash register belongs to.
const (
	cashbookOrganization = "HTU Graz"
	cashbookUnit         = "Makerspace (Studienlabor)"
	// cashbookAllPayments is shown behind the period when the export covers every payment method.
	cashbookAllPayments = "alle Zahlungen"
)

// businessYear is the year of the period, or both years when it spans a year change ("2026/27").
func (b cashbook) businessYear() string {
	year := strconv.Itoa(b.from.Year())
	if b.to.Year() != b.from.Year() {
		year += fmt.Sprintf("/%02d", b.to.Year()%100)
	}
	return year
}

// kindLabel is how a cashbook line reads in the first column of its text.
func (w cashbookWords) kindLabel(kind CashJournalKind) string {
	switch kind {
	case JournalReceipt:
		return w.receipt
	case JournalRefund:
		return w.refund
	case JournalCorrection:
		return w.correction
	case JournalWithdrawal:
		return w.withdrawal
	}
	return w.deposit
}

// hasOrder says whether the text of a line names what its order charged.
func hasOrder(line cashbookLine) bool {
	switch line.kind {
	case JournalReceipt, JournalRefund:
		return true
	case JournalCorrection:
		return line.countReference == ""
	}
	return false
}

// pdfData is the data of the cashbook template, per the cashbook schema of the template engine. Order data (the
// customer and what the order charged) is included only when the reader may see it. Texts are German, as on the
// Kassabuch form.
func (b cashbook) pdfData() engine.Data {
	contents := ""
	if !b.withBalance {
		contents = cashbookAllPayments
	}
	lines := make([]map[string]any, 0, len(b.lines))
	for i, line := range b.lines {
		in, out := b.amounts(line)
		// The text is the description as on the paper form; the order summary and the customer are fields of
		// their own that a template places where it wants them.
		described := line
		described.customer, described.contents = "", orderContents{}
		entry := map[string]any{
			"no":             i + 1,
			"date":           line.at.In(b.location).Format(dayLayout),
			"cashier":        line.recordedBy,
			"kind":           germanWords.kindLabel(line.kind),
			"text":           germanWords.describe(described, false, MaxKassabuchSummaryLength),
			"orderReference": line.orderReference,
			"orderSummary":   "",
			"customer":       "",
			"method":         germanWords.methods[line.method],
			"receiptNumber":  line.reference,
			"in":             in,
			"out":            out,
			"balance":        line.balance,
		}
		if b.withOrders {
			entry["customer"] = line.customer
			if hasOrder(line) {
				entry["orderSummary"] = germanWords.summary(line.contents, MaxKassabuchSummaryLength)
			}
		}
		lines = append(lines, entry)
	}
	// Without the cash register there is no balance, so the balance figures stay empty.
	var opening, closing any
	if b.withBalance {
		opening, closing = b.opening, b.closing
	}
	return engine.Data{
		"period": map[string]any{
			"from":         b.from.Format(dayLayout),
			"to":           b.to.Format(dayLayout),
			"businessYear": b.businessYear(),
			"contents":     contents,
			"kind":         strings.ReplaceAll(string(b.contents), "_", "-"),
		},
		"organization": map[string]any{"name": cashbookOrganization, "unit": cashbookUnit, "department": ""},
		"totals":       map[string]any{"opening": opening, "in": b.totalIn, "out": b.totalOut, "closing": closing},
		"lines":        lines,
	}
}

var cashbookMonthPattern = regexp.MustCompile(`^(\d{4})-(0[1-9]|1[0-2])$`)

// PreviewCashbooks lists the last three calendar months, the current one first, as sources for cashbook template
// previews. It needs the permissions of the export.
func (s *Service) PreviewCashbooks(ctx context.Context, p authorization.Principal) ([]PDFSource, error) {
	if err := require(p, authorization.PaymentsRead, authorization.CashMovementsRead); err != nil {
		return nil, err
	}
	month := s.startOfDay(time.Now().In(s.location))
	month = time.Date(month.Year(), month.Month(), 1, 0, 0, 0, 0, s.location)
	sources := make([]PDFSource, 0, 3)
	for range 3 {
		sources = append(sources, PDFSource{ID: month.Format("2006-01"), Label: month.Format("January 2006")})
		month = month.AddDate(0, -1, 0)
	}
	return sources, nil
}

// CashbookPDFData loads the cash register cashbook of a calendar month ("2026-10") in the data form of the
// cashbook template, for previews with a real record.
func (s *Service) CashbookPDFData(ctx context.Context, p authorization.Principal, id string) (engine.Data, error) {
	match := cashbookMonthPattern.FindStringSubmatch(id)
	if match == nil {
		return nil, apperror.NotFound
	}
	year, _ := strconv.Atoi(match[1])
	month, _ := strconv.Atoi(match[2])
	first := time.Date(year, time.Month(month), 1, 0, 0, 0, 0, time.UTC)
	book, err := s.loadCashbook(ctx, p, CashbookExportQuery{
		From: first, To: first.AddDate(0, 1, -1), Contents: CashbookCashRegister, Format: CashbookPDF,
	})
	if err != nil {
		return nil, err
	}
	return book.pdfData(), nil
}

// PreviewInvoiceRequests lists the newest approved (forwarded) wiRef requests as sources for wiRef template
// previews. It needs external_invoice_requests.read and orders.read: the document lists the order's payments,
// which the request API shows only to readers of orders.
func (s *Service) PreviewInvoiceRequests(ctx context.Context, p authorization.Principal) ([]PDFSource, error) {
	if err := require(p, authorization.ExternalInvoiceRequestsRead, authorization.OrdersRead); err != nil {
		return nil, err
	}
	rows, err := db.New(s.pool).ListRequests(ctx, db.ListRequestsParams{
		Status: string(InvoiceIssued), PageLimit: maxPreviewRecords,
	})
	if err != nil {
		return nil, fmt.Errorf("list invoice requests for previews: %w", err)
	}
	sources := make([]PDFSource, 0, len(rows))
	for _, row := range rows {
		sources = append(sources, PDFSource{ID: row.ID.String(), Label: row.Reference})
	}
	return sources, nil
}

// InvoiceRequestDocument returns an approved wiRef request as the document its PDF shows, for previews with a real
// record. A request that was not forwarded to wiRef has no PDF and is a 404. Like the listing it needs
// external_invoice_requests.read and orders.read.
func (s *Service) InvoiceRequestDocument(
	ctx context.Context,
	p authorization.Principal,
	id string,
) (invoicing.Document, error) {
	if err := require(p, authorization.ExternalInvoiceRequestsRead, authorization.OrdersRead); err != nil {
		return invoicing.Document{}, err
	}
	requestID, err := uuid.Parse(id)
	if err != nil {
		return invoicing.Document{}, apperror.NotFound
	}
	q := db.New(s.pool)
	request, err := s.loadRequest(ctx, q, requestID)
	if err != nil {
		return invoicing.Document{}, err
	}
	if request.State != InvoiceIssued {
		return invoicing.Document{}, apperror.NotFound
	}
	payments, err := q.InvoicePayments(ctx, request.OrderID)
	if err != nil {
		return invoicing.Document{}, fmt.Errorf("load invoice payments: %w", err)
	}
	return invoiceDocument(request, invoicePayments(payments)), nil
}

// ReceiptFile is a rendered receipt.
type ReceiptFile struct {
	Filename string
	Data     []byte
}

// receiptPayment is one payment that counts towards an order, with what it contributes to it.
type receiptPayment struct {
	id         uuid.UUID
	reference  string
	method     string
	occurredAt time.Time
	amount     decimal.Decimal
}

func methodLabel(method string) string {
	if label, ok := paymentMethodLabels[PaymentMethod(method)]; ok {
		return label
	}
	return method
}

// receiptData collects the data of the receipt template. Without one payment it covers every payment that counts;
// with one it is the receipt of that payment, whose variables are then set. The matriculation number is passed
// only for a reader who may see it.
func receiptData(
	order Order,
	payments []receiptPayment,
	only *receiptPayment,
	matriculation string,
) engine.Data {
	items := make([]map[string]any, 0, len(order.Items))
	total := decimal.Zero
	for _, item := range order.Items {
		if item.RemovedAt != nil {
			continue
		}
		amount := decimalOr(item.Amount)
		total = total.Add(amount)
		items = append(items, map[string]any{
			"description": item.Description,
			"detail":      itemDetail(item),
			"quantity":    decimalOr(item.Quantity),
			"unit":        invoicing.UnitSymbol(item.Unit),
			"unitPrice":   decimalOr(item.UnitPrice),
			"amount":      amount,
		})
	}
	shown := payments
	if only != nil {
		shown = []receiptPayment{*only}
	}
	listed := make([]map[string]any, 0, len(shown))
	paid := decimal.Zero
	for _, payment := range shown {
		paid = paid.Add(payment.amount)
		listed = append(listed, paymentData(payment))
	}
	customer := map[string]any{"name": customerLabel(order), "matriculationNumber": matriculation}
	single := map[string]any{"reference": "", "method": "", "paidAt": nil, "amount": nil}
	if only != nil {
		single = paymentData(*only)
	}
	return engine.Data{
		"order": map[string]any{
			"number":    order.Reference,
			"createdAt": order.CreatedAt,
			"customer":  customer,
			"total":     total,
			"paid":      paid,
			"open":      decimalOr(order.OutstandingAmount),
		},
		"payment":  single,
		"items":    items,
		"payments": listed,
	}
}

func paymentData(payment receiptPayment) map[string]any {
	return map[string]any{
		"reference": payment.reference,
		"method":    methodLabel(payment.method),
		"paidAt":    payment.occurredAt,
		"amount":    payment.amount,
	}
}

func decimalOr(value string) decimal.Decimal {
	parsed, err := decimal.NewFromString(value)
	if err != nil {
		return decimal.Zero
	}
	return parsed
}

// customerLabel is who the receipt is for, as the order page names the customer.
func customerLabel(order Order) string {
	switch {
	case order.CustomerName != nil && *order.CustomerName != "":
		return *order.CustomerName
	case order.CustomerKind == CustomerAnonymous:
		return "Anonymous sale"
	}
	return "Unnamed customer"
}

// itemDetail is the second line of an item: the machine and the duration of a job.
func itemDetail(item OrderItem) string {
	if item.Snapshot == nil {
		return ""
	}
	nanoseconds, err := strconv.ParseInt(item.Snapshot.DurationNanoseconds, 10, 64)
	if err != nil || nanoseconds <= 0 {
		return item.Snapshot.MachineName
	}
	minutes := int(time.Duration(nanoseconds).Round(time.Minute) / time.Minute)
	duration := fmt.Sprintf("%d min", minutes)
	if minutes >= 60 {
		duration = fmt.Sprintf("%d h %d min", minutes/60, minutes%60)
	}
	return joinParts(item.Snapshot.MachineName, duration)
}

// loadReceipt reads an order with the payments that count towards it. Only a finalized order with a settled amount
// has a receipt (409 receipt_not_available otherwise), like the print view.
func (s *Service) loadReceipt(
	ctx context.Context,
	q *db.Queries,
	orderID uuid.UUID,
) (Order, []receiptPayment, error) {
	order, err := s.load(ctx, q, orderID)
	if err != nil {
		return Order{}, nil, err
	}
	if order.Status != OrderFinalized || !decimalOr(order.SettledAmount).IsPositive() {
		return Order{}, nil, apperror.Conflicting(
			"receipt_not_available",
			"A receipt needs a finalized order with at least one payment that still counts",
		)
	}
	rows, err := q.ReceiptPayments(ctx, &orderID)
	if err != nil {
		return Order{}, nil, fmt.Errorf("load receipt payments: %w", err)
	}
	payments := make([]receiptPayment, 0, len(rows))
	for _, row := range rows {
		payments = append(payments, receiptPayment{
			id: row.ID, reference: row.Reference, method: row.Method, occurredAt: row.OccurredAt, amount: d(row.Amount),
		})
	}
	return order, payments, nil
}

// receiptPDFData builds the receipt data for an order, or for one of its payments.
func (s *Service) receiptPDFData(
	ctx context.Context,
	p authorization.Principal,
	orderID uuid.UUID,
	paymentID *uuid.UUID,
) (engine.Data, error) {
	q := db.New(s.pool)
	order, payments, err := s.loadReceipt(ctx, q, orderID)
	if err != nil {
		return nil, err
	}
	var only *receiptPayment
	if paymentID != nil {
		for i := range payments {
			if payments[i].id == *paymentID {
				only = &payments[i]
			}
		}
		if only == nil {
			return nil, apperror.NotFound
		}
	}
	matriculation := ""
	if p.Has(authorization.PeopleReadMatriculation) && order.Customer != nil && order.Customer.Kind == CustomerPerson {
		matriculation, err = q.GetPersonMatriculation(ctx, order.Customer.ID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("load matriculation number: %w", err)
		}
	}
	return receiptData(order, payments, only, matriculation), nil
}

// ReceiptPDF renders the receipt of a finalized order with a settled amount, or of one of its payments, with the
// effective receipt template. It needs orders.read; the customer's matriculation number is part of it only for a
// reader who also holds people.read.matriculation.
func (s *Service) ReceiptPDF(
	ctx context.Context,
	p authorization.Principal,
	orderID uuid.UUID,
	paymentID *uuid.UUID,
) (ReceiptFile, error) {
	if err := require(p, authorization.OrdersRead); err != nil {
		return ReceiptFile{}, err
	}
	data, err := s.receiptPDFData(ctx, p, orderID, paymentID)
	if err != nil {
		return ReceiptFile{}, err
	}
	pdf, filename, err := s.pdf.RenderEffective(ctx, engine.KindReceipt, data, principalCan(p))
	if err != nil {
		return ReceiptFile{}, err
	}
	return ReceiptFile{Filename: filename, Data: pdf}, nil
}

// PreviewReceipts lists the newest orders that have a receipt as sources for receipt template previews.
func (s *Service) PreviewReceipts(ctx context.Context, p authorization.Principal) ([]PDFSource, error) {
	if err := require(p, authorization.OrdersRead); err != nil {
		return nil, err
	}
	rows, err := db.New(s.pool).ListReceiptPreviewOrders(ctx, maxPreviewRecords)
	if err != nil {
		return nil, fmt.Errorf("list orders for receipt previews: %w", err)
	}
	sources := make([]PDFSource, 0, len(rows))
	for _, row := range rows {
		sources = append(sources, PDFSource{ID: row.ID.String(), Label: row.Reference})
	}
	return sources, nil
}

// ReceiptPDFData is the receipt data of an order for previews with a real record.
func (s *Service) ReceiptPDFData(ctx context.Context, p authorization.Principal, id string) (engine.Data, error) {
	if err := require(p, authorization.OrdersRead); err != nil {
		return nil, err
	}
	orderID, err := uuid.Parse(id)
	if err != nil {
		return nil, apperror.NotFound
	}
	return s.receiptPDFData(ctx, p, orderID, nil)
}
