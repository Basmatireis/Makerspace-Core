package engine

import (
	"strings"

	"github.com/shopspring/decimal"
)

// The form table (sheet) reproduces paper forms such as the HTU Kassabuch: every sheet has a fixed number of rows
// at fixed page positions, opened by the carried balance and closed by the sums. Text in its cells is centred on
// the height of capitals, as on the form.

const (
	sheetPad        = 1.88 // text inset from a rule
	sheetStroke     = 0.17
	sheetShrinkStep = 0.5
	sheetShrinkBy   = 1.5 // a cell's text shrinks at most this many points before it wraps
	sheetMaxLines   = 2
	sheetSubShrink  = 1.0 // the sub line of a wrapped cell is this much smaller
)

type sheetItem struct {
	block *Block
	scope *scope
}

// sheetGeometry is the row heights of a sheet; the first sheet may differ.
type sheetGeometry struct {
	top                   float64
	rows                  int
	carry, head, row, sum float64
}

func (r *renderer) sheetGeometry(b *Block, first bool) sheetGeometry {
	g := sheetGeometry{
		top:   deref(b.NextTop, r.bodyTop()),
		rows:  b.RowsNext,
		carry: r.mm(b.CarryHeight, 9.5),
		head:  r.mm(b.HeadHeight, 6),
		row:   r.mm(b.RowHeight, 9.5),
		sum:   r.mm(b.SumHeight, 9.5),
	}
	if first {
		g.top, g.rows = deref(b.FirstTop, r.bodyTop()), b.RowsFirst
		g.carry = r.mm(b.CarryHeightFirst, g.carry)
		g.head = r.mm(b.HeadHeightFirst, g.head)
		g.row = r.mm(b.RowHeightFirst, g.row)
		g.sum = r.mm(b.SumHeightFirst, g.sum)
	}
	g.rows = max(g.rows, 1)
	return g
}

// sheetStyles are the resolved text appearances of a form table.
type sheetStyles struct {
	header, body, sub, totals tstyle
	rule                      rgb
}

func (r *renderer) sheetStyles(b *Block) sheetStyles {
	rule := r.color(b.Color, mustHex("#3c3c3c"))
	text := r.color(b.TextColor, rule)
	sub := r.color(b.SubColor, mustHex("#6f6f6f"))
	base := r.doc.Page.BaseSize
	style := func(size float64, weight int, color rgb, lineHeight float64, ref string) tstyle {
		st := tstyle{font: r.doc.Page.Font, weight: weight, size: size, color: color, lineHeight: lineHeight}
		return r.withRef(st, ref)
	}
	return sheetStyles{
		header: style(base+2, 600, text, 1.15, b.HeaderStyle),
		body:   style(base, 400, text, 1.1, b.BodyStyle),
		sub:    style(max(base-2, 4), 400, sub, 1.1, b.SubStyle),
		totals: style(base+1, 600, text, 1.2, b.TotalsStyle),
		rule:   rule,
	}
}

// sheet lays out a form table: the first sheet on the current page (a new one when the flow already reaches
// below its top), every further sheet on a page of its own. The flow continues below the last sheet.
func (p *paginator) sheet(it item) error {
	r := p.r
	b, sc := it.sheet.block, it.sheet.scope
	if len(b.Columns) < minSheetColumns || b.Carry == nil || b.Sum == nil {
		return nil
	}
	entries, canonical := r.ev.list(b.ID, b.Source, sc)
	first := r.sheetGeometry(b, true)
	if p.current().used && p.y > first.top+epsilon {
		if err := p.newPage(); err != nil {
			return err
		}
	}
	carry := decimal.Zero
	if _, ok := r.ev.schema.lookup("totals.opening"); ok {
		value, _ := r.ev.value(b.ID, "totals.opening", sc)
		if d, ok := toDecimal(value); ok {
			carry = d
		}
	}
	start := 0
	for number := 1; ; number++ {
		if err := r.cancelled(); err != nil {
			return err
		}
		g := r.sheetGeometry(b, number == 1)
		if number > 1 {
			if err := p.newPage(); err != nil {
				return err
			}
		}
		end := min(start+g.rows, len(entries))
		chunk := entries[start:end]
		sumIn, sumOut := r.sheetSums(b, canonical, sc, chunk)
		balance := carry.Add(sumIn).Sub(sumOut)
		sheetScope := sc.with(map[string]any{"sheet": map[string]any{
			"number": number, "carry": carry, "sumIn": sumIn, "sumOut": sumOut, "balance": balance,
		}})
		drawn := r.sheetPage(b, g, sheetScope, canonical, chunk, start)
		page := p.current()
		page.items = append(page.items, placed{it: drawn, y: g.top})
		page.used = true
		p.y = g.top + drawn.h + blockAfter
		carry, start = balance, end
		if start >= len(entries) {
			return nil
		}
	}
}

