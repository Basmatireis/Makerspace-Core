package engine

import (
	"regexp"
	"strconv"
	"strings"
)

// item is one unbreakable piece of a flow: a paragraph, a table row, a whole box. It is laid out for a width when
// built and drawn later at its place.
type item struct {
	id     string
	owners []string // loop and condition blocks the item came from
	h      float64
	after  float64
	// w is the item's own width; 0 takes the width of its container.
	w float64
	// natural is the width the content needs; a negative value means the whole container.
	natural float64
	draw    func(x, y, w float64)

	keepWithNext bool
	pageBreak    bool
	sheet        *sheetItem

	table        string
	maxRows      int
	maxRowsFirst int
	header       *item
}

// positioned are the kinds a layer places by x, y, w and h; every other kind flows in a box at x and y.
var positioned = map[string]bool{
	BlockPText: true, BlockLine: true, BlockRect: true, BlockGraphic: true, BlockEllipse: true,
	BlockPicture: true, BlockQR: true, BlockBarcode: true,
}

// place draws an item and records the boxes of its node and of the blocks it came from.
func (r *renderer) place(it item, x, y, w float64) {
	width := w
	if it.w > 0 {
		width = it.w
	}
	if it.h > 0 || it.draw != nil {
		r.box(it.id, x, y, width, it.h)
		for _, owner := range it.owners {
			r.box(owner, x, y, width, it.h)
		}
	}
	if it.draw != nil {
		it.draw(x, y, w)
	}
}

// stack draws items one below the other without page breaks.
func (r *renderer) stack(items []item, x, y, w float64) {
	for _, it := range items {
		if it.pageBreak || it.sheet != nil {
			continue
		}
		r.place(it, x, y, w)
		y += it.h + it.after
	}
}

// stackHeight is the height of stacked items; the spacing after the last one does not count.
func stackHeight(items []item) float64 {
	total, last := 0.0, 0.0
	for _, it := range items {
		if it.pageBreak || it.sheet != nil {
			continue
		}
		total += it.h + it.after
		last = it.after
	}
	return max(total-last, 0)
}

func stackNatural(items []item) float64 {
	widest := 0.0
	for _, it := range items {
		if it.natural < 0 {
			return -1
		}
		widest = max(widest, it.natural)
	}
	return widest
}

// flow builds the items of blocks for a width. body says whether page breaks and form tables take effect.
func (r *renderer) flow(blocks []Block, sc *scope, width float64, body bool) ([]item, error) {
	var items []item
	for i := range blocks {
		if err := r.cancelled(); err != nil {
			return nil, err
		}
		built, err := r.blockItems(&blocks[i], sc, width, body)
		if err != nil {
			return nil, err
		}
		if r.items += len(built); r.items > maxItems {
			return nil, renderLimit("The template repeats too much content")
		}
		items = append(items, built...)
	}
	return items, nil
}

func owned(items []item, owner string) []item {
	for i := range items {
		items[i].owners = append(items[i].owners, owner)
	}
	return items
}

var paragraphBreak = regexp.MustCompile(`\n[ \t]*\n\s*`)

