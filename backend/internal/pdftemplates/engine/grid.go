package engine

import "strings"

// A grid is a static form table: fixed column widths, rows with a minimum height and cells that may span
// columns. It is unbreakable and abuts what follows it, so two grids stack into one form. Text in a cell is placed
// by the height of its capitals: middle centres from the top of the capitals to the last baseline, top and bottom
// keep half the padding free above the capitals or below the last baseline.

const (
	gridStroke  = 0.17
	gridPadding = 1.88
)

type gridCellLayout struct {
	x, w   float64
	lines  []string
	st     tstyle
	align  string
	valign string
	fill   rgb
}

type gridRowLayout struct {
	h     float64
	cells []gridCellLayout
}

// gridItem lays out a grid; its width is the sum of its columns, whatever the container.
func (r *renderer) gridItem(b *Block, sc *scope) item {
	stroke := r.mm(b.Stroke, gridStroke)
	padding := r.mm(b.Padding, gridPadding)
	line := r.color(b.Color, mustHex(defaultInk))
	offsets := make([]float64, len(b.ColWidths)+1)
	for i, w := range b.ColWidths {
		offsets[i+1] = offsets[i] + w
	}
	width := offsets[len(offsets)-1]
	rows := make([]gridRowLayout, 0, len(b.Rows))
	height := 0.0
	for _, row := range b.Rows {
		layout := gridRowLayout{h: r.mm(row.Height, 0)}
		column := 0
		for _, cell := range row.Cells {
			span := max(cell.Span, 1)
			if column+span > len(b.ColWidths) {
				break
			}
			layout.cells = append(layout.cells, r.gridCell(b, sc, cell, offsets[column], offsets[column+span]-offsets[column], padding))
			column += span
		}
		// Columns without a cell are empty cells, still framed.
		for ; column < len(b.ColWidths); column++ {
			layout.cells = append(layout.cells, gridCellLayout{
				x: offsets[column], w: b.ColWidths[column], fill: transparent, valign: "middle",
			})
		}
		for _, cell := range layout.cells {
			layout.h = max(layout.h, gridTextExtent(cell)+padding)
		}
		rows = append(rows, layout)
		height += layout.h
	}
	return item{
		id: b.ID, h: height, w: width, natural: width,
		draw: func(x, y, _ float64) {
			for _, row := range rows {
				for _, cell := range row.cells {
					r.rect(x+cell.x, y, cell.w, row.h, stroke, line, cell.fill)
					r.gridText(cell, x+cell.x, y, row.h, padding)
				}
				y += row.h
			}
		},
	}
}

func (r *renderer) gridCell(b *Block, sc *scope, cell GridCell, x, w, padding float64) gridCellLayout {
	st := r.defaults(textDefaults{})
	if size := r.pt(cell.Size, 0); size > 0 {
		st.size = size
	}
	if cell.Weight != 0 {
		st.weight = cell.Weight
	}
	st.color = r.color(cell.Color, st.color)
	st = r.withRef(st, cell.TextStyle)
	text := strings.TrimSpace(r.ev.text(b.ID, cell.Text, sc))
	var lines []string
	if text != "" {
		lines = r.wrap(st, text, max(w-2*padding, 1))
	}
	valign := cell.VAlign
	if valign == "" {
		valign = "middle"
	}
	return gridCellLayout{
		x: x, w: w, lines: lines, st: st, align: cell.Align, valign: valign, fill: r.color(cell.Fill, transparent),
	}
}

// gridTextExtent is the height from the top of the first line's capitals to the last baseline.
func gridTextExtent(cell gridCellLayout) float64 {
	if len(cell.lines) == 0 {
		return 0
	}
	return cell.st.capHeight() + float64(len(cell.lines)-1)*cell.st.pitch()
}

func (r *renderer) gridText(cell gridCellLayout, x, y, h, padding float64) {
	if len(cell.lines) == 0 {
		return
	}
	extent := gridTextExtent(cell)
	top := y + (h-extent)/2
	switch cell.valign {
	case "top":
		top = y + padding/2
	case "bottom":
		top = y + h - padding/2 - extent
	}
	r.setFont(cell.st)
	baseline := top + cell.st.capHeight()
	for _, line := range cell.lines {
		r.drawLine(cell.st, line, x, cell.w, padding, cell.align, baseline)
		baseline += cell.st.pitch()
	}
}
