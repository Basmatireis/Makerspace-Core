package invoicing

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifications"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/engine"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/pdftest"
	pdfread "github.com/ledongthuc/pdf"
)

func sampleTime() time.Time { return time.Date(2026, 10, 21, 10, 0, 0, 0, time.UTC) }

func defaultSettings() Settings {
	return Settings{
		Enabled:        true,
		RecipientEmail: "wiref@example.org",
		Templates: Templates{
			MailSubject:            "Invoice request {{request_number}} for {{organization}}",
			MailIntro:              "Approved on {{approved_on}}.\n\nPlease invoice {{organization}}.",
			MailClosing:            "Thanks.",
			PDFTitle:               "Invoice request {{request_number}}",
			PDFIntro:               "Please invoice {{organization}} ({{purchase_order_reference}}).",
			PDFClosing:             "Approved by {{approved_by}} on {{approved_on}}.",
			ShowContactPerson:      true,
			ShowApprover:           true,
			ShowPurchaseOrder:      true,
			ShowServicePeriod:      true,
			ShowServiceDescription: true,
		},
	}
}

// renderPDF renders a document with the built-in wiRef template.
func renderPDF(t *testing.T, settings Settings, d Document) []byte {
	t.Helper()
	data, _, err := pdftemplates.BuiltinRenderer{}.RenderEffective(
		context.Background(), engine.KindWiRef, d.PDFData(settings), nil)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// pdfPages extracts the text of every page with the spaces removed, which keeps the assertions independent of how
// the PDF reader splits runs.
func pdfPages(t *testing.T, data []byte) []string {
	t.Helper()
	reader, err := pdfread.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("read pdf: %v", err)
	}
	var pages []string
	for i := 1; i <= reader.NumPage(); i++ {
		var b strings.Builder
		for _, c := range reader.Page(i).Content().Text {
			b.WriteString(c.S)
		}
		pages = append(pages, strings.ReplaceAll(b.String(), " ", ""))
	}
	return pages
}

func pdfText(t *testing.T, data []byte) string { return strings.Join(pdfPages(t, data), "") }

func requireText(t *testing.T, text string, wants ...string) {
	t.Helper()
	for _, want := range wants {
		if !strings.Contains(text, strings.ReplaceAll(want, " ", "")) {
			t.Errorf("PDF text lacks %q", want)
		}
	}
}

func TestPDFDataMatchesTheWiRefSchema(t *testing.T) {
	d := SampleDocument(sampleTime())
	d.AlreadyPaid = "30.00"
	pdftest.AssertData(t, engine.KindWiRef, d.PDFData(defaultSettings()))
}

func TestPDFDataFillsTextsAndSwitches(t *testing.T) {
	settings := defaultSettings()
	settings.ShowContactPerson = false
	data := SampleDocument(sampleTime()).PDFData(settings)
	texts, show := data["texts"].(map[string]any), data["show"].(map[string]any)
	if texts["title"] != "Invoice request W-2026-000123" ||
		texts["intro"] != "Please invoice Example University, Institute of Sample Studies (PO-2026-0042)." ||
		texts["closing"] != "Approved by Sam Approver on 21.10.2026." {
		t.Errorf("texts = %+v", texts)
	}
	if show["contactPerson"] != "" || show["servicePeriod"] != "true" || show["approver"] != "true" {
		t.Errorf("show = %+v", show)
	}
	period := data["request"].(map[string]any)["servicePeriod"].(map[string]any)
	if period["from"] != "2026-10-01" || period["to"] != "2026-10-15" {
		t.Errorf("period = %+v", period)
	}
	single := SampleDocument(sampleTime())
	single.ServiceEndsOn = single.ServiceStartsOn
	period = single.PDFData(settings)["request"].(map[string]any)["servicePeriod"].(map[string]any)
	if period["from"] != "2026-10-01" || period["to"] != "" {
		t.Errorf("single day period = %+v", period)
	}
}

func TestPDFDataLeavesOutWhatTheSettingsSwitchOff(t *testing.T) {
	settings := defaultSettings()
	settings.ShowApprover, settings.ShowContactPerson, settings.ShowPurchaseOrder = false, false, false
	settings.ShowServicePeriod, settings.ShowServiceDescription = false, false
	data := SampleDocument(sampleTime()).PDFData(settings)
	request, recipient := data["request"].(map[string]any), data["recipient"].(map[string]any)
	period := request["servicePeriod"].(map[string]any)
	for name, got := range map[string]any{
		"request.approver": request["approver"], "request.serviceDescription": request["serviceDescription"],
		"servicePeriod.from": period["from"], "servicePeriod.to": period["to"],
		"recipient.contactName": recipient["contactName"], "recipient.contactChannel": recipient["contactChannel"],
		"recipient.purchaseOrderReference": recipient["purchaseOrderReference"],
	} {
		if got != "" {
			t.Errorf("%s = %v with the switch off, want empty", name, got)
		}
	}
	if recipient["organization"] == "" || request["number"] == "" {
		t.Error("the fields without a switch must stay")
	}
	// With the switches on the same values are present, so the test above checks the gate and not empty sample data.
	on := SampleDocument(sampleTime()).PDFData(defaultSettings())["recipient"].(map[string]any)
	if on["contactName"] == "" || on["contactChannel"] == "" || on["purchaseOrderReference"] == "" {
		t.Errorf("recipient with switches on = %+v", on)
	}
}