func paragraphs(text string) []string {
	var out []string
	for _, p := range paragraphBreak.Split(strings.ReplaceAll(text, "\r\n", "\n"), -1) {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func (r *renderer) textItem(id string, t textLines, after float64) item {
	return item{
		id: id, h: t.height(), after: after, natural: r.natural(t),
		draw: func(x, y, w float64) { r.drawLines(t, x, y, w) },
	}
}

// blockItems lays out one block; the cases keep the layout rules of all block types side by side.
func (r *renderer) blockItems(b *Block, sc *scope, width float64, body bool) ([]item, error) {
	ev := r.ev
	switch b.Type {
	case BlockHeading:
		st := r.blockStyle(b, textDefaults{weight: 600})
		text := strings.TrimSpace(ev.text(b.ID, b.Text, sc))
		if text == "" {
			return nil, nil
		}
		heading := r.textItem(b.ID, r.layoutText(text, st, width, cellInset, b.Align), headingAfter)
		heading.keepWithNext = true
		return []item{heading}, nil
	case BlockText, BlockPText:
		d, after := textDefaults{}, textAfter
		if b.Type == BlockPText {
			d, after = textDefaults{size: 9, lineHeight: 1.25}, ptextAfter
		}
		st := r.blockStyle(b, d)
		var items []item
		for _, p := range paragraphs(ev.text(b.ID, b.Text, sc)) {
			items = append(items, r.textItem(b.ID, r.layoutText(p, st, width, cellInset, b.Align), after))
		}
		return items, nil
	case BlockValue:
		return []item{r.valueItem(b, sc, width)}, nil
	case BlockList:
		return r.listItems(b, sc, width), nil
	case BlockFields:
		return r.fieldItems(b, sc, width), nil
	case BlockTable:
		return r.tableItems(b, sc, width)
	case BlockSheet:
		if !body {
			return nil, nil
		}
		return []item{{id: b.ID, sheet: &sheetItem{block: b, scope: sc}}}, nil
	case BlockRepeat:
		entries, canonical := ev.list(b.ID, b.Source, sc)
		var items []item
		for i, entry := range entries {
			if err := r.cancelled(); err != nil {
				return nil, err
			}
			built, err := r.flow(b.Blocks, sc.loop(b.As, canonical, entry, i+1), width, body)
			if err != nil {
				return nil, err
			}
			items = append(items, built...)
		}
		return owned(items, b.ID), nil
	case BlockIf:
		branch := b.Else
		if ev.test(b.ID, b.When, sc) {
			branch = b.Then
		}
		items, err := r.flow(branch, sc, width, body)
		return owned(items, b.ID), err
	case BlockSwitch:
		value, _ := ev.value(b.ID, b.Path, sc)
		branch := b.Else
		for _, c := range b.Cases {
			if stringValue(value) == c.Value {
				branch = c.Blocks
				break
			}
		}
		items, err := r.flow(branch, sc, width, body)
		return owned(items, b.ID), err
	case BlockColumns:
		it, err := r.columnsItem(b, sc, width)
		if err != nil {
			return nil, err
		}
		return []item{it}, nil
	case BlockBox:
		it, err := r.boxItem(b, sc, width)
		if err != nil {
			return nil, err
		}
		return []item{it}, nil
	case BlockImage:
		return r.logoItem(b), nil
	case BlockSignatures:
		return []item{r.signaturesItem(b, sc, width)}, nil
	case BlockCheckbox:
		return []item{r.checkboxItem(b, sc, width)}, nil
	case BlockInputLine:
		return []item{r.inputLineItem(b, sc, width)}, nil
	case BlockSpacer:
		h := r.mm(b.Height, 4)
		if h <= 0 {
			return nil, nil
		}
		return []item{{id: b.ID, h: h, natural: 0}}, nil
	case BlockDivider:
		stroke := r.mm(b.Stroke, 0.3)
		color := r.color(b.Color, mustHex(defaultRuleGrey))
		return []item{{
			id: b.ID, h: dividerMargin*2 + stroke, natural: -1,
			draw: func(x, y, w float64) {
				r.line(x, y+dividerMargin+stroke/2, x+w, y+dividerMargin+stroke/2, stroke, color)
			},
		}}, nil
	case BlockPageBreak:
		if !body {
			return nil, nil
		}
		return []item{{id: b.ID, pageBreak: true}}, nil
	case BlockLine:
		w := width
		if b.W != nil {
			w = min(*b.W, width)
		}
		h := deref(b.H, 0)
		stroke := r.mm(b.Stroke, defaultStroke)
		color := r.color(b.Color, mustHex(defaultInk))
		return []item{{
			id: b.ID, h: lineMargin*2 + max(stroke, h), after: 0, w: max(w, stroke), natural: w,
			draw: func(x, y, _ float64) {
				top := y + lineMargin + stroke/2
				r.line(x, top, x+w, top+h, stroke, color)
			},
		}}, nil
	case BlockRect, BlockEllipse, BlockPicture, BlockGraphic, BlockQR, BlockBarcode:
		w := min(deref(b.W, width), width)
		if b.Type == BlockRect && b.W == nil {
			w = width
		}
		h := deref(b.H, 10)
		return []item{{
			id: b.ID, h: h, after: blockAfter, w: w, natural: w,
			draw: func(x, y, _ float64) { r.shape(b, sc, x, y, w, h) },
		}}, nil
	}
	return nil, nil
}

func (r *renderer) valueItem(b *Block, sc *scope, width float64) item {
	label := r.ev.text(b.ID, b.Label, sc)
	value := r.ev.text(b.ID, b.Value, sc)
	labelSt := r.partStyle(b.LabelStyle, textDefaults{size: 8, color: "#525252"})
	valueSt := r.blockStyle(b, textDefaults{size: 16, weight: 600, lineHeight: 1.2})
	var parts []textLines
	if strings.TrimSpace(label) != "" {
		parts = append(parts, r.layoutText(label, labelSt, width, cellInset, b.Align))
	}
	parts = append(parts, r.layoutText(value, valueSt, width, cellInset, b.Align))
	h, natural := 0.0, 0.0
	for _, p := range parts {
		h += p.height()
		natural = max(natural, r.natural(p))
	}
	return item{
		id: b.ID, h: h, after: blockAfter, natural: natural,
		draw: func(x, y, w float64) {
			for _, p := range parts {
				r.drawLines(p, x, y, w)
				y += p.height()
			}
		},
	}
}

func (r *renderer) listItems(b *Block, sc *scope, width float64) []item {
	entries, canonical := r.ev.list(b.ID, b.Source, sc)
	st := r.blockStyle(b, textDefaults{lineHeight: 1.4})
	var items []item
	if len(entries) == 0 {
		empty := r.ev.text(b.ID, b.EmptyText, sc)
		if empty == "" {
			empty = "No entries"
		}
		muted := st
		muted.color = mustHex("#6f6f6f")
		items = append(items, r.textItem(b.ID, r.layoutText(empty, muted, width, cellInset, "left"), 0))
	}
	for i, entry := range entries {
		text := r.ev.text(b.ID, b.Text, sc.loop(b.As, canonical, entry, i+1))
		marker := "•"
		if b.Style == "number" {
			marker = strconv.Itoa(i+1) + "."
		}
		t := r.layoutText(text, st, width-listIndent, cellInset, "left")
		items = append(items, item{
			id: b.ID, h: t.height(), natural: r.natural(t) + listIndent,
			draw: func(x, y, w float64) {
				r.setFont(st)
				r.drawLine(st, marker, x, listIndent, cellInset, "left", st.baseline(y))
				r.drawLines(t, x+listIndent, y, w-listIndent)
			},
		})
	}
	if len(items) > 0 {
		items[len(items)-1].after = blockAfter
	}
	return items
}

func (r *renderer) fieldItems(b *Block, sc *scope, width float64) []item {
	labelWidth := min(r.mm(b.LabelWidth, 48), width)
	labelColor := "#525252"
	if b.Boxed {
		labelColor = "#3c3c3c"
	}
	labelSt := r.partStyle(b.LabelStyle, textDefaults{color: labelColor, lineHeight: 1.4})
	valueSt := r.partStyle(b.ValueStyle, textDefaults{lineHeight: 1.4})
	fill := r.color(b.Fill, transparent)
	rule := r.color(b.RuleColor, mustHex("#3c3c3c"))
	pad, gap := 0.0, fieldsRowGap
	valueAlign := "left"
	if b.Boxed {
		pad, gap, valueAlign = boxedPadding, 0, "right"
	}
	var items []item
	for _, row := range b.Rows {
		if !r.ev.test(b.ID, row.When, sc) {
			continue
		}
		st := valueSt
		if row.Bold {
			st.weight = 600
		}
		label := r.layoutText(r.ev.text(b.ID, row.Label, sc), labelSt, labelWidth, cellInset, "left")
		value := r.layoutText(r.ev.text(b.ID, row.Value, sc), st, width-labelWidth, cellInset, valueAlign)
		h := max(label.height(), value.height()) + 2*pad
		items = append(items, item{
			id: b.ID, h: h, after: gap, natural: -1,
			draw: func(x, y, w float64) {
				r.fillRect(x, y, w, h, fill)
				r.drawLines(label, x, y+pad, labelWidth)
				r.drawLines(value, x+labelWidth, y+pad, w-labelWidth)
				if b.Boxed {
					r.line(x, y+h, x+w, y+h, 0.17, rule)
				}
			},
		})
	}
	return items
}

func (r *renderer) tableItems(b *Block, sc *scope, width float64) ([]item, error) {
	entries, canonical := r.ev.list(b.ID, b.Source, sc)
	cols := b.Columns
	if len(cols) == 0 {
		return nil, nil
	}
	total := 0.0
	for _, c := range cols {
		total += deref(c.Width, 1)
	}
	if total <= 0 {
		total = 1
	}
	widths := make([]float64, len(cols))
	for i, c := range cols {
		widths[i] = width * deref(c.Width, 1) / total
	}
	headerSt := r.partStyle(b.HeaderStyle, textDefaults{sizeDelta: -0.5, weight: 600, lineHeight: 1.9})
	bodySt := r.partStyle(b.BodyStyle, textDefaults{lineHeight: 1.5})
	subSt := r.partStyle(b.SubStyle, textDefaults{sizeDelta: -2, color: "#6f6f6f", lineHeight: 1.3})
	totalsSt := r.partStyle(b.TotalsStyle, textDefaults{lineHeight: 1.9})
	headerFill := r.color(b.HeaderFill, transparent)
	headerRule := r.color(b.HeaderRule, mustHex(defaultInk))
	rowRule := r.color(b.RowRule, mustHex(defaultRuleGrey))
	zebra := r.color(b.Zebra, transparent)

	cells := func(texts []string, st tstyle) ([]textLines, float64) {
		out := make([]textLines, len(cols))
		h := 0.0
		for i, c := range cols {
			out[i] = r.layoutText(texts[i], st, widths[i], cellInset, c.Align)
			h = max(h, out[i].height())
		}
		return out, h
	}
	headerTexts := make([]string, len(cols))
	for i, c := range cols {
		headerTexts[i] = r.ev.text(b.ID, c.Header, sc)
	}
	headerCells, headerH := cells(headerTexts, headerSt)
	header := item{
		id: b.ID, h: headerH, keepWithNext: true, natural: -1,
		draw: func(x, y, w float64) {
			r.fillRect(x, y, w, headerH, headerFill)
			cx := x
			for i, cell := range headerCells {
				r.drawLines(cell, cx, y, widths[i])
				cx += widths[i]
			}
			r.line(x, y+headerH, x+w, y+headerH, tableRule, headerRule)
		},
	}
	items := []item{header}
	var repeat *item
	if b.RepeatHeader {
		repeat = &header
	}
	if len(entries) == 0 {
		empty := r.ev.text(b.ID, b.EmptyText, sc)
		if empty == "" {
			empty = "No entries"
		}
		t := r.layoutText(empty, subSt, width, cellInset, "left")
		items = append(items, r.textItem(b.ID, t, 0))
	}
	for i, entry := range entries {
		if err := r.cancelled(); err != nil {
			return nil, err
		}
		entryScope := sc.loop(b.As, canonical, entry, i+1)
		values := make([]textLines, len(cols))
		subs := make([]textLines, len(cols))
		heights := make([]float64, len(cols))
		rowH := 0.0
		for c, col := range cols {
			values[c] = r.layoutText(r.ev.text(b.ID, col.Value, entryScope), bodySt, widths[c], cellInset, col.Align)
			heights[c] = values[c].height()
			if col.Sub != "" {
				if sub := r.ev.text(b.ID, col.Sub, entryScope); strings.TrimSpace(sub) != "" {
					subs[c] = r.layoutText(sub, subSt, widths[c], cellInset, col.Align)
					heights[c] += subs[c].height()
				}
			}
			rowH = max(rowH, heights[c])
		}
		odd := i%2 == 1
		items = append(items, item{
			id: b.ID, h: rowH, natural: -1, table: b.ID, maxRows: b.MaxRows, maxRowsFirst: b.MaxRowsFirst,
			header: repeat,
			draw: func(x, y, w float64) {
				if odd {
					r.fillRect(x, y, w, rowH, zebra)
				}
				cx := x
				for c := range cols {
					top := y + (rowH-heights[c])/2
					r.drawLines(values[c], cx, top, widths[c])
					r.drawLines(subs[c], cx, top+values[c].height(), widths[c])
					cx += widths[c]
				}
				r.line(x, y+rowH, x+w, y+rowH, tableRule, rowRule)
			},
		})
	}
	labelWidth := width - widths[len(widths)-1]
	for _, row := range b.Totals {
		if !r.ev.test(b.ID, row.When, sc) {
			continue
		}
		st := totalsSt
		if row.Bold {
			st.size += 1.5
			st.weight = 600
		}
		// A bold row keeps the pitch of the totals style, so every totals row has the same height.
		st.lineHeight = totalsSt.pitch() / (st.size * ptToMM)
		label := r.layoutText(r.ev.text(b.ID, row.Label, sc), st, labelWidth, cellInset, "right")
		value := r.layoutText(r.ev.text(b.ID, row.Value, sc), st, widths[len(widths)-1], cellInset, "right")
		h := float64(max(len(label.lines), len(value.lines), 1)) * st.pitch()
		items = append(items, item{
			id: b.ID, h: h, natural: -1,
			draw: func(x, y, w float64) {
				r.drawLines(label, x, y, labelWidth)
				r.drawLines(value, x+labelWidth, y, w-labelWidth)
			},
		})
	}
	return items, nil
}

func (r *renderer) columnsItem(b *Block, sc *scope, width float64) (item, error) {
	gap := r.mm(b.Gap, 6)
	n := len(b.Columns)
	built := make([][]item, n)
	widths := make([]float64, n)
	shares, fixed, gaps := 0.0, 0.0, 0
	for i, col := range b.Columns {
		share := deref(col.Width, 1)
		if share > 0 {
			shares += share
			continue
		}
		// A content-width column takes what its blocks need, up to the whole width.
		items, err := r.flow(col.Blocks, sc, width, false)
		if err != nil {
			return item{}, err
		}
		natural := stackNatural(items)
		if natural < 0 {
			natural = width
		}
		widths[i] = min(natural, width)
		fixed += widths[i]
	}
	for i, col := range b.Columns {
		if deref(col.Width, 1) > 0 || widths[i] > 0 {
			gaps++
		}
	}
	free := max(width-fixed-gap*float64(max(gaps-1, 0)), 0)
	for i, col := range b.Columns {
		if share := deref(col.Width, 1); share > 0 {
			widths[i] = free * share / shares
		}
	}
	h := 0.0
	for i, col := range b.Columns {
		items, err := r.flow(col.Blocks, sc, max(widths[i], 0.1), false)
		if err != nil {
			return item{}, err
		}
		built[i] = items
		h = max(h, stackHeight(items))
	}
	natural := -1.0
	if shares == 0 {
		natural = fixed + gap*float64(max(gaps-1, 0))
	}
	return item{
		id: b.ID, h: h, after: blockAfter, natural: natural,
		draw: func(x, y, _ float64) {
			cx := x
			for i := range built {
				if widths[i] <= 0 {
					continue
				}
				r.stack(built[i], cx, y, widths[i])
				cx += widths[i] + gap
			}
		},
	}, nil
}

func (r *renderer) boxItem(b *Block, sc *scope, width float64) (item, error) {
	padding := r.mm(b.Padding, 4)
	stroke := r.mm(b.Stroke, 0)
	color := r.color(b.Color, mustHex(defaultRuleGrey))
	fill := r.color(b.Fill, transparent)
	inner := max(width-2*padding, 1)
	items, err := r.flow(b.Blocks, sc, inner, false)
	if err != nil {
		return item{}, err
	}
	h := stackHeight(items) + 2*padding
	return item{
		id: b.ID, h: h, after: blockAfter, natural: -1,
		draw: func(x, y, w float64) {
			r.rect(x, y, w, h, stroke, color, fill)
			r.stack(items, x+padding, y+padding, w-2*padding)
		},
	}, nil
}

func (r *renderer) logoItem(b *Block) []item {
	h := r.mm(b.Height, 12)
	logo := r.logo()
	if logo.failed != "" || h <= 0 {
		return nil
	}
	w := h * logo.width / logo.height
	return []item{{
		id: b.ID, h: h, w: w, natural: w,
		draw: func(x, y, _ float64) { r.drawImage(logo, x, y, w, h) },
	}}
}

func (r *renderer) signaturesItem(b *Block, sc *scope, width float64) item {
	n := max(len(b.Labels), 1)
	space := r.mm(b.Height, 18)
	st := r.partStyle(b.LabelStyle, textDefaults{size: 8.5, color: "#3c3c3c", lineHeight: 1.3})
	lineColor := r.color(b.LineColor, mustHex("#3c3c3c"))
	colW := (width - signatureGap*float64(n-1)) / float64(n)
	labels := make([]textLines, len(b.Labels))
	labelH := 0.0
	for i, label := range b.Labels {
		labels[i] = r.layoutText(r.ev.text(b.ID, label, sc), st, colW, 0, "left")
		labelH = max(labelH, labels[i].height())
	}
	h := signatureTop + space + signatureLabel + labelH
	return item{
		id: b.ID, h: h, after: blockAfter, natural: -1,
		draw: func(x, y, _ float64) {
			lineY := y + signatureTop + space
			for i := range labels {
				cx := x + float64(i)*(colW+signatureGap)
				r.line(cx, lineY, cx+colW, lineY, 0.17, lineColor)
				r.drawLines(labels[i], cx, lineY+signatureLabel, colW)
			}
		},
	}
}

func (r *renderer) checkboxItem(b *Block, sc *scope, width float64) item {
	st := r.blockStyle(b, textDefaults{})
	ticked := b.When != nil && b.When.Path != "" && r.ev.test(b.ID, b.When, sc)
	boxColor := r.color(b.BoxColor, mustHex(defaultInk))
	offset := checkboxSize + checkboxGap
	label := r.layoutText(r.ev.text(b.ID, b.Label, sc), st, width-offset, 0, "left")
	h := max(checkboxSize, label.height())
	return item{
		id: b.ID, h: h, after: ptextAfter, natural: r.natural(label) + offset,
		draw: func(x, y, w float64) {
			top := y + (h-checkboxSize)/2
			if len(label.lines) > 0 {
				top = y + (label.st.pitch()-checkboxSize)/2
			}
			r.rect(x, top, checkboxSize, checkboxSize, 0.25, boxColor, transparent)
			if ticked {
				inset := 0.7
				r.line(x+inset, top+inset, x+checkboxSize-inset, top+checkboxSize-inset, 0.3, boxColor)
				r.line(x+checkboxSize-inset, top+inset, x+inset, top+checkboxSize-inset, 0.3, boxColor)
			}
			r.drawLines(label, x+offset, y, w-offset)
		},
	}
}

func (r *renderer) inputLineItem(b *Block, sc *scope, width float64) item {
	st := r.partStyle(b.LabelStyle, textDefaults{color: "#525252"})
	lineColor := r.color(b.LineColor, mustHex(defaultInk))
	text := r.ev.text(b.ID, b.Label, sc)
	r.setFont(st)
	labelW := 0.0
	if text != "" {
		labelW = r.width(st, text) + checkboxGap
	}
	rowH := max(inputLineHeight, st.pitch())
	h := inputLineTop + rowH
	return item{
		id: b.ID, h: h, after: blockAfter, natural: -1,
		draw: func(x, y, w float64) {
			bottom := y + h
			r.setFont(st)
			r.drawLine(st, text, x, w, 0, "left", st.baseline(bottom-st.pitch()-0.5))
			end := x + w
			if b.LineWidth != nil && *b.LineWidth > 0 {
				end = min(x+labelW+*b.LineWidth, end)
			}
			r.line(x+labelW, bottom, end, bottom, 0.2, lineColor)
		},
	}
}

// shape draws the sized kinds into their box, in a flow or a layer.
func (r *renderer) shape(b *Block, sc *scope, x, y, w, h float64) {
	stroke := r.mm(b.Stroke, defaultStroke)
	color := r.color(b.Color, mustHex(defaultInk))
	switch b.Type {
	case BlockRect:
		r.rect(x, y, w, h, stroke, color, r.color(b.Fill, transparent))
	case BlockEllipse:
		fill := r.color(b.Fill, transparent)
		style := ""
		if !fill.none {
			r.pdf.SetFillColor(fill.r, fill.g, fill.b)
			style = "F"
		}
		if stroke > 0 && !color.none {
			r.pdf.SetDrawColor(color.r, color.g, color.b)
			r.pdf.SetLineWidth(stroke)
			style += "D"
		}
		if style != "" {
			r.pdf.Ellipse(x+w/2, y+h/2, w/2, h/2, 0, style)
		}
	case BlockPicture:
		loaded := r.asset(b.Asset)
		if loaded.failed != "" || loaded.art != nil {
			r.placeholder(b.ID, loaded, x, y, w, h)
			return
		}
		r.drawImage(loaded, x, y, w, h)
	case BlockGraphic:
		if b.Art == ArtLetterhead {
			r.drawLetterhead(x, y, w, h)
			return
		}
		loaded := r.asset(strings.TrimPrefix(b.Art, artAssetPrefix))
		if loaded.art == nil {
			r.placeholder(b.ID, loaded, x, y, w, h)
			return
		}
		r.drawArt(*loaded.art, x, y, w, h, r.color(b.Color, mustHex(defaultInk)))
	case BlockQR:
		r.qr(b.ID, r.ev.text(b.ID, b.Value, sc), x, y, w, h)
	case BlockBarcode:
		r.barcode(b, r.ev.text(b.ID, b.Value, sc), x, y, w, h)
	}
}

// placeholder marks an element whose image cannot be drawn and reports why.
func (r *renderer) placeholder(id string, loaded *loadedAsset, x, y, w, h float64) {
	message := loaded.failed
	if message == "" {
		message = "This element needs a PNG or JPEG image"
	}
	r.problems.warning(id, message)
	r.rect(x, y, w, h, 0.2, mustHex("#8d8d8d"), mustHex("#e0e0e0"))
}

// positioned draws a layer element at its own position and returns its box.
func (r *renderer) positioned(b *Block, sc *scope, x, y, w float64) Box {
	h := deref(b.H, 0)
	switch b.Type {
	case BlockPText:
		st := r.blockStyle(b, textDefaults{size: 9, lineHeight: 1.25})
		t := r.layoutText(r.ev.text(b.ID, b.Text, sc), st, w, 0, b.Align)
		h = t.height()
		r.drawLines(t, x, y, w)
	case BlockLine:
		r.line(x, y, x+w, y+h, r.mm(b.Stroke, defaultStroke), r.color(b.Color, mustHex(defaultInk)))
	default:
		r.shape(b, sc, x, y, w, h)
	}
	r.box(b.ID, x, y, w, h)
	return Box{X: x, Y: y, W: w, H: h}
}
