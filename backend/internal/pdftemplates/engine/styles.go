package engine

import (
	"strconv"
	"strings"
	"unicode"
)

// rgb is a resolved colour; none draws nothing.
type rgb struct {
	r, g, b int
	none    bool
}

func parseHex(text string) (rgb, bool) {
	if !hexColor.MatchString(text) {
		return rgb{}, false
	}
	value, err := strconv.ParseUint(text[1:], 16, 32)
	if err != nil {
		return rgb{}, false
	}
	return rgb{r: int(value >> 16 & 0xff), g: int(value >> 8 & 0xff), b: int(value & 0xff)}, true
}

func mustHex(text string) rgb {
	color, ok := parseHex(text)
	if !ok {
		panic("engine: bad colour constant " + text)
	}
	return color
}

var transparent = rgb{none: true}

type styleIndex struct {
	colors map[string]Color
	text   map[string]TextStyle
	sizes  map[string]SizeStyle
}

func newStyleIndex(s Styles) styleIndex {
	index := styleIndex{colors: map[string]Color{}, text: map[string]TextStyle{}, sizes: map[string]SizeStyle{}}
	for _, c := range s.Colors {
		index.colors[c.ID] = c.Value
	}
	for _, t := range s.Text {
		index.text[t.ID] = t
	}
	for _, z := range s.Sizes {
		index.sizes[z.ID] = z
	}
	return index
}

// color resolves a colour value or reference; an empty or unknown one takes the fallback (Check reports unknown
// references).
func (r *renderer) color(c Color, fallback rgb) rgb {
	switch c {
	case "":
		return fallback
	case ColorTransparent:
		return transparent
	}
	if ref, ok := strings.CutPrefix(string(c), colorRefPrefix); ok {
		value, known := r.styles.colors[ref]
		if !known || strings.HasPrefix(string(value), colorRefPrefix) {
			return fallback
		}
		return r.color(value, fallback)
	}
	if parsed, ok := parseHex(string(c)); ok {
		return parsed
	}
	return fallback
}

// mm resolves a length in millimetres; a size style in points is converted.
func (r *renderer) mm(l *Length, fallback float64) float64 {
	if l == nil {
		return fallback
	}
	if l.Ref == "" {
		return l.Value
	}
	size, ok := r.styles.sizes[l.Ref]
	if !ok {
		return fallback
	}
	if size.Unit == "pt" {
		return size.Value * ptToMM
	}
	return size.Value
}

// pt resolves a length in points; a size style in millimetres is converted.
func (r *renderer) pt(l *Length, fallback float64) float64 {
	if l == nil {
		return fallback
	}
	if l.Ref == "" {
		return l.Value
	}
	size, ok := r.styles.sizes[l.Ref]
	if !ok {
		return fallback
	}
	if size.Unit == "mm" {
		return size.Value / ptToMM
	}
	return size.Value
}

// tstyle is a resolved text appearance.
type tstyle struct {
	font       string
	weight     int
	size       float64
	color      rgb
	lineHeight float64
}

// pitch is the height of one line in millimetres.
func (s tstyle) pitch() float64 { return s.size * ptToMM * s.lineHeight }

// baseline is where text sits in a line box starting at top: centred like an fpdf cell.
func (s tstyle) baseline(top float64) float64 { return top + s.pitch()/2 + 0.3*s.size*ptToMM }

// capHeight is the height of capitals in millimetres.
func (s tstyle) capHeight() float64 { return s.size * ptToMM * capHeight(s.font) }

// textDefaults are the defaults of a part of a block before its own properties and its text style apply.
type textDefaults struct {
	size       float64 // 0: the page's base size
	sizeDelta  float64 // added to the base size when size is 0
	weight     int
	color      string
	lineHeight float64
}

func (r *renderer) defaults(d textDefaults) tstyle {
	size := d.size
	if size == 0 {
		size = r.doc.Page.BaseSize + d.sizeDelta
	}
	if size <= 0 {
		size = 10
	}
	weight := d.weight
	if weight == 0 {
		weight = 400
	}
	color := d.color
	if color == "" {
		color = defaultInk
	}
	lineHeight := d.lineHeight
	if lineHeight == 0 {
		lineHeight = 1.35
	}
	return tstyle{font: r.doc.Page.Font, weight: weight, size: size, color: mustHex(color), lineHeight: lineHeight}
}

// withRef applies a text style: it overrides every value it has.
func (r *renderer) withRef(st tstyle, ref string) tstyle {
	if ref == "" {
		return st
	}
	def, ok := r.styles.text[ref]
	if !ok {
		return st
	}
	if def.Font != "" {
		st.font = def.Font
	}
	if size := r.pt(&def.Size, st.size); size > 0 {
		st.size = size
	}
	if def.Weight != 0 {
		st.weight = def.Weight
	}
	if def.LineHeight != 0 {
		st.lineHeight = def.LineHeight
	}
	st.color = r.color(def.Color, st.color)
	return st
}

// blockStyle is the text appearance of a block: defaults, then its own size, weight, colour and line height,
// then its text style, which wins.
func (r *renderer) blockStyle(b *Block, d textDefaults) tstyle {
	st := r.defaults(d)
	if size := r.pt(b.Size, 0); size > 0 {
		st.size = size
	}
	if b.Weight != 0 {
		st.weight = b.Weight
	}
	st.color = r.color(b.Color, st.color)
	if b.LineHeight != 0 {
		st.lineHeight = b.LineHeight
	}
	return r.withRef(st, b.TextStyle)
}

// partStyle is the appearance of a part with its own style reference (a label, a table header, …).
func (r *renderer) partStyle(ref string, d textDefaults) tstyle { return r.withRef(r.defaults(d), ref) }

