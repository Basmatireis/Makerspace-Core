package orders

import (
	"bytes"
	_ "embed"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"github.com/go-pdf/fpdf"
	"github.com/shopspring/decimal"
)

// The cashbook PDF reproduces the HTU Kassabuch form (Kassabuch_Vorlage): the letterhead on every page, a first
// sheet with the head block and 14 entry rows, continuation sheets with 17 entry rows, each opened by the balance
// carried over and closed by Summe/Bestand, and a final sheet with the totals and three signature fields. Sheets are
// always complete, so unused rows stay empty as on the paper form. Lengths are millimetres on A4, measured from the
// template; y grows downwards and positions name the centre of a rule.

const (
	// CashbookFirstSheetRows is the number of entry rows on the first sheet, below the head block.
	CashbookFirstSheetRows = 14
	// CashbookSheetRows is the number of entry rows on every following sheet.
	CashbookSheetRows = 17
)

// kbRules are the vertical rules of the table: Nr., Datum, Kassierer*in, Text, Einnahme, Ausgabe.
var kbRules = [7]float64{20.03, 35.10, 57.58, 85.10, 145.10, 167.64, 190.07}

const (
	kbTop       = 52.08
	kbPad       = 1.88 // text inset from a rule
	kbRule      = 0.17 // 0.48 pt
	kbLineGap   = 4.47 // between the lines of a label
	kbLabelSize = 11.04
	kbValueSize = 9.0  // entries
	kbTotalSize = 10.0 // carried balance, sums and totals
	kbTextSize  = 9.0
	kbRefSize   = 7.0
	// The head block of the first sheet: title, Studienvertretung/Studienlabor/Referat and Wirtschaftsjahr rows.
	kbTitleRow   = 7.49
	kbOrgRow     = 15.70
	kbYearRow    = 10.0
	kbHeadInset  = 3.73 // baseline of a top-aligned label below the rule
	kbTitleInset = 6.01
	kbSumInset   = 6.14
	// The final sheet: three amount rows, then three signature rows with a narrower label cell.
	kbTotalInset   = 6.18
	kbSignatureEnd = 115.17
)

var (
	kbTotalRows     = [3]float64{9.52, 9.48, 9.53}
	kbSignatureRows = [3]float64{19.65, 20.02, 19.98}
)

// kbSheet is the row geometry of a sheet; the first sheet is shorter in rows because of its head block.
type kbSheet struct {
	rows                  int
	carry, head, body     float64
	sum                   float64
	carryInset, headInset float64
	headSmall             bool
}

var (
	kbFirstSheet = kbSheet{
		rows:       CashbookFirstSheetRows,
		carry:      9.10,
		head:       4.67,
		body:       9.4536,
		sum:        9.48,
		carryInset: 3.72,
		headInset:  3.73,
		headSmall:  true,
	}
	kbNextSheet = kbSheet{
		rows:       CashbookSheetRows,
		carry:      9.48,
		head:       9.44,
		body:       9.457,
		sum:        9.44,
		carryInset: 3.93,
		headInset:  6.14,
	}
)

// cashbookSheet holds the entries [first, last) of one sheet.
type cashbookSheet struct {
	first, last int
}

// layoutCashbook splits entries into the first sheet and continuation sheets. There is always at least one sheet;
// the final sheet with the totals and signatures follows the last one.
func layoutCashbook(rows int) []cashbookSheet {
	sheets := []cashbookSheet{{first: 0, last: min(rows, CashbookFirstSheetRows)}}
	for first := CashbookFirstSheetRows; first < rows; first += CashbookSheetRows {
		sheets = append(sheets, cashbookSheet{first: first, last: min(first+CashbookSheetRows, rows)})
	}
	return sheets
}

var (
	kbInk  = [3]int{60, 60, 60} // text colour of the form
	kbGrey = [3]int{127, 127, 127}
	kbRef  = [3]int{111, 111, 111}
)

// kassabuchLetterhead is the letterhead artwork of the template (logo, triangles and footer text as outlines), as
// filled paths in millimetres: "#rrggbb" sets the colour, M/L/C/Z build a path, F fills it.
//
//go:embed kassabuch_letterhead.txt
var kassabuchLetterhead string

type kbPathOp struct {
	op     byte
	values []float64
	color  [3]int
}

var kbLetterheadOps = sync.OnceValues(func() ([]kbPathOp, error) {
	return parseLetterhead(kassabuchLetterhead)
})

