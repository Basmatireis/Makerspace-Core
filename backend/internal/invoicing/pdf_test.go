package invoicing

import (
	"bytes"
	"compress/zlib"
	"image"
	"image/png"
	"io"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifications"
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

var streamPattern = regexp.MustCompile(`(?s)stream\r?\n(.*?)\r?\nendstream`)

// pdfText inflates every content stream. fpdf writes literal strings, so the visible text is searchable.
func pdfText(t *testing.T, data []byte) string {
	t.Helper()
	var out strings.Builder
	for _, match := range streamPattern.FindAllSubmatch(data, -1) {
		reader, err := zlib.NewReader(bytes.NewReader(match[1]))
		if err != nil {
			continue
		}
		plain, err := io.ReadAll(reader)
		if err == nil {
			out.Write(plain)
		}
	}
	return out.String()
}

func TestRenderPDFProducesAValidDocumentWithTotals(t *testing.T) {
	data, err := RenderPDF(notifications.Branding{ApplicationName: "Makerspace", PrimaryColor: "#0f62fe"},
		Mark{}, defaultSettings(), SampleDocument(sampleTime()))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(data, []byte("%PDF-1.")) || !bytes.HasSuffix(bytes.TrimSpace(data), []byte("%%EOF")) {
		t.Fatalf("not a PDF: %q ... %q", data[:8], data[len(data)-8:])
	}
	text := pdfText(t, data)
	for _, want := range []string{
		"Invoice request W-2026-000123", "Example University", "PO-2026-0042", "Sam Approver",
		"Laser cutting", "81.50", "EUR 81.50", "21.10.2026",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("PDF text lacks %q", want)
		}
	}
}

func TestRenderPDFKeepsUmlautsAndEuroSign(t *testing.T) {
	d := SampleDocument(sampleTime())
	d.Organisation = "Universität für Gestaltung Müßig"
	settings := defaultSettings()
	settings.PDFIntro = "Preis in € für {{organization}}"
	data, err := RenderPDF(notifications.Branding{}, Mark{}, settings, d)
	if err != nil {
		t.Fatal(err)
	}
	text := pdfText(t, data)
	// cp1252: ä = 0xE4, ü = 0xFC, ß = 0xDF, € = 0x80. fpdf writes these as literal bytes inside strings.
	for _, want := range []string{"Universit\xe4t f\xfcr Gestaltung M\xfc\xdfig", "Preis in \x80 f\xfcr"} {
		if !strings.Contains(text, want) {
			t.Errorf("PDF text lacks %q", want)
		}
	}
}

func TestRenderPDFHidesSwitchedOffFields(t *testing.T) {
	settings := defaultSettings()
	settings.ShowApprover, settings.ShowContactPerson, settings.ShowPurchaseOrder = false, false, false
	settings.ShowServicePeriod, settings.ShowServiceDescription = false, false
	data, err := RenderPDF(notifications.Branding{}, Mark{}, settings, SampleDocument(sampleTime()))
	if err != nil {
		t.Fatal(err)
	}
	text := pdfText(t, data)
	for _, unwanted := range []string{"Sam Approver", "Alex Example", "PO-2026-0042", "Prototype parts", "Service period"} {
		if strings.Contains(text, unwanted) {
			t.Errorf("PDF text still contains %q", unwanted)
		}
	}
}

func TestRenderPDFBreaksLongItemListsOverPages(t *testing.T) {
	d := SampleDocument(sampleTime())
	for range 80 {
		d.Items = append(d.Items, Item{Description: strings.Repeat("Long description ", 8), Quantity: "1", Unit: "pc", UnitPrice: "1.00", Amount: "1.00"})
	}
	d.Total = "161.50"
	data, err := RenderPDF(notifications.Branding{}, Mark{}, defaultSettings(), d)
	if err != nil {
		t.Fatal(err)
	}
	if pages := bytes.Count(data, []byte("/Type /Page\n")); pages < 3 {
		t.Errorf("expected several pages, found %d", pages)
	}
	if !strings.Contains(pdfText(t, data), "EUR 161.50") {
		t.Error("total missing after page breaks")
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

func TestRenderPDFHeaderFollowsTheApplicationHeader(t *testing.T) {
	logo := &bytes.Buffer{}
	if err := png.Encode(logo, image.NewRGBA(image.Rect(0, 0, 46, 51))); err != nil {
		t.Fatal(err)
	}
	mark := Mark{OrganizationName: "HTU Graz", DisplayName: "Makerspace", Logo: &Logo{Data: logo.Bytes(), Type: "PNG"}}
	data, err := RenderPDF(notifications.Branding{ApplicationName: "HTU Graz Makerspace"}, mark, defaultSettings(),
		SampleDocument(sampleTime()))
	if err != nil {
		t.Fatal(err)
	}
	text := pdfText(t, data)
	for _, want := range []string{"(HTU GRAZ)", "(Makerspace)", "/Subtype /Image"} {
		if !strings.Contains(text, want) && !bytes.Contains(data, []byte(want)) {
			t.Errorf("PDF lacks %q", want)
		}
	}
	if strings.Contains(text, "(HTU Graz Makerspace)") {
		t.Error("header shows the application name instead of the display name")
	}
}

func TestRenderPDFListsPaymentsWithTheirIDs(t *testing.T) {
	d := SampleDocument(sampleTime())
	d.AlreadyPaid = "30.00"
	d.Payments = []Payment{
		{Reference: "P-2026-000011", Method: "Cash", PaidAt: sampleTime(), Amount: "30.00"},
		{Reference: "P-2026-000012", Method: "wiRef invoice", PaidAt: sampleTime(), Amount: "51.50"},
	}
	data, err := RenderPDF(notifications.Branding{}, Mark{}, defaultSettings(), d)
	if err != nil {
		t.Fatal(err)
	}
	text := pdfText(t, data)
	for _, want := range []string{"Payment ID", "P-2026-000011", "P-2026-000012", "Cash", "wiRef invoice", "51.50"} {
		if !strings.Contains(text, want) {
			t.Errorf("PDF text lacks %q", want)
		}
	}
	d.Payments = nil
	data, err = RenderPDF(notifications.Branding{}, Mark{}, defaultSettings(), d)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(pdfText(t, data), "Payment ID") {
		t.Error("payment table drawn without payments")
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
