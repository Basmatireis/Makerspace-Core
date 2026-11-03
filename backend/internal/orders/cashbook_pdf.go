package orders

import (
	"bytes"
	"fmt"
	"strconv"

	"github.com/go-pdf/fpdf"
	"github.com/shopspring/decimal"
)

// The cashbook PDF reproduces the HTU Kassabuch sheet: the HTU letterhead and footer on every page, the header block
// (Kassabuch, Studienlabor, Wirtschaftsjahr) on the first page, the balance carried over at the top of every other
// page and the totals with two signature lines at the end. Lengths are millimetres on A4.

// CashbookRowsPerPage is the number of entry rows on one sheet.
const CashbookRowsPerPage = 20

// cashbookMinimumRows pads a short cashbook with empty rows, so the sheet still reads as a form.
const cashbookMinimumRows = 6

const (
	kbLeft          = 20.0
	kbWidth         = 170.0
	kbTableTop      = 50.0
	kbTitleRow      = 8.0
	kbOrgRow        = 13.0
	kbYearRow       = 8.5
	kbCarryRow      = 9.0
	kbHeadRow       = 6.5
	kbRow           = 7.0
	kbSignature     = 18.0
	kbContentBottom = 238.0
	kbFontSize      = 8.0
	kbSmallFontSize = 6.5
)

// kbColumns are Nr., Datum, Kassierer*in, Text, Einnahme, Ausgabe; they add up to kbWidth.
var kbColumns = [6]float64{15, 22.4, 27.5, 60.1, 22.5, 22.5}

// cashbookPage is one sheet: rows [first, last) of the lines, with the header block on the first sheet, the
// carry-over row on every other sheet (and on the first one of the cash register) and the totals on the last.
type cashbookPage struct {
	first, last int
	header      bool
	carry       bool
	padding     int
	summary     bool
}

// layoutCashbook splits rows into sheets of CashbookRowsPerPage. When the totals and the signature lines do not fit
// below the last rows, they move to a sheet of their own that starts with the carry-over row.
func layoutCashbook(rows int, cashRegister bool) []cashbookPage {
	var pages []cashbookPage
	for first := 0; first < rows || first == 0; first += CashbookRowsPerPage {
		last := min(first+CashbookRowsPerPage, rows)
		pages = append(pages, cashbookPage{first: first, last: last, header: first == 0, carry: first > 0 || cashRegister})
		if rows == 0 {
			break
		}
	}
	if rows < cashbookMinimumRows {
		pages[0].padding = cashbookMinimumRows - rows
	}
	last := &pages[len(pages)-1]
	sums := 1
	if cashRegister {
		sums = 2
	}
	if last.bottom()+float64(sums)*kbRow+kbSignature <= kbContentBottom {
		last.summary = true
		return pages
	}
	return append(pages, cashbookPage{first: rows, last: rows, carry: true, summary: true})
}

// bottom is where the rows of the page end.
func (p cashbookPage) bottom() float64 {
	y := kbTableTop + kbHeadRow + float64(p.last-p.first+p.padding)*kbRow
	if p.header {
		y += kbTitleRow + kbOrgRow + kbYearRow
	}
	if p.carry {
		y += kbCarryRow
	}
	return y
}

var (
	kbRed    = [3]int{238, 63, 35}
	kbTeal   = [3]int{99, 201, 174}
	kbBlue   = [3]int{46, 115, 149}
	kbYellow = [3]int{250, 195, 10}
	kbDark   = [3]int{43, 43, 43}
	kbGrey   = [3]int{128, 128, 128}
)

type kbPDF struct {
	*fpdf.Fpdf
	tr func(string) string
}

func (k kbPDF) fill(c [3]int) { k.SetFillColor(c[0], c[1], c[2]) }

func (k kbPDF) triangle(c [3]int, points ...float64) {
	k.fill(c)
	k.Polygon([]fpdf.PointType{{X: points[0], Y: points[1]}, {X: points[2], Y: points[3]}, {X: points[4], Y: points[5]}}, "F")
}

