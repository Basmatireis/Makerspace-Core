package invoicing

import (
	"bytes"
	"fmt"
	"strconv"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifications"
	"github.com/go-pdf/fpdf"
)

// Logo is a raster image shown in the PDF header.
type Logo struct {
	Data []byte
	// Type is "PNG" or "JPG".
	Type string
}

const (
	pdfMargin     = 20.0
	pdfLine       = 5.2
	pdfLabelWidth = 48.0
	pdfPageWidth  = 210.0
	pdfPageHeight = 297.0
	pdfBottom     = 22.0
)

// column widths of the item table; they add up to the 170 mm text width.
var pdfColumns = [4]float64{80, 28, 31, 31}

// RenderPDF draws the invoice request on A4 pages. It uses the built-in Helvetica font and the cp1252 character set,
// which covers German umlauts, the sharp s and the euro sign; other characters are replaced by fpdf. Nothing is
// loaded from disk or the network.
func RenderPDF(brand notifications.Branding, logo *Logo, s Settings, d Document) ([]byte, error) {
	values := d.values(s)
	title := singleLine(Substitute(s.PDFTitle, values))
	pdf := fpdf.New("P", "mm", "A4", "")
	tr := pdf.UnicodeTranslatorFromDescriptor("")
	pdf.SetMargins(pdfMargin, pdfMargin, pdfMargin)
	pdf.SetAutoPageBreak(true, pdfBottom)
	pdf.SetTitle(title, true)
	pdf.SetCreator(brand.ApplicationName, true)
	if !d.ApprovedAt.IsZero() {
		pdf.SetCreationDate(d.ApprovedAt)
	}
	pdf.AliasNbPages("{nb}")
	red, green, blue := parseHex(brand.PrimaryColor)
	pdf.SetHeaderFunc(func() {
		pdf.SetFillColor(red, green, blue)
		pdf.Rect(0, 0, pdfPageWidth, 4, "F")
		pdf.SetY(10)
		textX := pdfMargin
		if logo != nil {
			name := "logo"
			info := pdf.RegisterImageOptionsReader(name, fpdf.ImageOptions{ImageType: logo.Type}, bytes.NewReader(logo.Data))
			if info != nil && pdf.Ok() {
				pdf.ImageOptions(name, pdfMargin, 9, 0, 11, false, fpdf.ImageOptions{ImageType: logo.Type}, 0, "")
				textX += 11*info.Width()/info.Height() + 3
			}
		}
		pdf.SetXY(textX, 10)
		pdf.SetTextColor(22, 22, 22)
		pdf.SetFont("Helvetica", "B", 11)
		pdf.CellFormat(0, 5.5, tr(brand.ApplicationName), "", 1, "L", false, 0, "")
		if brand.OrganizationName != "" {
			pdf.SetX(textX)
			pdf.SetFont("Helvetica", "", 9)
			pdf.SetTextColor(82, 82, 82)
			pdf.CellFormat(0, 4.5, tr(brand.OrganizationName), "", 1, "L", false, 0, "")
		}
		pdf.SetY(30)
	})
	pdf.SetFooterFunc(func() {
		pdf.SetY(-15)
		pdf.SetFont("Helvetica", "", 8)
		pdf.SetTextColor(111, 111, 111)
		pdf.CellFormat(0, 5, tr(d.RequestNumber), "", 0, "L", false, 0, "")
		pdf.SetX(pdfMargin)
		pdf.CellFormat(0, 5, tr("Page "+strconv.Itoa(pdf.PageNo())+" / {nb}"), "", 0, "R", false, 0, "")
	})
	pdf.AddPage()

	pdf.SetTextColor(22, 22, 22)
	pdf.SetFont("Helvetica", "B", 17)
	pdf.MultiCell(0, 8, tr(title), "", "L", false)
	pdf.Ln(3)
	body := func(text string) {
		for _, paragraph := range paragraphs(text) {
			pdf.SetFont("Helvetica", "", 10.5)
			pdf.SetTextColor(22, 22, 22)
			pdf.MultiCell(0, 5.6, tr(paragraph), "", "L", false)
			pdf.Ln(2)
		}
	}
	body(Substitute(s.PDFIntro, values))
	pdf.Ln(2)

	for _, row := range d.details(s) {
		pdfRow(pdf, tr, row.Label, row.Value, false)
	}
	pdf.Ln(5)
	pdfItems(pdf, tr, d)
	for _, row := range d.totals() {
		pdfTotal(pdf, tr, row)
	}
	pdf.Ln(6)
	for _, row := range d.approval(s) {
		pdfRow(pdf, tr, row.Label, row.Value, false)
	}
	pdf.Ln(4)
	body(Substitute(s.PDFClosing, values))

	if err := pdf.Error(); err != nil {
		return nil, fmt.Errorf("render invoice pdf: %w", err)
	}
	var out bytes.Buffer
	if err := pdf.Output(&out); err != nil {
		return nil, fmt.Errorf("write invoice pdf: %w", err)
	}
	return out.Bytes(), nil
}