func parseLetterhead(source string) ([]kbPathOp, error) {
	arity := map[byte]int{'M': 2, 'L': 2, 'C': 6, 'Z': 0, 'F': 0}
	var ops []kbPathOp
	for n, line := range strings.Split(strings.TrimSpace(source), "\n") {
		if strings.HasPrefix(line, "#") {
			value, err := strconv.ParseUint(strings.TrimPrefix(line, "#"), 16, 32)
			if err != nil || len(line) != 7 {
				return nil, fmt.Errorf("letterhead line %d: bad colour", n+1)
			}
			ops = append(ops, kbPathOp{op: '#', color: [3]int{int(value >> 16), int(value >> 8 & 0xff), int(value & 0xff)}})
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 0 || len(fields[0]) != 1 {
			return nil, fmt.Errorf("letterhead line %d: no operator", n+1)
		}
		op := fields[0][0]
		want, ok := arity[op]
		if !ok || len(fields)-1 != want {
			return nil, fmt.Errorf("letterhead line %d: bad operator", n+1)
		}
		values := make([]float64, want)
		for i, field := range fields[1:] {
			v, err := strconv.ParseFloat(field, 64)
			if err != nil {
				return nil, fmt.Errorf("letterhead line %d: %w", n+1, err)
			}
			values[i] = v
		}
		ops = append(ops, kbPathOp{op: op, values: values})
	}
	return ops, nil
}

// drawLetterhead paints the letterhead and the two fold marks of the template.
func drawLetterhead(t *fpdf.Fpdf, ops []kbPathOp) {
	for _, o := range ops {
		v := o.values
		switch o.op {
		case '#':
			t.SetFillColor(o.color[0], o.color[1], o.color[2])
		case 'M':
			t.MoveTo(v[0], v[1])
		case 'L':
			t.LineTo(v[0], v[1])
		case 'C':
			t.CurveBezierCubicTo(v[0], v[1], v[2], v[3], v[4], v[5])
		case 'Z':
			t.ClosePath()
		case 'F':
			t.DrawPath("F")
		}
	}
	t.SetFillColor(kbInk[0], kbInk[1], kbInk[2])
	t.Rect(0, 104.88, 10.71, 0.49, "F")
	t.Rect(0, 210.03, 10.71, 0.49, "F")
}

type kbPDF struct {
	*fpdf.Fpdf
	tr func(string) string
}

// capHalf lifts a baseline from the middle of a cell so that capitals of the size sit centred (Arial cap height).
func capHalf(size float64) float64 { return size * 0.716 * 25.4 / 72 / 2 }

func (k kbPDF) font(style string, size float64, color [3]int) {
	k.SetFont("Helvetica", style, size)
	k.SetTextColor(color[0], color[1], color[2])
}

func (k kbPDF) text(x, baseline float64, text, style string, size float64) {
	k.font(style, size, kbInk)
	k.Text(x, baseline, k.tr(text))
}

func (k kbPDF) textRight(right, baseline float64, text, style string, size float64) {
	k.font(style, size, kbInk)
	text = k.tr(text)
	k.Text(right-k.GetStringWidth(text), baseline, text)
}

// fit shrinks text down to minSize and then shortens it with an ellipsis until it fits the width; it returns the
// encoded text and leaves the font set.
func (k kbPDF) fit(text, style string, size, minSize, width float64) string {
	return k.fitEncoded(k.tr(text), style, size, minSize, width)
}

// fitEncoded is fit for text already in the PDF encoding.
func (k kbPDF) fitEncoded(text, style string, size, minSize, width float64) string {
	for ; size > minSize; size -= 0.5 {
		k.SetFont("Helvetica", style, size)
		if k.GetStringWidth(text) <= width {
			return text
		}
	}
	k.SetFont("Helvetica", style, minSize)
	if k.GetStringWidth(text) <= width {
		return text
	}
	ellipsis := "\x85" // … in cp1252
	cut := []byte(text)
	for len(cut) > 0 && k.GetStringWidth(string(cut)+ellipsis) > width {
		cut = cut[:len(cut)-1]
	}
	return string(cut) + ellipsis
}

// cell draws one bordered cell, grey when asked.
func (k kbPDF) cell(x0, x1, y, h float64, grey bool) {
	style := "D"
	if grey {
		k.SetFillColor(kbGrey[0], kbGrey[1], kbGrey[2])
		style = "FD"
	}
	k.Rect(x0, y, x1-x0, h, style)
}

// row draws the six cells of a table row; greyOut fills the Ausgabe cell.
func (k kbPDF) row(y, h float64, greyOut bool) {
	for i := range 6 {
		k.cell(kbRules[i], kbRules[i+1], y, h, greyOut && i == 5)
	}
}

// amount writes a right-aligned amount into column 4 (Einnahme) or 5 (Ausgabe); totals are bold and larger.
func (k kbPDF) amount(column int, y, h float64, value string, total bool) {
	if value == "" {
		return
	}
	style, size := "", kbValueSize
	if total {
		style, size = "B", kbTotalSize
	}
	k.textRight(kbRules[column+1]-kbPad, y+h/2+capHalf(size), value, style, size)
}

// label writes the lines of a bold label from the first baseline down.
func (k kbPDF) label(x, baseline float64, lines ...string) {
	for i, line := range lines {
		k.text(x, baseline+float64(i)*kbLineGap, line, "B", kbLabelSize)
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

// headBlock draws the title, Studienvertretung/Studienlabor/Referat and Wirtschaftsjahr rows of the first sheet and
// returns where the table continues.
func (k kbPDF) headBlock(b cashbook) float64 {
	left, split, right := kbRules[0], kbRules[2], kbRules[6]
	y := kbTop
	k.cell(left, right, y, kbTitleRow, false)
	k.font("B", 18, kbInk)
	k.Text((left+right-k.GetStringWidth("Kassabuch"))/2, y+kbTitleInset, "Kassabuch")
	y += kbTitleRow
	k.cell(left, split, y, kbOrgRow, false)
	k.cell(split, right, y, kbOrgRow, false)
	k.label(left+kbPad, y+kbHeadInset, "Studienvertretung", "Studienlabor", "Referat")
	k.text(split+kbPad, y+kbOrgRow/2+capHalf(kbLabelSize), "Makerspace (Studienlabor)", "", kbLabelSize)
	y += kbOrgRow
	k.cell(left, split, y, kbYearRow, false)
	k.cell(split, right, y, kbYearRow, false)
	k.label(left+kbPad, y+kbHeadInset, "Wirtschaftsjahr")
	k.font("", kbLabelSize, kbInk)
	year := k.fit(b.yearText(), "", kbLabelSize, 8, right-split-2*kbPad)
	k.Text(split+kbPad, y+kbHeadInset, year)
	return y + kbYearRow
}

// wrap breaks encoded text into at most two lines of the width in the given font, shortening the second line with
// an ellipsis when the text is longer still.
func (k kbPDF) wrap(text string, size, width float64) []string {
	k.SetFont("Helvetica", "", size)
	var lines []string
	// SplitLines keeps the cell margin free on both sides; the inset here is kbPad already.
	for _, part := range k.SplitLines([]byte(text), width+2*k.GetCellMargin()) {
		lines = append(lines, string(part))
	}
	if len(lines) > 2 {
		lines = []string{lines[0], k.fitEncoded(strings.Join(lines[1:], " "), "", size, size, width)}
	}
	return lines
}

// entry fills one body row. A long cashier name takes two smaller lines; a long text takes two smaller lines above
// the receipt number.
func (k kbPDF) entry(b cashbook, n int, y, h float64) {
	line := b.lines[n]
	middle := y + h/2 + capHalf(kbValueSize)
	k.text(kbRules[0]+kbPad, middle, strconv.Itoa(n+1), "", kbValueSize)
	k.text(kbRules[1]+kbPad, middle, line.at.In(b.location).Format("02.01.2006"), "", kbValueSize)
	x, width := kbRules[2]+kbPad, kbRules[3]-kbRules[2]-2*kbPad
	name := k.tr(line.recordedBy)
	k.SetFont("Helvetica", "", kbValueSize)
	if k.GetStringWidth(name) <= width {
		k.Text(x, middle, name)
	} else if parts := k.wrap(name, 8.5, width); len(parts) == 1 {
		k.Text(x, y+h/2+capHalf(8.5), parts[0])
	} else {
		for i, part := range parts {
			k.Text(x, y+h/2-0.63+float64(i)*3.4, part)
		}
	}
	x, width = kbRules[3]+kbPad, kbRules[4]-kbRules[3]-2*kbPad
	text := k.tr(germanWords.describe(line, !b.withBalance))
	refBaseline, refSize := y+7.54, kbRefSize
	size := kbTextSize
	for ; size > 7.5; size -= 0.5 {
		if k.SetFont("Helvetica", "", size); k.GetStringWidth(text) <= width {
			break
		}
	}
	if parts := k.wrap(text, size, width); len(parts) == 1 {
		k.Text(x, y+4.17, parts[0])
	} else {
		for i, part := range parts {
			k.Text(x, y+3.05+float64(i)*2.9, part)
		}
		refBaseline, refSize = y+8.6, 6
	}
	k.font("", refSize, kbRef)
	k.Text(x, refBaseline, k.fit(line.reference, "", refSize, refSize, width))
	in, out := b.amounts(line)
	k.amount(4, y, h, optionalAmount(in, germanAmount), false)
	k.amount(5, y, h, optionalAmount(out, germanAmount), false)
}

// finalSheet draws the totals, the opening and closing balance and the three signature fields.
func (k kbPDF) finalSheet(b cashbook) {
	y := kbTop
	totals := []struct {
		label   string
		in, out string
		greyOut bool
	}{
		{"Gesamtsumme (aller Einnahmen & Ausgaben)", germanAmount(b.totalIn), germanAmount(b.totalOut), false},
		{"Anfangsbestand (Wirtschaftsjahr)", "", "", true},
		{"Endbestand (Wirtschaftsjahr)", "", "", true},
	}
	if b.withBalance {
		totals[1].in, totals[2].in = germanAmount(b.opening), germanAmount(b.closing)
	}
	for i, total := range totals {
		h := kbTotalRows[i]
		k.cell(kbRules[0], kbRules[4], y, h, false)
		k.cell(kbRules[4], kbRules[5], y, h, false)
		k.cell(kbRules[5], kbRules[6], y, h, total.greyOut)
		k.textRight(kbRules[4]-kbPad, y+kbTotalInset, total.label, "B", kbLabelSize)
		k.amount(4, y, h, total.in, true)
		k.amount(5, y, h, total.out, true)
		y += h
	}
	for i, role := range []string{"Kostenstellenverantwortliche/r", "Wirtschaftsreferent/in", "Vorsitzende/r"} {
		h := kbSignatureRows[i]
		k.cell(kbRules[0], kbSignatureEnd, y, h, false)
		k.cell(kbSignatureEnd, kbRules[6], y, h, false)
		baseline := y + h/2 - 0.8
		k.textRight(kbSignatureEnd-kbPad, baseline, "Name, Datum & Unterschrift", "B", kbLabelSize)
		k.textRight(kbSignatureEnd-kbPad, baseline+4.45, role, "B", kbLabelSize)
		y += h
	}
}

func renderCashbookPDF(b cashbook) ([]byte, error) {
	letterhead, err := kbLetterheadOps()
	if err != nil {
		return nil, fmt.Errorf("read cashbook letterhead: %w", err)
	}
	pdf := fpdf.New("P", "mm", "A4", "")
	pdf.SetMargins(0, 0, 0)
	pdf.SetAutoPageBreak(false, 0)
	pdf.SetTitle("Kassabuch "+b.yearText(), true)
	pdf.SetCreator("Makerspace Core", true)
	k := kbPDF{Fpdf: pdf, tr: pdf.UnicodeTranslatorFromDescriptor("")}
	var template fpdf.Template
	newPage := func() {
		pdf.AddPage()
		if template == nil {
			// One form XObject carries the letterhead, so its outlines are stored once however many pages follow.
			template = pdf.CreateTemplate(func(t *fpdf.Tpl) { drawLetterhead(&t.Fpdf, letterhead) })
		}
		pdf.UseTemplate(template)
		pdf.SetDrawColor(0, 0, 0)
		pdf.SetLineWidth(kbRule)
	}
	balance := b.opening
	for _, sheet := range layoutCashbook(len(b.lines)) {
		newPage()
		g, y := kbNextSheet, kbTop
		if sheet.first == 0 {
			g, y = kbFirstSheet, k.headBlock(b)
		}
		// The carried balance and the balance rows belong to the cash register; with every payment method there is
		// no balance, so those cells stay empty.
		k.row(y, g.carry, true)
		k.label(kbRules[3]+kbPad, y+g.carryInset, "Bestand/Übertrag von", "vorheriger Seite")
		if b.withBalance {
			k.amount(4, y, g.carry, germanAmount(balance), true)
		}
		y += g.carry
		k.row(y, g.head, false)
		for i, title := range []string{"Nr.", "Datum", "Kassierer*in", "Text", "Einnahme", "Ausgabe"} {
			size := kbLabelSize
			if g.headSmall && i == 2 {
				size = 10.56 // as on the form, where the narrow header row needs it
			}
			k.text(kbRules[i]+kbPad, y+g.headInset, title, "B", size)
		}
		y += g.head
		sumIn, sumOut := decimal.Zero, decimal.Zero
		for i := range g.rows {
			k.row(y, g.body, false)
			if n := sheet.first + i; n < sheet.last {
				k.entry(b, n, y, g.body)
				in, out := b.amounts(b.lines[n])
				sumIn, sumOut = sumIn.Add(in), sumOut.Add(out)
				balance = b.lines[n].balance
			}
			y += g.body
		}
		k.row(y, g.sum, b.withBalance)
		k.label(kbRules[3]+kbPad, y+kbSumInset, "Summe/Bestand")
		if b.withBalance {
			k.amount(4, y, g.sum, germanAmount(balance), true)
		} else {
			k.amount(4, y, g.sum, germanAmount(sumIn), true)
			k.amount(5, y, g.sum, germanAmount(sumOut), true)
		}
	}
	newPage()
	k.finalSheet(b)
	if err := pdf.Error(); err != nil {
		return nil, fmt.Errorf("render cashbook pdf: %w", err)
	}
	var out bytes.Buffer
	if err := pdf.Output(&out); err != nil {
		return nil, fmt.Errorf("write cashbook pdf: %w", err)
	}
	return out.Bytes(), nil
}