// logo draws the HTU hexagon with its letters as vector shapes.
func (k kbPDF) logo(x, y float64) {
	const width, height = 17.9, 20.6
	point := func(px, py float64) fpdf.PointType { return fpdf.PointType{X: x + px*width, Y: y + py*height} }
	hexagon := func(inset float64) []fpdf.PointType {
		return []fpdf.PointType{
			point(0.5, inset), point(1-inset*0.87, 0.25+inset*0.5), point(1-inset*0.87, 0.75-inset*0.5),
			point(0.5, 1-inset), point(inset*0.87, 0.75-inset*0.5), point(inset*0.87, 0.25+inset*0.5),
		}
	}
	k.fill(kbRed)
	k.Polygon(hexagon(0), "F")
	k.SetFillColor(255, 255, 255)
	k.Polygon(hexagon(0.1), "F")
	k.fill(kbRed)
	box := func(x0, y0, x1, y1 float64) {
		k.Rect(x+x0*width, y+y0*height, (x1-x0)*width, (y1-y0)*height, "F")
	}
	box(0.14, 0.26, 0.23, 0.78) // h: stem
	box(0.14, 0.40, 0.42, 0.47) // h: shoulder
	box(0.33, 0.40, 0.42, 0.78) // h: leg
	box(0.32, 0.18, 0.72, 0.26) // T: bar
	box(0.46, 0.18, 0.55, 0.90) // T: stem
	box(0.60, 0.36, 0.69, 0.78) // U: left
	box(0.78, 0.30, 0.87, 0.78) // U: right
	box(0.60, 0.71, 0.87, 0.78) // U: bottom
}

// sheet draws the letterhead, the decoration and the footer of the template.
func (k kbPDF) sheet() {
	k.logo(23, 19.8)
	k.SetTextColor(kbDark[0], kbDark[1], kbDark[2])
	k.SetFont("Helvetica", "B", 17)
	k.Text(44.7, 30.3, "HTU Graz")
	k.SetFont("Helvetica", "", 9)
	k.Text(44.7, 34.6, "Vertretung. Beratung. Service.")
	k.triangle(kbTeal, 182.0, 13.8, 191.8, 7.9, 191.8, 19.8)
	k.triangle(kbBlue, 191.8, 19.8, 201.9, 13.8, 201.9, 25.7)
	k.triangle(kbRed, 191.8, 31.7, 201.9, 25.7, 201.9, 37.6)
	k.triangle(kbYellow, 191.8, 31.7, 191.8, 43.5, 201.9, 37.6)
	k.triangle(kbRed, 191.8, 241.5, 191.8, 253.4, 201.9, 247.4)
	k.triangle(kbTeal, 191.8, 253.4, 191.8, 265.2, 201.9, 259.3)
	k.triangle(kbYellow, 182.0, 271.2, 191.8, 265.2, 191.8, 277.1)
	k.triangle(kbDark, 182.0, 271.2, 182.0, 283.1, 191.8, 277.1)
	k.triangle(kbBlue, 191.8, 277.1, 191.8, 289.0, 201.9, 283.1)
	k.triangle(kbTeal, 8.0, 261.5, 8.0, 273.4, 17.8, 267.5)
	// Fold marks.
	k.SetDrawColor(kbDark[0], kbDark[1], kbDark[2])
	k.SetLineWidth(0.3)
	k.Line(0, 105, 10.7, 105)
	k.Line(0, 210, 10.7, 210)
	k.SetFont("Helvetica", "B", 7.5)
	k.Text(23, 269.5, k.tr("HOCHSCHÜLERINNEN- UND HOCHSCHÜLERSCHAFT AN DER TECHNISCHEN UNIVERSITÄT GRAZ"))
	k.SetFont("Helvetica", "", 7.5)
	k.Text(23, 273.8, k.tr("Körperschaft öffentlichen Rechts"))
	k.Text(23, 278.1, k.tr("Rechbauerstraße 12, 8010 Graz | +43-316 873-5111 | info@htugraz.at | www.htugraz.at"))
	k.Text(23, 282.4, k.tr("Steiermaerkische Bank und Sparkassen AG, IBAN: AT312081500043449370, BIC: STSPAT2GXXX"))
	k.SetDrawColor(29, 29, 27)
	k.SetLineWidth(0.25)
}

// fit shortens text with an ellipsis until it fits the width.
func (k kbPDF) fit(text string, width float64) string {
	text = k.tr(text)
	if k.GetStringWidth(text) <= width {
		return text
	}
	ellipsis := "\x85" // … in cp1252
	runes := []byte(text)
	for len(runes) > 0 && k.GetStringWidth(string(runes)+ellipsis) > width {
		runes = runes[:len(runes)-1]
	}
	return string(runes) + ellipsis
}