// ensureRoom starts a new page when fewer than height millimetres remain above the footer.
func ensureRoom(pdf *fpdf.Fpdf, height float64) bool {
	if pdf.GetY()+height > pdfPageHeight-pdfBottom {
		pdf.AddPage()
		return true
	}
	return false
}

func pdfRow(pdf *fpdf.Fpdf, tr func(string) string, label, value string, bold bool) {
	pdf.SetFont("Helvetica", "", 10)
	valueWidth := pdfPageWidth - 2*pdfMargin - pdfLabelWidth
	lines := splitLines(pdf, tr(value), valueWidth)
	ensureRoom(pdf, pdfLine*float64(max(len(lines), 1)))
	x, y := pdfMargin, pdf.GetY()
	pdf.SetXY(x, y)
	pdf.SetTextColor(82, 82, 82)
	pdf.CellFormat(pdfLabelWidth, pdfLine, tr(label), "", 0, "L", false, 0, "")
	pdf.SetXY(x+pdfLabelWidth, y)
	pdf.SetTextColor(22, 22, 22)
	style := ""
	if bold {
		style = "B"
	}
	pdf.SetFont("Helvetica", style, 10)
	pdf.MultiCell(valueWidth, pdfLine, tr(value), "", "L", false)
	pdf.SetX(pdfMargin)
	pdf.Ln(0.8)
}

func pdfItemHeader(pdf *fpdf.Fpdf, tr func(string) string) {
	pdf.SetFont("Helvetica", "B", 9.5)
	pdf.SetFillColor(244, 244, 244)
	pdf.SetTextColor(22, 22, 22)
	pdf.CellFormat(pdfColumns[0], 7, tr("Description"), "B", 0, "L", true, 0, "")
	pdf.CellFormat(pdfColumns[1], 7, tr("Quantity"), "B", 0, "R", true, 0, "")
	pdf.CellFormat(pdfColumns[2], 7, tr("Unit price (EUR)"), "B", 0, "R", true, 0, "")
	pdf.CellFormat(pdfColumns[3], 7, tr("Amount (EUR)"), "B", 1, "R", true, 0, "")
}

func pdfItems(pdf *fpdf.Fpdf, tr func(string) string, d Document) {
	ensureRoom(pdf, 20)
	pdfItemHeader(pdf, tr)
	pdf.SetFont("Helvetica", "", 10)
	for _, item := range d.Items {
		lines := splitLines(pdf, tr(item.Description), pdfColumns[0]-2)
		height := pdfLine * float64(max(len(lines), 1))
		if ensureRoom(pdf, height+1) {
			pdfItemHeader(pdf, tr)
			pdf.SetFont("Helvetica", "", 10)
		}
		x, y := pdfMargin, pdf.GetY()
		pdf.SetXY(x, y)
		pdf.MultiCell(pdfColumns[0], pdfLine, tr(item.Description), "B", "L", false)
		pdf.SetXY(x+pdfColumns[0], y)
		pdf.CellFormat(pdfColumns[1], height, tr(item.quantityText()), "B", 0, "R", false, 0, "")
		pdf.CellFormat(pdfColumns[2], height, tr(formatPlain(item.UnitPrice)), "B", 0, "R", false, 0, "")
		pdf.CellFormat(pdfColumns[3], height, tr(formatPlain(item.Amount)), "B", 1, "R", false, 0, "")
		pdf.SetXY(pdfMargin, y+height)
	}
}

func pdfTotal(pdf *fpdf.Fpdf, tr func(string) string, row detail) {
	ensureRoom(pdf, 9)
	last := row.Label == "Amount to invoice"
	style, size := "", 10.0
	if last {
		style, size = "B", 11.5
	}
	pdf.SetFont("Helvetica", style, size)
	pdf.SetTextColor(22, 22, 22)
	pdf.SetX(pdfMargin)
	pdf.CellFormat(pdfColumns[0]+pdfColumns[1]+pdfColumns[2], 7.5, tr(row.Label), "", 0, "R", false, 0, "")
	pdf.CellFormat(pdfColumns[3], 7.5, tr(row.Value), "", 1, "R", false, 0, "")
}

func parseHex(color string) (int, int, int) {
	if len(color) != 7 || color[0] != '#' {
		return 15, 98, 254
	}
	value, err := strconv.ParseUint(color[1:], 16, 32)
	if err != nil {
		return 15, 98, 254
	}
	return int(value >> 16 & 0xff), int(value >> 8 & 0xff), int(value & 0xff)
}

// splitLines wraps text that was already translated to cp1252. SplitText indexes the font widths by rune, while the
// translated string holds one byte per character, so each byte is widened to the rune of the same value first.
func splitLines(pdf *fpdf.Fpdf, translated string, width float64) []string {
	widened := make([]rune, len(translated))
	for i := range len(translated) {
		widened[i] = rune(translated[i])
	}
	return pdf.SplitText(string(widened), width)
}