// sheetSums adds the raw values of the in and out columns (the last two) of the entries on a sheet: the first
// variable of each column's value. A value the reader may not see adds nothing.
func (r *renderer) sheetSums(b *Block, canonical string, sc *scope, chunk []any) (decimal.Decimal, decimal.Decimal) {
	n := len(b.Columns)
	paths := [2]string{firstPath(b.Columns[n-2].Value), firstPath(b.Columns[n-1].Value)}
	sums := [2]decimal.Decimal{decimal.Zero, decimal.Zero}
	for i, entry := range chunk {
		entryScope := sc.loop(b.As, canonical, entry, i+1)
		for c, path := range paths {
			if path == "" {
				continue
			}
			value, _ := r.ev.value(b.ID, path, entryScope)
			if d, ok := toDecimal(value); ok {
				sums[c] = sums[c].Add(d)
			}
		}
	}
	return sums[0], sums[1]
}

func firstPath(text string) string {
	for _, seg := range parseText(text) {
		if seg.token && seg.err == "" {
			return seg.expr.path
		}
	}
	return ""
}

// sheetPage builds the drawing of one sheet at its fixed page position; the item records its own box.
func (r *renderer) sheetPage(b *Block, g sheetGeometry, sc *scope, canonical string, chunk []any, offset int) item {
	st := r.sheetStyles(b)
	cols := b.Columns
	n := len(cols)
	left, right := deref(cols[0].X, 0), 0.0
	for _, c := range cols {
		left = min(left, deref(c.X, 0))
		right = max(right, deref(c.X, 0)+deref(c.W, 0))
	}
	labelCol, inCol, outCol := n-3, n-2, n-1
	stroke := r.mm(b.Stroke, sheetStroke)
	outFill := func(c Color) rgb { return r.color(c, transparent) }
	rows := g.rows
	if !b.FillEmpty {
		rows = len(chunk)
	}
	height := g.carry + g.head + float64(rows)*g.row + g.sum

	carryLabel := r.ev.text(b.ID, b.Carry.Label, sc)
	carryValue := r.ev.text(b.ID, b.Carry.Value, sc)
	sumLabel := r.ev.text(b.ID, b.Sum.Label, sc)
	sumIn := r.ev.text(b.ID, b.Sum.In, sc)
	sumOut := r.ev.text(b.ID, b.Sum.Out, sc)
	sumBalance := strings.TrimSpace(r.ev.text(b.ID, b.Sum.Balance, sc))
	headers := make([]string, n)
	for i, c := range cols {
		headers[i] = r.ev.text(b.ID, c.Header, sc)
	}
	type cell struct{ value, sub string }
	cells := make([][]cell, len(chunk))
	for i, entry := range chunk {
		entryScope := sc.loop(b.As, canonical, entry, offset+i+1)
		cells[i] = make([]cell, n)
		for c, col := range cols {
			cells[i][c] = cell{value: r.ev.text(b.ID, col.Value, entryScope), sub: r.ev.text(b.ID, col.Sub, entryScope)}
		}
	}
	colX := func(i int) float64 { return deref(cols[i].X, 0) }
	colW := func(i int) float64 { return deref(cols[i].W, 0) }

	draw := func(_, _, _ float64) {
		y := g.top
		grid := func(h float64, fill rgb) {
			for i := range cols {
				cellFill := transparent
				if i == outCol {
					cellFill = fill
				}
				r.rect(colX(i), y, colW(i), h, stroke, st.rule, cellFill)
			}
		}
		grid(g.carry, outFill(b.Carry.OutFill))
		r.sheetLabel(carryLabel, st.header, colX(labelCol), colW(labelCol), y, g.carry)
		r.sheetSingle(carryValue, st.totals, colX(inCol), colW(inCol), y, g.carry, "right")
		y += g.carry
		grid(g.head, transparent)
		for i, c := range cols {
			align := c.HeaderAlign
			if align == "" {
				align = "left"
			}
			r.sheetSingle(headers[i], st.header, colX(i), colW(i), y, g.head, align)
		}
		y += g.head
		for row := 0; row < rows; row++ {
			grid(g.row, transparent)
			if row < len(cells) {
				for c, col := range cols {
					r.sheetCell(cells[row][c].value, cells[row][c].sub, st, colX(c), colW(c), y, g.row, col.Align)
				}
			}
			y += g.row
		}
		grid(g.sum, outFill(b.Sum.OutFill))
		r.sheetLabel(sumLabel, st.header, colX(labelCol), colW(labelCol), y, g.sum)
		if sumBalance == "" {
			r.sheetSingle(sumIn, st.totals, colX(inCol), colW(inCol), y, g.sum, "right")
			r.sheetSingle(sumOut, st.totals, colX(outCol), colW(outCol), y, g.sum, "right")
		} else {
			half := g.sum / 2
			small := st.totals
			small.weight = 400
			r.sheetSingle(sumIn, small, colX(inCol), colW(inCol), y, half, "right")
			r.sheetSingle(sumOut, small, colX(outCol), colW(outCol), y, half, "right")
			span := colX(outCol) + colW(outCol) - colX(inCol)
			r.sheetSingle(sumBalance, st.totals, colX(inCol), span, y+half, half, "right")
		}
		r.box(b.ID, left, g.top, right-left, height)
	}
	return item{h: height, draw: draw}
}