// cell draws one bordered cell with a single line of text; bold and right alignment as asked.
func (k kbPDF) cell(x, y, w, h float64, text string, bold, right bool) {
	k.Rect(x, y, w, h, "D")
	if text == "" {
		return
	}
	style := ""
	if bold {
		style = "B"
	}
	k.SetFont("Helvetica", style, kbFontSize)
	k.SetTextColor(29, 29, 27)
	text = k.fit(text, w-2.4)
	tx := x + 1.2
	if right {
		tx = x + w - 1.2 - k.GetStringWidth(text)
	}
	k.Text(tx, y+h/2+1.1, text)
}

func (k kbPDF) greyCell(x, y, w, h float64) {
	k.fill(kbGrey)
	k.Rect(x, y, w, h, "FD")
}

func columnX(i int) float64 {
	x := kbLeft
	for _, w := range kbColumns[:i] {
		x += w
	}
	return x
}

// labelRow is a row with a bold label in the text column and two amount cells.
func (k kbPDF) labelRow(y, h float64, label []string, in string, out *string) {
	for i := range 3 {
		k.Rect(columnX(i), y, kbColumns[i], h, "D")
	}
	k.Rect(columnX(3), y, kbColumns[3], h, "D")
	k.SetFont("Helvetica", "B", kbFontSize)
	k.SetTextColor(29, 29, 27)
	lineY := y + h/2 + 1.1 - float64(len(label)-1)*1.7
	for _, line := range label {
		k.Text(columnX(3)+1.2, lineY, k.tr(line))
		lineY += 3.4
	}
	k.cell(columnX(4), y, kbColumns[4], h, in, true, true)
	if out == nil {
		k.greyCell(columnX(5), y, kbColumns[5], h)
	} else {
		k.cell(columnX(5), y, kbColumns[5], h, *out, true, true)
	}
}

func (b cashbook) yearText() string {
	year := strconv.Itoa(b.from.Year())
	if b.to.Year() != b.from.Year() {
		year += fmt.Sprintf("/%02d", b.to.Year()%100)
	}
	text := year + " · Zeitraum " + b.from.Format("02.01.2006") + " – " + b.to.Format("02.01.2006")
	if b.contents == CashbookAllPayments {
		text += " · alle Zahlungen"
	}
	return text
}

