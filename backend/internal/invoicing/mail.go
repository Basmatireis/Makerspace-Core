package invoicing

import (
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifications"
	"github.com/shopspring/decimal"
)

// details are the labelled facts of a document, in reading order. The mail table and the PDF show the same list;
// the toggles of the settings decide which optional ones appear. Line items are separate.
type detail struct{ Label, Value string }

func (d Document) details(s Settings) []detail {
	var out []detail
	add := func(label, value string) {
		if strings.TrimSpace(value) != "" {
			out = append(out, detail{label, value})
		}
	}
	add("Recipient", d.Organisation)
	add("Address", strings.Join(d.AddressLines, ", "))
	if s.ShowContactPerson {
		contact := d.ContactName
		if d.ContactChannel != "" && contact != "" {
			contact += " (" + d.ContactChannel + ")"
		} else if contact == "" {
			contact = d.ContactChannel
		}
		add("Contact person", contact)
	}
	if s.ShowPurchaseOrder {
		add("Purchase order reference", d.PurchaseOrderReference)
	}
	add("Invoice request", d.RequestNumber)
	add("Order", d.OrderNumber)
	if s.ShowServicePeriod {
		add("Service period", d.servicePeriod())
	}
	if s.ShowServiceDescription {
		add("Service", d.ServiceDescription)
	}
	return out
}

// totals are the closing lines of the item list.
func (d Document) totals() []detail {
	var out []detail
	if d.hasPrepayment() {
		out = append(out,
			detail{"Order total", formatAmount(d.Total)},
			detail{"Already paid", "-" + formatAmount(d.AlreadyPaid)},
		)
	}
	return append(out, detail{"Amount to invoice", formatAmount(d.amountToInvoice().StringFixed(2))})
}

func (d Document) approval(s Settings) []detail {
	var out []detail
	if s.ShowApprover && d.Approver != "" {
		out = append(out, detail{"Approved by", d.Approver})
	}
	if date := formatDate(d.ApprovedAt); date != "" {
		out = append(out, detail{"Approved on", date})
	}
	return out
}

func trimNumber(value string) string {
	if parsed, err := decimal.NewFromString(value); err == nil {
		return parsed.String()
	}
	return value
}

func (i Item) quantityText() string {
	quantity := trimNumber(i.Quantity)
	if i.Unit != "" {
		quantity += " " + i.Unit
	}
	return quantity
}

// paragraphs splits a template text at blank lines.
func paragraphs(text string) []string {
	var out []string
	for _, p := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n\n") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// renderTexts substitutes the placeholders of the mail templates.
func (s Settings) renderTexts(d Document) (subject, heading string, intro []string, closing string) {
	values := d.values(s)
	subject = singleLine(Substitute(s.MailSubject, values))
	heading = singleLine(Substitute(s.PDFTitle, values))
	intro = paragraphs(Substitute(s.MailIntro, values))
	closing = strings.Join(paragraphs(Substitute(s.MailClosing, values)), " ")
	return subject, heading, intro, closing
}

// MailContent builds the branded mail body for a document.
func (s Settings) MailContent(d Document) (subject string, content notifications.Content) {
	subject, heading, intro, closing := s.renderTexts(d)
	content = notifications.Content{Heading: heading, Paragraphs: intro, Footnote: closing}
	for _, row := range d.details(s) {
		content.Rows = append(content.Rows, notifications.Row{Label: row.Label, Value: row.Value})
	}
	for _, item := range d.Items {
		var value string
		if item.UnitPrice != "" {
			value = item.quantityText() + " x " + formatPlain(item.UnitPrice) + " = " + formatPlain(item.Amount)
		} else {
			value = formatPlain(item.Amount)
		}
		content.Rows = append(content.Rows, notifications.Row{Label: item.Description, Value: value})
	}
	for _, row := range append(d.totals(), d.approval(s)...) {
		content.Rows = append(content.Rows, notifications.Row{Label: row.Label, Value: row.Value})
	}
	return subject, content
}
