package engine

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/go-pdf/fpdf"
)

// Rendering limits. Exceeding one is the error pdf_render_limit.
const (
	// MaxPages bounds a rendered document.
	MaxPages = 300
	// RenderTimeout is the deadline Render applies when the caller's context has none sooner.
	RenderTimeout = 10 * time.Second
	// MaxOutputBytes bounds the rendered PDF.
	MaxOutputBytes = 20 << 20
	// maxItems bounds the laid-out pieces of one rendering, so nested loops over large lists fail fast instead of
	// filling memory until the deadline.
	maxItems = 200000
)

// Layout conventions in millimetres.
const (
	ptToMM          = 25.4 / 72
	accentBarHeight = 4.0
	cellInset       = 1.0 // horizontal text inset of flow text, like a table cell
	headingAfter    = 2.5
	textAfter       = 2.0
	ptextAfter      = 1.5
	blockAfter      = 2.0
	fieldsRowGap    = 0.8
	boxedPadding    = 2.0
	tableRule       = 0.2
	listIndent      = 5.0
	signatureGap    = 8.0
	signatureTop    = 4.0
	signatureLabel  = 1.5
	checkboxSize    = 3.5
	checkboxGap     = 2.0
	inputLineTop    = 3.0
	inputLineHeight = 5.0
	dividerMargin   = 2.0
	lineMargin      = 1.5
	headerTopMax    = 10.0
	footerBottomMax = 10.0
	defaultInk      = "#161616"
	defaultStroke   = 0.2
	defaultRuleGrey = "#c6c6c6"
)

// Logo is the branding logo: PNG or JPEG data, sniffed by content.
type Logo struct {
	Data []byte
}

// Branding is what the makerspace.* variables show.
type Branding struct {
	Name        string
	DisplayName string
	Address     string
}

// RenderInput is one rendering. Can answers whether the reader holds a permission; fields that need one the reader
// lacks render empty and are listed in Result.Redacted. Location is the time zone dates are shown in
// (Europe/Vienna when nil); Now is the generatedAt value.
type RenderInput struct {
	Doc      Document
	Data     Data
	Can      func(permission string) bool
	Assets   AssetSource
	Logo     *Logo
	Location *time.Location
	Now      time.Time
	Branding Branding
}

