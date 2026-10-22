package invoicing

import (
	"strings"
	"time"

	"github.com/shopspring/decimal"
)

// Item is one invoiced line. Amounts are decimal strings as stored by the order.
type Item struct {
	Description string
	Quantity    string
	Unit        string
	UnitPrice   string
	Amount      string
}

// Payment is one payment that counts towards the order: a cash or card receipt, or the settlement by this
// invoice. Amount is what the payment contributes to the order, as a decimal string.
type Payment struct {
	Reference string
	Method    string
	PaidAt    time.Time
	Amount    string
}

// Document is everything the mail and the PDF show about one approved invoice request. The orders package fills
// it; the settings decide which optional parts are rendered.
type Document struct {
	Organisation           string
	AddressLines           []string
	ContactName            string
	ContactChannel         string
	PurchaseOrderReference string
	RequestNumber          string
	OrderNumber            string
	Items                  []Item
	Total                  string
	AlreadyPaid            string
	Payments               []Payment
	ServiceStartsOn        string
	ServiceEndsOn          string
	ServiceDescription     string
	Approver               string
	ApprovedAt             time.Time
}

// amountToInvoice is the order total minus what was already paid in cash or by card.
func (d Document) amountToInvoice() decimal.Decimal {
	total, err := decimal.NewFromString(d.Total)
	if err != nil {
		return decimal.Zero
	}
	if paid, err := decimal.NewFromString(d.AlreadyPaid); err == nil {
		total = total.Sub(paid)
	}
	return total
}

func (d Document) hasPrepayment() bool {
	paid, err := decimal.NewFromString(d.AlreadyPaid)
	return err == nil && paid.IsPositive()
}

// values are the placeholder values. A switched-off optional field yields an empty value, so a template that
// mentions it still reads sensibly.
func (d Document) values(s Settings) map[string]string {
	values := map[string]string{
		"organization":      d.Organisation,
		"request_number":    d.RequestNumber,
		"order_number":      d.OrderNumber,
		"amount_to_invoice": formatAmount(d.amountToInvoice().StringFixed(2)),
		"approved_on":       formatDate(d.ApprovedAt),
	}
	if s.ShowContactPerson {
		values["contact_person"] = d.ContactName
	}
	if s.ShowPurchaseOrder {
		values["purchase_order_reference"] = d.PurchaseOrderReference
	}
	if s.ShowApprover {
		values["approved_by"] = d.Approver
	}
	for _, p := range Placeholders {
		if _, ok := values[p.Name]; !ok {
			values[p.Name] = ""
		}
	}
	return values
}

// formatAmount renders a decimal string such as 1234.5 as "EUR 1,234.50".
func formatAmount(amount string) string {
	value, err := decimal.NewFromString(amount)
	if err != nil {
		return "EUR " + amount
	}
	fixed := value.Abs().StringFixed(2)
	whole, fraction, _ := strings.Cut(fixed, ".")
	var grouped strings.Builder
	for i, digit := range whole {
		if i > 0 && (len(whole)-i)%3 == 0 {
			grouped.WriteByte(',')
		}
		grouped.WriteRune(digit)
	}
	sign := ""
	if value.IsNegative() {
		sign = "-"
	}
	return sign + "EUR " + grouped.String() + "." + fraction
}

// formatPlain is formatAmount without the currency, for table cells whose header names it.
func formatPlain(amount string) string {
	return strings.TrimPrefix(strings.TrimPrefix(formatAmount(amount), "-EUR "), "EUR ")
}

var viennaLocation = func() *time.Location {
	location, err := time.LoadLocation("Europe/Vienna")
	if err != nil {
		return time.FixedZone("Europe/Vienna", 60*60)
	}
	return location
}()

func formatDate(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.In(viennaLocation).Format("02.01.2006")
}

func formatISODate(iso string) string {
	t, err := time.Parse("2006-01-02", iso)
	if err != nil {
		return iso
	}
	return t.Format("02.01.2006")
}

// servicePeriod renders the optional service period, or "" when none is known.
func (d Document) servicePeriod() string {
	switch {
	case d.ServiceStartsOn != "" && d.ServiceEndsOn != "" && d.ServiceStartsOn != d.ServiceEndsOn:
		return formatISODate(d.ServiceStartsOn) + " to " + formatISODate(d.ServiceEndsOn)
	case d.ServiceStartsOn != "":
		return formatISODate(d.ServiceStartsOn)
	default:
		return formatISODate(d.ServiceEndsOn)
	}
}

// SampleDocument is the fictitious invoice used by previews and test mails.
func SampleDocument(now time.Time) Document {
	return Document{
		Organisation:           "Example University, Institute of Sample Studies",
		AddressLines:           []string{"Samplegasse 1", "8010 Graz", "AT"},
		ContactName:            "Alex Example",
		ContactChannel:         "alex.example@example.org",
		PurchaseOrderReference: "PO-2026-0042",
		RequestNumber:          "W-2026-000123",
		OrderNumber:            "O-2026-000456",
		Items: []Item{
			{Description: "3D print, PLA, 120 g", Quantity: "1", Unit: "pc", UnitPrice: "12.00", Amount: "12.00"},
			{Description: "Laser cutting, 3 mm plywood", Quantity: "2.5", Unit: "h", UnitPrice: "24.00", Amount: "60.00"},
			{Description: "Material: plywood sheet", Quantity: "1", Unit: "pc", UnitPrice: "9.50", Amount: "9.50"},
		},
		Total:              "81.50",
		AlreadyPaid:        "0.00",
		Payments:           []Payment{{Reference: "P-2026-000789", Method: "wiRef invoice", PaidAt: now, Amount: "81.50"}},
		ServiceStartsOn:    "2026-10-01",
		ServiceEndsOn:      "2026-10-15",
		ServiceDescription: "Prototype parts for the sample project.",
		Approver:           "Sam Approver",
		ApprovedAt:         now,
	}
}
