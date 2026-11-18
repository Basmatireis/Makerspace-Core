package engine

import (
	"fmt"
	"slices"
	"strings"

	"github.com/google/uuid"
)

// Problem severities. A draft may be saved with problems; publishing is refused while an error exists.
const (
	SeverityError   = "error"
	SeverityWarning = "warning"
)

// Problem is attached to the node it concerns; an empty NodeID concerns the page set-up.
type Problem struct {
	NodeID   string `json:"nodeId"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
}

// HasErrors says whether any problem is an error.
func HasErrors(problems []Problem) bool {
	for _, p := range problems {
		if p.Severity == SeverityError {
			return true
		}
	}
	return false
}

// problemList collects problems once each, in the order they were found.
type problemList struct {
	seen map[Problem]bool
	list []Problem
}

func newProblemList() *problemList { return &problemList{seen: map[Problem]bool{}} }

func (p *problemList) add(nodeID, severity, message string) {
	problem := Problem{NodeID: nodeID, Severity: severity, Message: message}
	if p.seen[problem] {
		return
	}
	p.seen[problem] = true
	p.list = append(p.list, problem)
}

func (p *problemList) error(nodeID, message string)   { p.add(nodeID, SeverityError, message) }
func (p *problemList) warning(nodeID, message string) { p.add(nodeID, SeverityWarning, message) }

func (p *problemList) problems() []Problem {
	if p.list == nil {
		return []Problem{}
	}
	return append([]Problem(nil), p.list...)
}

// Check finds what a template references but its export or its styles do not provide: unknown variables, filters,
// lists and styles, malformed expressions and asset ids (errors), and blocks that only work in the body when they
// are elsewhere (warnings).
func Check(doc Document) []Problem {
	c := newChecker(doc)
	c.document()
	return c.out.problems()
}

// ReferencedAssets lists the ids of the uploaded images and SVGs a document places, each once, sorted.
func ReferencedAssets(doc Document) []string {
	c := newChecker(doc)
	c.document()
	ids := make([]string, 0, len(c.assets))
	for id := range c.assets {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return ids
}

type checker struct {
	doc    Document
	out    *problemList
	ev     *evaluator
	colors map[string]bool
	texts  map[string]bool
	sizes  map[string]bool
	// assets are the ids of the uploaded images the document places.
	assets map[string]bool
}

func newChecker(doc Document) *checker {
	c := &checker{
		doc:    doc,
		out:    newProblemList(),
		colors: map[string]bool{},
		texts:  map[string]bool{},
		sizes:  map[string]bool{},
		assets: map[string]bool{},
	}
	for _, s := range doc.Styles.Colors {
		c.colors[s.ID] = true
	}
	for _, s := range doc.Styles.Text {
		c.texts[s.ID] = true
	}
	for _, s := range doc.Styles.Sizes {
		c.sizes[s.ID] = true
	}
	kind := doc.Export
	if _, ok := schemaIndexes[kind]; !ok {
		kind = KindWiRef
		c.out.error("", "Unknown export")
	}
	c.ev = newEvaluator(evalConfig{kind: kind, locale: doc.Page.Locale, can: func(string) bool { return true }}, nil)
	c.ev.report = c.out.error
	return c
}

func (c *checker) document() {
	p := c.doc.Page
	c.color("", p.Accent)
	c.expr("", p.Filename, nil, false)
	for _, s := range c.doc.Styles.Colors {
		if strings.HasPrefix(string(s.Value), colorRefPrefix) {
			c.out.error("", fmt.Sprintf("The colour style “%s” must be a colour value", s.Name))
		}
	}
	for _, s := range c.doc.Styles.Text {
		c.color("", s.Color)
		c.length("", &s.Size)
	}
	for _, layer := range c.doc.Layers {
		c.blocks(layer.Elements, nil, false, regionLayer)
	}
	c.blocks(c.doc.Header, nil, false, regionHeader)
	c.blocks(c.doc.Body, nil, true, regionBody)
	c.blocks(c.doc.Footer, nil, false, regionFooter)
}

// blocks checks a list; flow says whether its blocks are laid out by the body flow (sheet and page break work only
// there).
func (c *checker) blocks(list []Block, sc *scope, flow bool, region string) {
	for i := range list {
		c.block(&list[i], sc, flow, region)
	}
}

func (c *checker) block(b *Block, sc *scope, flow bool, region string) {
	id := c.blockID(b)
	inBody := region == regionBody
	c.styleRefs(b)
	switch b.Type {
	case BlockHeading, BlockText, BlockPText:
		c.expr(id, b.Text, sc, inBody)
	case BlockValue:
		c.expr(id, b.Label, sc, inBody)
		c.expr(id, b.Value, sc, inBody)
	case BlockList:
		inner := c.loop(b, sc)
		c.expr(id, b.Text, inner, inBody)
		c.expr(id, b.EmptyText, sc, inBody)
	case BlockFields:
		for _, row := range b.Rows {
			c.expr(id, row.Label, sc, inBody)
			c.expr(id, row.Value, sc, inBody)
			c.condition(id, row.When, sc)
		}
	case BlockTable:
		inner := c.loop(b, sc)
		for _, col := range b.Columns {
			c.expr(id, col.Header, sc, inBody)
			c.expr(id, col.Value, inner, inBody)
			c.expr(id, col.Sub, inner, inBody)
		}
		for _, row := range b.Totals {
			c.expr(id, row.Label, sc, inBody)
			c.expr(id, row.Value, sc, inBody)
			c.condition(id, row.When, sc)
		}
		c.expr(id, b.EmptyText, sc, inBody)
	case BlockSheet:
		c.sheet(b, sc, flow)
	case BlockRepeat:
		c.blocks(b.Blocks, c.loop(b, sc), flow, region)
	case BlockIf:
		c.condition(id, b.When, sc)
		c.blocks(b.Then, sc, flow, region)
		c.blocks(b.Else, sc, flow, region)
	case BlockSwitch:
		if b.Path != "" {
			c.ev.value(id, b.Path, sc)
		}
		for _, cs := range b.Cases {
			c.blocks(cs.Blocks, sc, flow, region)
		}
		c.blocks(b.Else, sc, flow, region)
	case BlockColumns:
		for _, col := range b.Columns {
			c.blocks(col.Blocks, sc, false, region)
		}
	case BlockBox:
		c.blocks(b.Blocks, sc, false, region)
	case BlockQR, BlockBarcode:
		c.expr(id, b.Value, sc, inBody)
	case BlockSignatures:
		for _, label := range b.Labels {
			c.expr(id, label, sc, inBody)
		}
	case BlockCheckbox:
		c.expr(id, b.Label, sc, inBody)
		c.condition(id, b.When, sc)
	case BlockInputLine:
		c.expr(id, b.Label, sc, inBody)
	case BlockPicture:
		if _, err := uuid.Parse(b.Asset); err != nil {
			c.out.error(id, "The picture names no uploaded image")
		} else {
			c.assets[b.Asset] = true
		}
	case BlockGraphic:
		if asset, ok := strings.CutPrefix(b.Art, artAssetPrefix); ok {
			if _, err := uuid.Parse(asset); err != nil {
				c.out.error(id, "The graphic names no uploaded SVG")
			} else {
				c.assets[asset] = true
			}
		}
	case BlockPageBreak:
		if !flow {
			c.out.warning(id, "A page break only works in the body; here it does nothing")
		}
	}
}

func (c *checker) blockID(b *Block) string { return b.ID }

func (c *checker) sheet(b *Block, sc *scope, flow bool) {
	id := b.ID
	if !flow {
		c.out.warning(id, "A form table only works in the body; here it is not drawn")
	}
	inner := c.loop(b, sc)
	for _, col := range b.Columns {
		c.expr(id, col.Header, sc, true)
		c.expr(id, col.Value, inner, true)
		c.expr(id, col.Sub, inner, true)
	}
	if b.Carry != nil {
		c.expr(id, b.Carry.Label, sc, true)
		c.expr(id, b.Carry.Value, sc, true)
		c.color(id, b.Carry.OutFill)
	}
	if b.Sum != nil {
		c.expr(id, b.Sum.Label, sc, true)
		c.expr(id, b.Sum.In, sc, true)
		c.expr(id, b.Sum.Out, sc, true)
		c.expr(id, b.Sum.Balance, sc, true)
		c.color(id, b.Sum.OutFill)
	}
}

// loop checks a loop source and returns the scope its body sees.
func (c *checker) loop(b *Block, sc *scope) *scope {
	_, canonical := c.ev.list(b.ID, b.Source, sc)
	return sc.loop(b.As, canonical, nil, 1)
}

func (c *checker) expr(nodeID, text string, sc *scope, inBody bool) {
	if text == "" {
		return
	}
	c.ev.text(nodeID, text, sc)
	if !inBody {
		return
	}
	for _, seg := range parseText(text) {
		if seg.token && seg.err == "" && seg.expr.path == "page" && !isAlias(sc, "page") {
			c.out.warning(nodeID, "The page number is only known in the header, the footer and layers")
		}
	}
}

func isAlias(sc *scope, name string) bool {
	for s := sc; s != nil; s = s.parent {
		if s.alias == name {
			return true
		}
	}
	return false
}

func (c *checker) condition(nodeID string, cond *Condition, sc *scope) {
	if cond == nil {
		return
	}
	c.ev.value(nodeID, cond.Path, sc)
	switch cond.Op {
	case OpGt, OpLt:
		if _, ok := toDecimal(cond.Value); !ok {
			c.out.error(nodeID, "A comparison with > or < needs a number")
		}
	case OpEq, OpNe:
		// An empty value compares with an unset variable, which is allowed.
	}
}

func (c *checker) styleRefs(b *Block) {
	refs := []string{b.TextStyle, b.LabelStyle, b.ValueStyle, b.HeaderStyle, b.BodyStyle, b.TotalsStyle, b.SubStyle}
	for _, ref := range refs {
		if ref != "" && !c.texts[ref] {
			c.out.error(b.ID, fmt.Sprintf("Unknown text style “%s”", ref))
		}
	}
	for _, color := range []Color{
		b.Color, b.Fill, b.RuleColor, b.HeaderFill, b.HeaderRule, b.RowRule, b.Zebra, b.TextColor, b.SubColor,
		b.LineColor, b.BoxColor,
	} {
		c.color(b.ID, color)
	}
	for _, l := range []*Length{
		b.Size, b.LabelWidth, b.RowHeight, b.HeadHeight, b.CarryHeight, b.SumHeight, b.RowHeightFirst,
		b.HeadHeightFirst, b.CarryHeightFirst, b.SumHeightFirst, b.Gap, b.Padding, b.Stroke, b.Height,
	} {
		c.length(b.ID, l)
	}
}

func (c *checker) color(nodeID string, color Color) {
	if ref, ok := strings.CutPrefix(string(color), colorRefPrefix); ok && !c.colors[ref] {
		c.out.error(nodeID, fmt.Sprintf("Unknown colour style “%s”", ref))
	}
}

func (c *checker) length(nodeID string, l *Length) {
	if l != nil && l.Ref != "" && !c.sizes[l.Ref] {
		c.out.error(nodeID, fmt.Sprintf("Unknown size style “%s”", l.Ref))
	}
}