// Box is where a node was drawn, in millimetres from the top left of a page (pages count from 0); a node that
// spans pages has one box per page.
type Box struct {
	NodeID string  `json:"nodeId"`
	Page   int     `json:"page"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	W      float64 `json:"w"`
	H      float64 `json:"h"`
}

// Result is a rendered document with its layout map.
type Result struct {
	PDF      []byte
	Pages    []PageSize
	Boxes    []Box
	Problems []Problem
	Redacted []string
	// Inactive are the nodes that drew nothing with this data: blocks of a branch that was not taken, of a loop
	// without entries, of a layer whose pages the document does not have, and texts that came out empty. Page
	// breaks and the elements of hidden layers are not listed.
	Inactive []string
	Filename string
}

func renderLimit(message string) error {
	return apperror.New(http.StatusUnprocessableEntity, CodeRenderLimit, message)
}

// Render lays a template out over the data and draws it. Pass one paginates the body to learn the page count, pass
// two paginates again with the count known and draws every page. The deadline is checked for every item.
func Render(ctx context.Context, in RenderInput) (result Result, err error) {
	defer func() {
		// fpdf panics on some malformed input; a template must never take the process down. The panic value may
		// contain document text, so it is not passed on.
		if recover() != nil {
			result, err = Result{}, errors.New("render pdf template: the renderer failed")
		}
	}()
	ctx, cancel := context.WithTimeout(ctx, RenderTimeout)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return Result{}, renderLimit("Rendering took too long")
	}
	r := newRenderer(ctx, in)
	problems := newProblemList()
	for _, p := range Check(in.Doc) {
		problems.add(p.NodeID, p.Severity, p.Message)
	}
	r.problems = problems
	r.ev.report = problems.error

	first, err := r.paginate(0)
	if err != nil {
		return Result{}, err
	}
	pages, err := r.paginate(len(first))
	if err != nil {
		return Result{}, err
	}
	for i, page := range pages {
		if err := r.drawPage(i, len(pages), page); err != nil {
			return Result{}, err
		}
	}
	if err := r.pdf.Error(); err != nil {
		return Result{}, fmt.Errorf("render pdf template: %w", err)
	}
	var out bytes.Buffer
	if err := r.pdf.Output(&out); err != nil {
		return Result{}, fmt.Errorf("write pdf template: %w", err)
	}
	if out.Len() > MaxOutputBytes {
		return Result{}, renderLimit(fmt.Sprintf("The PDF would exceed %d MiB", MaxOutputBytes>>20))
	}
	size := pageSize(in.Doc.Page)
	result = Result{
		PDF:      out.Bytes(),
		Pages:    make([]PageSize, len(pages)),
		Boxes:    r.boxList(),
		Problems: problems.problems(),
		Redacted: r.redactedList(),
		Inactive: r.inactive(),
		Filename: r.filename(len(pages)),
	}
	for i := range result.Pages {
		result.Pages[i] = size
	}
	return result, nil
}

// renderer holds one rendering.
type renderer struct {
	ctx       context.Context
	in        RenderInput
	doc       Document
	pdf       *fpdf.Fpdf
	tr        func(string) string
	ev        *evaluator
	problems  *problemList
	size      PageSize
	margins   [4]float64
	fonts     map[string]bool
	assets    map[string]*loadedAsset
	logoAsset *loadedAsset
	page      int
	items     int
	boxes     map[boxKey]int
	boxOrder  []Box
	styles    styleIndex
}

type boxKey struct {
	id   string
	page int
}

func newRenderer(ctx context.Context, in RenderInput) *renderer {
	doc := in.Doc
	normalize(&doc)
	size := pageSize(doc.Page)
	pdf := fpdf.NewCustom(&fpdf.InitType{
		OrientationStr: "P",
		UnitStr:        "mm",
		Size:           fpdf.SizeType{Wd: size.Width, Ht: size.Height},
	})
	pdf.SetMargins(0, 0, 0)
	pdf.SetAutoPageBreak(false, 0)
	pdf.SetCellMargin(0)
	creator := in.Branding.DisplayName
	if creator == "" {
		creator = "Makerspace Core"
	}
	pdf.SetTitle(doc.Name, true)
	pdf.SetCreator(creator, true)
	now := in.Now
	if now.IsZero() {
		now = time.Now()
	}
	pdf.SetCreationDate(now)
	pdf.SetModificationDate(now)
	location := in.Location
	if location == nil {
		location = viennaLocation
	}
	can := in.Can
	if can == nil {
		can = func(string) bool { return false }
	}
	kind := doc.Export
	if _, ok := schemaIndexes[kind]; !ok {
		kind = KindWiRef
	}
	root := Data{}
	for k, v := range in.Data {
		root[k] = v
	}
	root["makerspace"] = map[string]any{
		"name": in.Branding.Name, "displayName": in.Branding.DisplayName, "address": in.Branding.Address,
	}
	root["generatedAt"] = now
	r := &renderer{
		ctx:     ctx,
		in:      in,
		doc:     doc,
		pdf:     pdf,
		tr:      pdf.UnicodeTranslatorFromDescriptor(""),
		size:    size,
		margins: doc.Page.Margins,
		fonts:   map[string]bool{},
		assets:  map[string]*loadedAsset{},
		boxes:   map[boxKey]int{},
		styles:  newStyleIndex(doc.Styles),
	}
	r.ev = newEvaluator(evalConfig{
		kind:      kind,
		locale:    doc.Page.Locale,
		location:  location,
		blankZero: kind == KindCashbook,
		can:       can,
	}, root)
	r.problems = newProblemList()
	return r
}

// cancelled reports an exceeded deadline as a render limit.
func (r *renderer) cancelled() error {
	if err := r.ctx.Err(); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return renderLimit("Rendering took too long")
		}
		return renderLimit("Rendering was cancelled")
	}
	return nil
}

func (r *renderer) bodyTop() float64    { return r.margins[0] }
func (r *renderer) bodyBottom() float64 { return r.size.Height - r.margins[2] }
func (r *renderer) bodyLeft() float64   { return r.margins[3] }
func (r *renderer) bodyWidth() float64 {
	return max(r.size.Width-r.margins[1]-r.margins[3], 1)
}

// placed is an item at its position on a page.
type placed struct {
	it   item
	x, y float64
	w    float64
	clip bool
}

type pageLayout struct {
	items []placed
	// used is true once anything was placed, including a form table drawn at fixed positions.
	used bool
}

// paginate builds the body items with the page count known (0 in the first pass) and distributes them over pages.
func (r *renderer) paginate(pageCount int) ([]*pageLayout, error) {
	r.items = 0
	sc := (*scope)(nil).with(map[string]any{"pages": pageCountValue(pageCount)})
	items, err := r.flow(r.doc.Body, sc, r.bodyWidth(), true)
	if err != nil {
		return nil, err
	}
	p := &paginator{r: r, rows: map[string]int{}, firstPage: map[string]int{}}
	if err := p.newPage(); err != nil {
		return nil, err
	}
	for i := 0; i < len(items); i++ {
		if err := r.cancelled(); err != nil {
			return nil, err
		}
		it := items[i]
		var next *item
		if i+1 < len(items) {
			next = &items[i+1]
		}
		if err := p.place(it, next); err != nil {
			return nil, err
		}
	}
	return p.pages, nil
}

func pageCountValue(count int) any {
	if count <= 0 {
		return nil
	}
	return count
}

type paginator struct {
	r         *renderer
	pages     []*pageLayout
	y         float64
	rows      map[string]int // rows of each table on the current page
	firstPage map[string]int // page of each table's first row
}

func (p *paginator) current() *pageLayout { return p.pages[len(p.pages)-1] }

func (p *paginator) newPage() error {
	if len(p.pages) >= MaxPages {
		return renderLimit(fmt.Sprintf("The document would have more than %d pages", MaxPages))
	}
	p.pages = append(p.pages, &pageLayout{})
	p.y = p.r.bodyTop()
	p.rows = map[string]int{}
	return nil
}

func (p *paginator) put(it item, clip bool) {
	page := p.current()
	page.items = append(page.items, placed{it: it, x: p.r.bodyLeft(), y: p.y, w: p.r.bodyWidth(), clip: clip})
	page.used = true
	p.y += it.h + it.after
}

func (p *paginator) place(it item, next *item) error {
	r := p.r
	bottom, room := r.bodyBottom(), r.bodyBottom()-r.bodyTop()
	switch {
	case it.pageBreak:
		if p.current().used {
			return p.newPage()
		}
		return nil
	case it.sheet != nil:
		return p.sheet(it)
	}
	if it.table != "" && (it.maxRows > 0 || it.maxRowsFirst > 0) {
		if _, seen := p.firstPage[it.table]; !seen {
			p.firstPage[it.table] = len(p.pages) - 1
		}
		limit := it.maxRows
		if p.firstPage[it.table] == len(p.pages)-1 && it.maxRowsFirst > 0 {
			limit = it.maxRowsFirst
		}
		if limit > 0 && p.rows[it.table] >= limit {
			if err := p.breakForRow(it); err != nil {
				return err
			}
		}
	}
	need := it.h
	if it.keepWithNext && next != nil && !next.pageBreak && next.sheet == nil {
		need = it.h + it.after + next.h
	}
	if p.y+need > bottom+epsilon && p.current().used {
		if it.table != "" && it.header != nil {
			if err := p.breakForRow(it); err != nil {
				return err
			}
		} else if err := p.newPage(); err != nil {
			return err
		}
	}
	clip := false
	if it.h > room+epsilon {
		clip = true
		r.problems.warning(it.id, "This element is taller than the page; it is cut off")
	}
	p.put(it, clip)
	if it.table != "" {
		p.rows[it.table]++
	}
	return nil
}

// breakForRow continues a table on a new page, repeating its header when asked.
func (p *paginator) breakForRow(it item) error {
	if err := p.newPage(); err != nil {
		return err
	}
	if it.header != nil {
		p.put(*it.header, false)
	}
	return nil
}

const epsilon = 0.001

// drawPage draws one page: the accent bar, the body, the header and footer bands and the layers on top.
func (r *renderer) drawPage(index, count int, layout *pageLayout) error {
	r.page = index
	r.pdf.AddPage()
	pageScope := (*scope)(nil).with(map[string]any{"page": index + 1, "pages": count})
	page := r.doc.Page
	if page.AccentBar {
		accent := r.color(page.Accent, mustHex("#0f62fe"))
		r.fillRect(0, 0, r.size.Width, accentBarHeight, accent)
	}
	for _, pl := range layout.items {
		if err := r.cancelled(); err != nil {
			return err
		}
		if pl.clip {
			r.pdf.ClipRect(pl.x, r.bodyTop(), pl.w, r.bodyBottom()-r.bodyTop(), false)
			r.place(pl.it, pl.x, pl.y, pl.w)
			r.pdf.ClipEnd()
			continue
		}
		r.place(pl.it, pl.x, pl.y, pl.w)
	}
	if len(r.doc.Header) > 0 {
		items, err := r.flow(r.doc.Header, pageScope, r.bodyWidth(), false)
		if err != nil {
			return err
		}
		r.stack(items, r.bodyLeft(), min(headerTopMax, r.margins[0]/3), r.bodyWidth())
	}
	if len(r.doc.Footer) > 0 {
		items, err := r.flow(r.doc.Footer, pageScope, r.bodyWidth(), false)
		if err != nil {
			return err
		}
		bottom := r.size.Height - min(footerBottomMax, r.margins[2]/2.2)
		r.stack(items, r.bodyLeft(), bottom-stackHeight(items), r.bodyWidth())
	}
	for i := range r.doc.Layers {
		if err := r.layer(&r.doc.Layers[i], index, count, pageScope); err != nil {
			return err
		}
	}
	return nil
}

func (r *renderer) layer(layer *Layer, index, count int, sc *scope) error {
	on := layer.Pages == LayerAllPages ||
		(layer.Pages == LayerFirstPage && index == 0) ||
		(layer.Pages == LayerNextPages && index > 0) ||
		(layer.Pages == LayerLastPage && index == count-1)
	if !on || layer.Hidden {
		return nil
	}
	// A layer has no box of its own: it would cover its elements in the editor's preview.
	for i := range layer.Elements {
		if err := r.cancelled(); err != nil {
			return err
		}
		b := &layer.Elements[i]
		x, y := deref(b.X, r.bodyLeft()), deref(b.Y, r.bodyTop())
		w := deref(b.W, r.bodyWidth())
		if positioned[b.Type] {
			r.positioned(b, sc, x, y, w)
			continue
		}
		items, err := r.flow([]Block{*b}, sc, w, false)
		if err != nil {
			return err
		}
		r.stack(items, x, y, w)
	}
	return nil
}

func unionBox(acc *Box, b Box) *Box {
	if acc == nil {
		return &b
	}
	x0, y0 := min(acc.X, b.X), min(acc.Y, b.Y)
	x1, y1 := max(acc.X+acc.W, b.X+b.W), max(acc.Y+acc.H, b.Y+b.H)
	return &Box{X: x0, Y: y0, W: x1 - x0, H: y1 - y0}
}

func deref(v *float64, fallback float64) float64 {
	if v == nil {
		return fallback
	}
	return *v
}

// box records where a node was drawn on the current page, merging repeated parts of the same node.
func (r *renderer) box(id string, x, y, w, h float64) {
	if id == "" {
		return
	}
	key := boxKey{id: id, page: r.page}
	if i, ok := r.boxes[key]; ok {
		merged := unionBox(&r.boxOrder[i], Box{X: x, Y: y, W: w, H: h})
		merged.NodeID, merged.Page = id, r.page
		r.boxOrder[i] = *merged
		return
	}
	r.boxes[key] = len(r.boxOrder)
	r.boxOrder = append(r.boxOrder, Box{NodeID: id, Page: r.page, X: x, Y: y, W: w, H: h})
}

func (r *renderer) boxList() []Box {
	out := make([]Box, len(r.boxOrder))
	for i, b := range r.boxOrder {
		out[i] = Box{NodeID: b.NodeID, Page: b.Page, X: round2(b.X), Y: round2(b.Y), W: round2(b.W), H: round2(b.H)}
	}
	return out
}

func round2(v float64) float64 {
	if v < 0 {
		return -round2(-v)
	}
	return float64(int64(v*100+0.5)) / 100
}

// inactive lists the nodes without a box, in document order.
func (r *renderer) inactive() []string {
	drawn := map[string]bool{}
	for _, b := range r.boxOrder {
		drawn[b.NodeID] = true
	}
	out := []string{}
	var visit func(blocks []Block)
	visit = func(blocks []Block) {
		for i := range blocks {
			b := &blocks[i]
			if b.Type != BlockPageBreak && !drawn[b.ID] {
				out = append(out, b.ID)
			}
			for _, children := range b.children() {
				visit(children)
			}
		}
	}
	for _, layer := range r.doc.Layers {
		if !layer.Hidden {
			visit(layer.Elements)
		}
	}
	visit(r.doc.Header)
	visit(r.doc.Body)
	visit(r.doc.Footer)
	return out
}

func (r *renderer) redactedList() []string {
	out := make([]string, 0, len(r.ev.redacted))
	for path := range r.ev.redacted {
		out = append(out, path)
	}
	sort.Strings(out)
	return out
}

var unsafeFilename = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// filename evaluates the file name expression into a safe name ending in .pdf.
func (r *renderer) filename(count int) string {
	sc := (*scope)(nil).with(map[string]any{"page": 1, "pages": count})
	name := r.ev.text("", r.doc.Page.Filename, sc)
	name = strings.TrimSuffix(strings.TrimSpace(name), ".pdf")
	name = strings.Trim(unsafeFilename.ReplaceAllString(name, "-"), "-.")
	if name == "" {
		name = string(r.doc.Export)
	}
	if len(name) > MaxFilenameLength-4 {
		name = name[:MaxFilenameLength-4]
	}
	return name + ".pdf"
}
