package invoicing

import (
	"bytes"
	"compress/zlib"
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
			MailSubject:            "Invoice request {{anforderungsnummer}} for {{organisation}}",
			MailIntro:              "Approved on {{datum}}.\n\nPlease invoice {{organisation}}.",
			MailClosing:            "Thanks.",
			PDFTitle:               "Invoice request {{anforderungsnummer}}",
			PDFIntro:               "Please invoice {{organisation}} ({{bestellreferenz}}).",
			PDFClosing:             "Approved by {{freigegeben_von}} on {{datum}}.",
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
		nil, defaultSettings(), SampleDocument(sampleTime()))
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
	settings.PDFIntro = "Preis in € für {{organisation}}"
	data, err := RenderPDF(notifications.Branding{}, nil, settings, d)
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
	data, err := RenderPDF(notifications.Branding{}, nil, settings, SampleDocument(sampleTime()))
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
	data, err := RenderPDF(notifications.Branding{}, nil, defaultSettings(), d)
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