func TestBuiltinPDFProducesAValidDocumentWithTotals(t *testing.T) {
	data := renderPDF(t, defaultSettings(), SampleDocument(sampleTime()))
	if !bytes.HasPrefix(data, []byte("%PDF-1.")) || !bytes.HasSuffix(bytes.TrimSpace(data), []byte("%%EOF")) {
		t.Fatalf("not a PDF: %q ... %q", data[:8], data[len(data)-8:])
	}
	requireText(t, pdfText(t, data),
		"Invoice request W-2026-000123", "Example University", "PO-2026-0042", "Sam Approver",
		"Laser cutting", "81.50", "EUR 81.50", "21.10.2026")
}

func TestBuiltinPDFKeepsUmlautsAndEuroSign(t *testing.T) {
	d := SampleDocument(sampleTime())
	d.Organisation = "Universität für Gestaltung Müßig"
	settings := defaultSettings()
	settings.PDFIntro = "Preis in € für {{organization}}"
	requireText(t, pdfText(t, renderPDF(t, settings, d)), "Universität für Gestaltung Müßig", "Preis in € für")
}

func TestBuiltinPDFHidesSwitchedOffFields(t *testing.T) {
	settings := defaultSettings()
	settings.ShowApprover, settings.ShowContactPerson, settings.ShowPurchaseOrder = false, false, false
	settings.ShowServicePeriod, settings.ShowServiceDescription = false, false
	text := pdfText(t, renderPDF(t, settings, SampleDocument(sampleTime())))
	for _, unwanted := range []string{"Sam Approver", "Alex Example", "PO-2026-0042", "Prototype parts", "Service period"} {
		if strings.Contains(text, strings.ReplaceAll(unwanted, " ", "")) {
			t.Errorf("PDF text still contains %q", unwanted)
		}
	}
}

func TestBuiltinPDFBreaksLongItemListsOverPages(t *testing.T) {
	d := SampleDocument(sampleTime())
	for range 80 {
		d.Items = append(d.Items, Item{
			Description: strings.Repeat("Long description ", 8), Quantity: "1", Unit: "pc", UnitPrice: "1.00", Amount: "1.00",
		})
	}
	d.Total = "161.50"
	pages := pdfPages(t, renderPDF(t, defaultSettings(), d))
	if len(pages) < 3 {
		t.Errorf("expected several pages, found %d", len(pages))
	}
	requireText(t, strings.Join(pages, ""), "EUR 161.50")
}

func TestBuiltinPDFListsPaymentsWithTheirIDs(t *testing.T) {
	d := SampleDocument(sampleTime())
	d.AlreadyPaid = "30.00"
	d.Payments = []Payment{
		{Reference: "P-2026-000011", Method: "Cash", PaidAt: sampleTime(), Amount: "30.00"},
		{Reference: "P-2026-000012", Method: "wiRef invoice", PaidAt: sampleTime(), Amount: "51.50"},
	}
	requireText(t, pdfText(t, renderPDF(t, defaultSettings(), d)),
		"Payment", "P-2026-000011", "P-2026-000012", "Cash", "wiRef invoice", "51.50")
	d.Payments = nil
	if strings.Contains(pdfText(t, renderPDF(t, defaultSettings(), d)), "P-2026-000011") {
		t.Error("payment drawn without payments")
	}
}

func TestMailContentShowsPrepaymentSplit(t *testing.T) {
	d := SampleDocument(sampleTime())
	d.AlreadyPaid = "30.00"
	_, content := defaultSettings().MailContent(d)
	var joined strings.Builder
	for _, row := range content.Rows {
		joined.WriteString(row.Label + "=" + row.Value + ";")
	}
	for _, want := range []string{"Order total=EUR 81.50", "Already paid=-EUR 30.00", "Amount to invoice=EUR 51.50"} {
		if !strings.Contains(joined.String(), want) {
			t.Errorf("rows lack %q: %s", want, joined.String())
		}
	}
}

func TestMailContentListsPayments(t *testing.T) {
	d := SampleDocument(sampleTime())
	d.Payments = []Payment{{Reference: "P-2026-000011", Method: "Card", PaidAt: sampleTime(), Amount: "12.00"}}
	_, content := defaultSettings().MailContent(d)
	for _, row := range content.Rows {
		if row.Label == "Payment P-2026-000011" && strings.Contains(row.Value, "Card, EUR 12.00") {
			return
		}
	}
	t.Errorf("payment row missing: %+v", content.Rows)
}

func TestInvoiceMailCarriesNoNotificationSettingsLink(t *testing.T) {
	_, content := defaultSettings().MailContent(SampleDocument(sampleTime()))
	if !content.OmitNotificationSettingsLink {
		t.Fatal("the wiRef mail goes to no person's account and must leave out the notification settings link")
	}
	brand := notifications.Branding{
		ApplicationName: "Makerspace", NotificationSettingsURL: "https://portal.example.test/notification-settings",
	}
	text, html := notifications.RenderBranded(brand, content)
	for _, part := range []string{text, html} {
		if strings.Contains(part, "notification-settings") || strings.Contains(part, "Notification settings") {
			t.Fatalf("invoice mail links the notification settings: %s", part)
		}
	}
}
