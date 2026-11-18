package engine

// PaperCustom takes the width and height of the page.
const PaperCustom = "custom"

// paperSizes are the paper formats in millimetres, shorter side first.
var paperSizes = map[string][2]float64{
	"A3":     {297, 420},
	"A4":     {210, 297},
	"A5":     {148, 210},
	"A6":     {105, 148},
	"Letter": {215.9, 279.4},
	"Legal":  {215.9, 355.6},
	"DL":     {99, 210},
	"L62":    {62, 100},
	"L102":   {102, 152},
	"L54":    {54, 85.6},
}

// paperOrder lists the formats as the editor offers them.
var paperOrder = []string{"A3", "A4", "A5", "A6", "Letter", "Legal", "DL", "L62", "L102", "L54"}

// PageSize is the size of a rendered page in millimetres.
type PageSize struct {
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// pageSize applies the orientation: portrait puts the shorter side across.
func pageSize(p Page) PageSize {
	base, ok := paperSizes[p.Size]
	if p.Size == PaperCustom && p.Width != nil && p.Height != nil {
		base, ok = [2]float64{*p.Width, *p.Height}, true
	}
	if !ok {
		base = paperSizes["A4"]
	}
	short, long := min(base[0], base[1]), max(base[0], base[1])
	if p.Orientation == "landscape" {
		return PageSize{Width: long, Height: short}
	}
	return PageSize{Width: short, Height: long}
}