// setFont selects a style for measuring and drawing.
func (r *renderer) setFont(st tstyle) {
	family, style := face(st.font, st.weight)
	r.ensureFont(family, style)
	r.pdf.SetFont(family, style, st.size)
	r.pdf.SetTextColor(st.color.r, st.color.g, st.color.b)
}

// encode prepares text for the current font: control characters go, Helvetica gets cp1252 (other characters are
// replaced) and the UTF-8 fonts lose characters outside the basic plane, which fpdf cannot measure.
func (r *renderer) encode(st tstyle, text string) string {
	clean := strings.Map(func(c rune) rune {
		switch {
		case c == '\t':
			return ' '
		case unicode.IsControl(c):
			return -1
		case c > 0xffff:
			return '?'
		}
		return c
	}, text)
	if st.font == FontHelvetica {
		return r.tr(clean)
	}
	return clean
}

// width measures text in a style; the font must be set.
func (r *renderer) width(st tstyle, text string) float64 {
	return r.pdf.GetStringWidth(r.encode(st, text))
}

// wrap breaks text into lines no wider than width: at newlines, then between words, and inside a word only when
// the word alone is too wide.
func (r *renderer) wrap(st tstyle, text string, width float64) []string {
	r.setFont(st)
	text = strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")
	var lines []string
	for _, hard := range strings.Split(text, "\n") {
		current, started := "", false
		for _, word := range strings.Split(hard, " ") {
			candidate := word
			if started {
				candidate = current + " " + word
			}
			if r.width(st, candidate) <= width+epsilon {
				current, started = candidate, true
				continue
			}
			if started {
				lines = append(lines, current)
			}
			pieces := r.breakWord(st, word, width)
			lines = append(lines, pieces[:len(pieces)-1]...)
			current, started = pieces[len(pieces)-1], true
		}
		lines = append(lines, current)
	}
	return lines
}

// breakWord cuts a word into pieces that fit the width; the last piece may be shorter.
func (r *renderer) breakWord(st tstyle, word string, width float64) []string {
	var pieces []string
	var current []rune
	used := 0.0
	for _, c := range word {
		w := r.width(st, string(c))
		if len(current) > 0 && used+w > width+epsilon {
			pieces = append(pieces, string(current))
			current, used = nil, 0
		}
		current = append(current, c)
		used += w
	}
	return append(pieces, string(current))
}

// ellipsize shortens one line with … until it fits.
func (r *renderer) ellipsize(st tstyle, text string, width float64) string {
	r.setFont(st)
	if r.width(st, text) <= width+epsilon {
		return text
	}
	runes := []rune(text)
	for len(runes) > 0 && r.width(st, string(runes)+"…") > width+epsilon {
		runes = runes[:len(runes)-1]
	}
	return strings.TrimRight(string(runes), " ") + "…"
}

// textLines is wrapped text in one style.
type textLines struct {
	lines []string
	st    tstyle
	align string
	inset float64
}

func (t textLines) height() float64 { return float64(len(t.lines)) * t.st.pitch() }

// layoutText wraps text into a box of the width, keeping inset free on both sides.
func (r *renderer) layoutText(text string, st tstyle, width, inset float64, align string) textLines {
	return textLines{lines: r.wrap(st, text, max(width-2*inset, 1)), st: st, align: align, inset: inset}
}

// natural is the width the text needs on one line per paragraph line, with its inset.
func (r *renderer) natural(t textLines) float64 {
	r.setFont(t.st)
	widest := 0.0
	for _, line := range t.lines {
		widest = max(widest, r.width(t.st, line))
	}
	return widest + 2*t.inset
}

// drawLines writes wrapped text at the top left of a box of the width.
func (r *renderer) drawLines(t textLines, x, y, width float64) {
	if len(t.lines) == 0 {
		return
	}
	r.setFont(t.st)
	for i, line := range t.lines {
		r.drawLine(t.st, line, x, width, t.inset, t.align, t.st.baseline(y+float64(i)*t.st.pitch()))
	}
}

// drawLine writes one line aligned within x..x+width at the baseline; the font must be set.
func (r *renderer) drawLine(st tstyle, line string, x, width, inset float64, align string, baseline float64) {
	if line == "" {
		return
	}
	encoded := r.encode(st, line)
	w := r.pdf.GetStringWidth(encoded)
	left := x + inset
	switch align {
	case "right":
		left = x + width - inset - w
	case "center":
		left = x + (width-w)/2
	}
	r.pdf.Text(left, baseline, encoded)
}

func (r *renderer) fillRect(x, y, w, h float64, fill rgb) {
	if fill.none || w <= 0 || h <= 0 {
		return
	}
	r.pdf.SetFillColor(fill.r, fill.g, fill.b)
	r.pdf.Rect(x, y, w, h, "F")
}

// rect draws a rectangle with an optional fill and stroke (stroke 0 draws none).
func (r *renderer) rect(x, y, w, h, stroke float64, line, fill rgb) {
	style := ""
	if !fill.none {
		r.pdf.SetFillColor(fill.r, fill.g, fill.b)
		style = "F"
	}
	if stroke > 0 && !line.none {
		r.pdf.SetDrawColor(line.r, line.g, line.b)
		r.pdf.SetLineWidth(stroke)
		style += "D"
	}
	if style == "" {
		return
	}
	r.pdf.Rect(x, y, w, h, style)
}

func (r *renderer) line(x0, y0, x1, y1, stroke float64, color rgb) {
	if stroke <= 0 || color.none {
		return
	}
	r.pdf.SetDrawColor(color.r, color.g, color.b)
	r.pdf.SetLineWidth(stroke)
	r.pdf.Line(x0, y0, x1, y1)
}
