package invoicing

import (
	"context"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/engine"
	"github.com/shopspring/decimal"
)

// PDFRenderer renders the effective wiRef template (the published version, or the built-in default). The PDF
// template service implements it; tests use the built-in default.
type PDFRenderer interface {
	RenderEffective(
		ctx context.Context,
		kind engine.Kind,
		data engine.Data,
		can func(permission string) bool,
	) (pdf []byte, filename string, err error)
}

// decimalOrZero reads an amount as the order stored it; an unreadable one counts as zero.
func decimalOrZero(value string) decimal.Decimal {
	parsed, err := decimal.NewFromString(value)
	if err != nil {
		return decimal.Zero
	}
	return parsed
}

// flag is a "show" value of the wiRef schema: "true" for switched on, empty for off, so templates test it with a
// condition.
func flag(on bool) string {
	if on {
		return "true"
	}
	return ""
}

// servicePeriodDays is the first and the last day of the service period as the wiRef schema has them: the last day
// is empty when the period is a single day or only one day is known.
func (d Document) servicePeriodDays() (from, to string) {
	from, to = d.ServiceStartsOn, d.ServiceEndsOn
	if from == "" {
		from, to = to, ""
	}
	if to == from {
		to = ""
	}
	return from, to
}

// text keeps the paragraphs of a template text, separated by one blank line each.
func text(value string) string { return strings.Join(paragraphs(value), "\n\n") }

// PDFData is the data of the wiRef template for a document: the values of the document, the PDF texts of the
// settings with their placeholders filled in, and which optional parts the settings show. The paths are those of
// the wiRef schema of the template engine.
func (d Document) PDFData(s Settings) engine.Data {
	values := d.values(s)
	from, to := d.servicePeriodDays()
	var approvedAt any
	if !d.ApprovedAt.IsZero() {
		approvedAt = d.ApprovedAt
	}
	items := make([]map[string]any, 0, len(d.Items))
	for _, item := range d.Items {
		items = append(items, map[string]any{
			"description": item.Description,
			"quantity":    decimalOrZero(item.Quantity),
			"unit":        unitSymbol(item.Unit),
			"unitPrice":   decimalOrZero(item.UnitPrice),
			"amount":      decimalOrZero(item.Amount),
		})
	}
	payments := make([]map[string]any, 0, len(d.Payments))
	for _, payment := range d.Payments {
		payments = append(payments, map[string]any{
			"reference": payment.Reference,
			"method":    payment.Method,
			"paidAt":    payment.PaidAt,
			"amount":    decimalOrZero(payment.Amount),
		})
	}
	addressLines := d.AddressLines
	if addressLines == nil {
		addressLines = []string{}
	}
	return engine.Data{
		"request": map[string]any{
			"number":             d.RequestNumber,
			"orderNumber":        d.OrderNumber,
			"approvedAt":         approvedAt,
			"approver":           d.Approver,
			"servicePeriod":      map[string]any{"from": from, "to": to},
			"serviceDescription": d.ServiceDescription,
		},
		"recipient": map[string]any{
			"organization":           d.Organisation,
			"addressLines":           addressLines,
			"contactName":            d.ContactName,
			"contactChannel":         d.ContactChannel,
			"purchaseOrderReference": d.PurchaseOrderReference,
		},
		"amounts": map[string]any{
			"total":       decimalOrZero(d.Total),
			"alreadyPaid": decimalOrZero(d.AlreadyPaid),
			"toInvoice":   d.amountToInvoice(),
		},
		"texts": map[string]any{
			"title":   singleLine(Substitute(s.PDFTitle, values)),
			"intro":   text(Substitute(s.PDFIntro, values)),
			"closing": text(Substitute(s.PDFClosing, values)),
		},
		"show": map[string]any{
			"contactPerson":      flag(s.ShowContactPerson),
			"approver":           flag(s.ShowApprover),
			"purchaseOrder":      flag(s.ShowPurchaseOrder),
			"servicePeriod":      flag(s.ShowServicePeriod),
			"serviceDescription": flag(s.ShowServiceDescription),
		},
		"items":    items,
		"payments": payments,
	}
}

// UnitSymbol is how a stored unit reads on a document: the codes for squares and pieces become their symbols, every
// other unit (including a count label such as "sheet") stays as it is.
func UnitSymbol(unit string) string { return unitSymbol(unit) }
