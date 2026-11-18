package engine

import (
	_ "embed"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
)

// htuLetterheadSource is the letterhead artwork of the HTU Kassabuch form (logo, triangles and footer text as
// outlines) as filled paths in millimetres on A4: "#rrggbb" sets the colour, M/L/C/Z build a path, F fills it.
//
//go:embed htu_letterhead.txt
var htuLetterheadSource string

// letterheadPage is the extent of the whole letterhead artwork: the A4 page it was measured on.
var letterheadPage = artBounds{x0: 0, y0: 0, x1: 210, y1: 297}

type pathOp struct {
	op     byte
	values []float64
	color  rgb
}

type artBounds struct{ x0, y0, x1, y1 float64 }

func (b artBounds) width() float64  { return b.x1 - b.x0 }
func (b artBounds) height() float64 { return b.y1 - b.y0 }

// art is a built-in artwork: filled paths and the bounds a graphic box maps to.
type art struct {
	name   string
	ops    []pathOp
	bounds artBounds
}

// ArtInfo describes a built-in artwork; Width and Height are its natural size in millimetres, and X and Y where it
// sits on the HTU letterhead page.
type ArtInfo struct {
	ID     string  `json:"id"`
	Name   string  `json:"name"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// artOrder lists the built-in artworks as the editor offers them.
var artOrder = []struct{ id, name string }{
	{ArtLogo, "HTU logo"},
	{ArtCornerTop, "HTU triangles, top right"},
	{ArtCornerBottom, "HTU triangles, bottom right"},
	{ArtFooter, "HTU footer with address"},
	{ArtLetterhead, "HTU letterhead, whole page"},
}

// Arts lists the built-in artworks.
func Arts() []ArtInfo {
	arts, err := builtinArts()
	if err != nil {
		return nil
	}
	out := make([]ArtInfo, 0, len(artOrder))
	for _, entry := range artOrder {
		a := arts[entry.id]
		out = append(out, ArtInfo{
			ID: entry.id, Name: entry.name, X: round2(a.bounds.x0), Y: round2(a.bounds.y0),
			Width: round2(a.bounds.width()), Height: round2(a.bounds.height()),
		})
	}
	return out
}

func builtinArt(id string) bool {
	for _, entry := range artOrder {
		if entry.id == id {
			return true
		}
	}
	return false
}

var builtinArts = sync.OnceValues(func() (map[string]*art, error) {
	ops, err := parseLetterhead(htuLetterheadSource)
	if err != nil {
		return nil, err
	}
	return splitLetterhead(ops), nil
})

// splitLetterhead cuts the letterhead into its parts by where each filled shape lies: the triangles at the right
// edge, the logo at the top and the footer (address text and the triangle at the left) at the bottom. Each part's
// bounds are the outline of its shapes, so a graphic of that part covers exactly the artwork.
func splitLetterhead(ops []pathOp) map[string]*art {
	empty := artBounds{x0: math.Inf(1), y0: math.Inf(1), x1: math.Inf(-1), y1: math.Inf(-1)}
	parts := map[string]*art{ArtLetterhead: {name: ArtLetterhead, ops: ops, bounds: letterheadPage}}
	for _, id := range []string{ArtLogo, ArtCornerTop, ArtCornerBottom, ArtFooter} {
		parts[id] = &art{name: id, bounds: empty}
	}
	var color pathOp
	var shape []pathOp
	shapeBounds := empty
	for _, o := range ops {
		switch o.op {
		case '#':
			color = o
			continue
		case 'F':
			shape = append(shape, o)
			part := parts[letterheadRegion(shapeBounds)]
			part.ops = append(part.ops, color)
			part.ops = append(part.ops, shape...)
			part.bounds = artBounds{
				x0: min(part.bounds.x0, shapeBounds.x0), y0: min(part.bounds.y0, shapeBounds.y0),
				x1: max(part.bounds.x1, shapeBounds.x1), y1: max(part.bounds.y1, shapeBounds.y1),
			}
			shape, shapeBounds = nil, empty
			continue
		}
		shape = append(shape, o)
		for i := 0; i+1 < len(o.values); i += 2 {
			shapeBounds.x0, shapeBounds.x1 = min(shapeBounds.x0, o.values[i]), max(shapeBounds.x1, o.values[i])
			shapeBounds.y0, shapeBounds.y1 = min(shapeBounds.y0, o.values[i+1]), max(shapeBounds.y1, o.values[i+1])
		}
	}
	return parts
}

// letterheadRegion names the part a shape of the letterhead belongs to by its centre.
func letterheadRegion(b artBounds) string {
	cx, cy := (b.x0+b.x1)/2, (b.y0+b.y1)/2
	switch {
	case cx > 170 && cy < letterheadPage.y1/2:
		return ArtCornerTop
	case cx > 170:
		return ArtCornerBottom
	case cy < letterheadPage.y1/2:
		return ArtLogo
	}
	return ArtFooter
}

func parseLetterhead(source string) ([]pathOp, error) {
	arity := map[byte]int{'M': 2, 'L': 2, 'C': 6, 'Z': 0, 'F': 0}
	var ops []pathOp
	for n, line := range strings.Split(strings.TrimSpace(source), "\n") {
		if strings.HasPrefix(line, "#") {
			color, ok := parseHex(line)
			if !ok {
				return nil, fmt.Errorf("letterhead line %d: bad colour", n+1)
			}
			ops = append(ops, pathOp{op: '#', color: color})
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
		ops = append(ops, pathOp{op: op, values: values})
	}
	return ops, nil
}

// drawBuiltinArt paints a built-in artwork scaled from its bounds into the box, keeping its aspect ratio, anchored
// top left.
func (r *renderer) drawBuiltinArt(id string, x, y, w, h float64) {
	arts, err := builtinArts()
	if err != nil {
		return
	}
	a, ok := arts[id]
	if !ok || a.bounds.width() <= 0 || a.bounds.height() <= 0 {
		return
	}
	scale := min(w/a.bounds.width(), h/a.bounds.height())
	if scale <= 0 {
		return
	}
	px := func(v float64) float64 { return x + (v-a.bounds.x0)*scale }
	py := func(v float64) float64 { return y + (v-a.bounds.y0)*scale }
	for _, o := range a.ops {
		v := o.values
		switch o.op {
		case '#':
			r.pdf.SetFillColor(o.color.r, o.color.g, o.color.b)
		case 'M':
			r.pdf.MoveTo(px(v[0]), py(v[1]))
		case 'L':
			r.pdf.LineTo(px(v[0]), py(v[1]))
		case 'C':
			r.pdf.CurveBezierCubicTo(px(v[0]), py(v[1]), px(v[2]), py(v[3]), px(v[4]), py(v[5]))
		case 'Z':
			r.pdf.ClosePath()
		case 'F':
			r.pdf.DrawPath("F")
		}
	}
}