// sheetLines writes lines centred on the height of capitals: from the top of the first line's capitals to the
// last baseline.
func (r *renderer) sheetLines(lines []string, styles []tstyle, x, w, y, h float64, align string) {
	if len(lines) == 0 {
		return
	}
	extent := styles[0].capHeight()
	for i := 0; i < len(lines)-1; i++ {
		extent += styles[i].pitch()
	}
	baseline := y + (h-extent)/2 + styles[0].capHeight()
	for i, line := range lines {
		r.setFont(styles[i])
		r.drawLine(styles[i], line, x, w, sheetPad, align, baseline)
		baseline += styles[i].pitch()
	}
}

// sheetSingle writes one line, shrinking it to fit the cell and shortening it with … when that is not enough.
func (r *renderer) sheetSingle(text string, st tstyle, x, w, y, h float64, align string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	fitted, style := r.shrink(text, st, w-2*sheetPad)
	r.sheetLines([]string{r.ellipsize(style, fitted, w-2*sheetPad)}, []tstyle{style}, x, w, y, h, align)
}

// sheetLabel writes a label whose lines are separated by newlines, without wrapping.
func (r *renderer) sheetLabel(text string, st tstyle, x, w, y, h float64) {
	var lines []string
	var styles []tstyle
	for _, line := range strings.Split(strings.TrimSpace(text), "\n") {
		lines = append(lines, strings.TrimSpace(line))
		styles = append(styles, st)
	}
	if len(lines) == 1 && lines[0] == "" {
		return
	}
	r.sheetLines(lines, styles, x, w, y, h, "left")
}

// shrink lowers the size in steps until the text fits on one line or the smallest size is reached.
func (r *renderer) shrink(text string, st tstyle, width float64) (string, tstyle) {
	smallest := max(st.size-sheetShrinkBy, 4)
	for {
		r.setFont(st)
		if r.width(st, text) <= width+epsilon || st.size-sheetShrinkStep < smallest-epsilon {
			return text, st
		}
		st.size -= sheetShrinkStep
	}
}

// sheetCell writes an entry: the value on one line (shrunk) or two (the second shortened), and the sub line below.
func (r *renderer) sheetCell(value, sub string, st sheetStyles, x, w, y, h float64, align string) {
	value, sub = strings.TrimSpace(value), strings.TrimSpace(sub)
	inner := w - 2*sheetPad
	var lines []string
	var styles []tstyle
	if value != "" {
		fitted, style := r.shrink(value, st.body, inner)
		if r.width(style, fitted) <= inner+epsilon {
			lines = []string{fitted}
		} else {
			lines = r.wrap(style, fitted, inner)
			if len(lines) > sheetMaxLines {
				rest := strings.Join(lines[sheetMaxLines-1:], " ")
				lines = append(lines[:sheetMaxLines-1], r.ellipsize(style, rest, inner))
			}
		}
		for range lines {
			styles = append(styles, style)
		}
	}
	if sub != "" {
		subStyle := st.sub
		if len(lines) > 1 {
			subStyle.size = max(subStyle.size-sheetSubShrink, 4)
		}
		lines = append(lines, r.ellipsize(subStyle, sub, inner))
		styles = append(styles, subStyle)
	}
	r.sheetLines(lines, styles, x, w, y, h, align)
}