func renderCashbookPDF(b cashbook) ([]byte, error) {
	pdf := fpdf.New("P", "mm", "A4", "")
	pdf.SetMargins(0, 0, 0)
	pdf.SetAutoPageBreak(false, 0)
	pdf.SetTitle("Kassabuch "+b.yearText(), true)
	pdf.SetCreator("Makerspace Core", true)
	k := kbPDF{Fpdf: pdf, tr: pdf.UnicodeTranslatorFromDescriptor("")}
	cashRegister := b.withBalance
	// carried is what the carry-over row shows: the balance for the cash register, the running totals otherwise.
	carriedBalance := b.opening
	carriedIn, carriedOut := decimal.Zero, decimal.Zero
	for _, page := range layoutCashbook(len(b.lines), cashRegister) {
		pdf.AddPage()
		k.sheet()
		y := kbTableTop
		if page.header {
			k.SetFont("Helvetica", "B", 14)
			k.Rect(kbLeft, y, kbWidth, kbTitleRow, "D")
			title := "Kassabuch"
			k.Text(kbLeft+(kbWidth-k.GetStringWidth(title))/2, y+kbTitleRow/2+1.8, title)
			y += kbTitleRow
			labelWidth := kbColumns[0] + kbColumns[1] + kbColumns[2]
			k.Rect(kbLeft, y, labelWidth, kbOrgRow, "D")
			k.Rect(kbLeft+labelWidth, y, kbWidth-labelWidth, kbOrgRow, "D")
			k.SetFont("Helvetica", "B", 9)
			for i, line := range []string{"Studienvertretung", "Studienlabor", "Referat"} {
				k.Text(kbLeft+1.2, y+3.8+float64(i)*3.6, line)
			}
			k.SetFont("Helvetica", "", 9)
			k.Text(kbLeft+labelWidth+1.5, y+3.8, "Makerspace (Studienlabor)")
			y += kbOrgRow
			k.Rect(kbLeft, y, labelWidth, kbYearRow, "D")
			k.Rect(kbLeft+labelWidth, y, kbWidth-labelWidth, kbYearRow, "D")
			k.SetFont("Helvetica", "B", 9)
			k.Text(kbLeft+1.2, y+3.8, "Wirtschaftsjahr")
			k.SetFont("Helvetica", "", 9)
			k.Text(kbLeft+labelWidth+1.5, y+3.8, k.fit(b.yearText(), kbWidth-labelWidth-3))
			y += kbYearRow
		}
		if page.carry {
			if cashRegister {
				k.labelRow(y, kbCarryRow, []string{"Bestand/Übertrag von", "vorheriger Seite"}, germanAmount(carriedBalance), nil)
			} else {
				out := germanAmount(carriedOut)
				k.labelRow(y, kbCarryRow, []string{"Übertrag von", "vorheriger Seite"}, germanAmount(carriedIn), &out)
			}
			y += kbCarryRow
		}
		for i, title := range []string{"Nr.", "Datum", "Kassierer*in", "Text", "Einnahme", "Ausgabe"} {
			k.cell(columnX(i), y, kbColumns[i], kbHeadRow, title, true, false)
		}
		y += kbHeadRow
		for n := page.first; n < page.last; n++ {
			line := b.lines[n]
			in, out := b.amounts(line)
			k.cell(columnX(0), y, kbColumns[0], kbRow, strconv.Itoa(n+1), false, true)
			k.cell(columnX(1), y, kbColumns[1], kbRow, line.at.In(b.location).Format("02.01.2006"), false, false)
			k.cell(columnX(2), y, kbColumns[2], kbRow, line.recordedBy, false, false)
			k.Rect(columnX(3), y, kbColumns[3], kbRow, "D")
			k.SetFont("Helvetica", "", kbFontSize)
			k.SetTextColor(29, 29, 27)
			k.Text(columnX(3)+1.2, y+3.1, k.fit(germanWords.describe(line, !cashRegister), kbColumns[3]-2.4))
			k.SetFont("Helvetica", "", kbSmallFontSize)
			k.SetTextColor(111, 111, 111)
			k.Text(columnX(3)+1.2, y+5.9, k.tr(line.reference))
			k.cell(columnX(4), y, kbColumns[4], kbRow, optionalAmount(in, germanAmount), false, true)
			k.cell(columnX(5), y, kbColumns[5], kbRow, optionalAmount(out, germanAmount), false, true)
			carriedBalance = line.balance
			carriedIn, carriedOut = carriedIn.Add(in), carriedOut.Add(out)
			y += kbRow
		}
		for range page.padding {
			for i := range kbColumns {
				k.Rect(columnX(i), y, kbColumns[i], kbRow, "D")
			}
			y += kbRow
		}
		if !page.summary {
			continue
		}
		totalOut := germanAmount(b.totalOut)
		k.labelRow(y, kbRow, []string{"Summe"}, germanAmount(b.totalIn), &totalOut)
		y += kbRow
		if cashRegister {
			k.labelRow(y, kbRow, []string{"Summe/Bestand"}, germanAmount(b.closing), nil)
			y += kbRow
		}
		lineY := y + 12
		k.SetLineWidth(0.3)
		k.Line(kbLeft, lineY, kbLeft+75, lineY)
		k.Line(kbLeft+kbWidth-75, lineY, kbLeft+kbWidth, lineY)
		k.SetFont("Helvetica", "", 7.5)
		k.SetTextColor(82, 82, 82)
		k.Text(kbLeft, lineY+3.5, "Datum, Unterschrift Kassier*in")
		k.Text(kbLeft+kbWidth-75, lineY+3.5, "Datum, Unterschrift Finanzreferat")
		k.SetLineWidth(0.25)
	}
	if err := pdf.Error(); err != nil {
		return nil, fmt.Errorf("render cashbook pdf: %w", err)
	}
	var out bytes.Buffer
	if err := pdf.Output(&out); err != nil {
		return nil, fmt.Errorf("write cashbook pdf: %w", err)
	}
	return out.Bytes(), nil
}
