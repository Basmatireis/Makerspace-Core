package engine

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// Kind is the export a template renders.
type Kind string

const (
	// KindWiRef is the wiRef invoice request, attached to the mail to the accounting office.
	KindWiRef Kind = "wiref"
	// KindCashbook is the cashbook (Kassabuch) PDF export.
	KindCashbook Kind = "cashbook"
	// KindReceipt is the receipt of an order.
	KindReceipt Kind = "receipt"
)

// Kinds lists every export in a stable order.
var Kinds = []Kind{KindWiRef, KindCashbook, KindReceipt}

// ParseKind accepts the wire name of an export.
func ParseKind(value string) (Kind, bool) {
	for _, kind := range Kinds {
		if string(kind) == value {
			return kind, true
		}
	}
	return "", false
}

// SchemaVersion is the only template document version this engine reads and writes.
const SchemaVersion = 1

// Document is a template: page set-up, document styles, fixed-position layers and the header, body and footer
// flows. JSON names are the stored ones.
type Document struct {
	SchemaVersion int     `json:"schemaVersion"`
	Name          string  `json:"name"`
	Export        Kind    `json:"export"`
	Page          Page    `json:"page"`
	Styles        Styles  `json:"styles"`
	Layers        []Layer `json:"layers"`
	Header        []Block `json:"header"`
	Body          []Block `json:"body"`
	Footer        []Block `json:"footer"`
}

// Page is the paper and the defaults every block inherits.
type Page struct {
	Size        string     `json:"size"`
	Width       *float64   `json:"width,omitempty"`
	Height      *float64   `json:"height,omitempty"`
	Orientation string     `json:"orientation"`
	Margins     [4]float64 `json:"margins"`
	Font        string     `json:"font"`
	BaseSize    float64    `json:"baseSize"`
	Accent      Color      `json:"accent,omitempty"`
	Locale      string     `json:"locale"`
	AccentBar   bool       `json:"accentBar,omitempty"`
	Filename    string     `json:"filename,omitempty"`
}

// Fonts a template may use.
const (
	FontPlexSans  = "IBM Plex Sans"
	FontHelvetica = "Helvetica"
)

// Styles are the document styles that blocks link to, like design tokens.
type Styles struct {
	Colors []ColorStyle `json:"colors"`
	Text   []TextStyle  `json:"text"`
	Sizes  []SizeStyle  `json:"sizes"`
}

// ColorStyle is a named colour.
type ColorStyle struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Value Color  `json:"value"`
}

// TextStyle is a named text appearance; a block that links to it takes all of these values.
type TextStyle struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Font       string  `json:"font"`
	Size       Length  `json:"size"`
	Weight     int     `json:"weight"`
	LineHeight float64 `json:"lineHeight"`
	Color      Color   `json:"color"`
}

// SizeStyle is a named length in millimetres or points.
type SizeStyle struct {
	ID    string  `json:"id"`
	Name  string  `json:"name"`
	Value float64 `json:"value"`
	Unit  string  `json:"unit"`
}

// Layer pages.
const (
	LayerAllPages  = "all"
	LayerFirstPage = "first"
	LayerNextPages = "next"
	LayerLastPage  = "last"
)

// Layer holds fixed-position content drawn on the selected pages.
type Layer struct {
	ID       string  `json:"id"`
	Type     string  `json:"type"`
	Title    string  `json:"title,omitempty"`
	Pages    string  `json:"pages"`
	Hidden   bool    `json:"hidden,omitempty"`
	Elements []Block `json:"elements"`
}

// Block types.
const (
	BlockHeading    = "heading"
	BlockText       = "text"
	BlockPText      = "ptext"
	BlockValue      = "value"
	BlockList       = "list"
	BlockFields     = "fields"
	BlockTable      = "table"
	BlockSheet      = "sheet"
	BlockRepeat     = "repeat"
	BlockIf         = "if"
	BlockSwitch     = "switch"
	BlockColumns    = "columns"
	BlockBox        = "box"
	BlockImage      = "image"
	BlockPicture    = "picture"
	BlockGraphic    = "graphic"
	BlockQR         = "qr"
	BlockBarcode    = "barcode"
	BlockSignatures = "signatures"
	BlockCheckbox   = "checkbox"
	BlockInputLine  = "inputline"
	BlockSpacer     = "spacer"
	BlockDivider    = "divider"
	BlockPageBreak  = "pagebreak"
	BlockLine       = "line"
	BlockRect       = "rect"
	BlockEllipse    = "ellipse"
)

// ArtLetterhead is the built-in HTU letterhead artwork of the Kassabuch form.
const ArtLetterhead = "htu-letterhead"

// artAssetPrefix starts a graphic that draws an uploaded SVG asset.
const artAssetPrefix = "asset:"

// Block is one node of a flow or layer. It is the union of every block type's properties; Decode admits only the
// properties of the block's own type.
type Block struct {
	ID    string   `json:"id"`
	Type  string   `json:"type"`
	Title string   `json:"title,omitempty"`
	X     *float64 `json:"x,omitempty"`
	Y     *float64 `json:"y,omitempty"`
	W     *float64 `json:"w,omitempty"`
	H     *float64 `json:"h,omitempty"`

	Text       string  `json:"text,omitempty"`
	TextStyle  string  `json:"textStyle,omitempty"`
	Size       *Length `json:"size,omitempty"`
	Weight     int     `json:"weight,omitempty"`
	Color      Color   `json:"color,omitempty"`
	Align      string  `json:"align,omitempty"`
	LineHeight float64 `json:"lineHeight,omitempty"`

	Label      string `json:"label,omitempty"`
	Value      string `json:"value,omitempty"`
	LabelStyle string `json:"labelStyle,omitempty"`
	ValueStyle string `json:"valueStyle,omitempty"`

	Source    string `json:"source,omitempty"`
	As        string `json:"as,omitempty"`
	Style     string `json:"style,omitempty"`
	EmptyText string `json:"emptyText,omitempty"`

	LabelWidth *Length    `json:"labelWidth,omitempty"`
	Boxed      bool       `json:"boxed,omitempty"`
	Rows       []FieldRow `json:"rows,omitempty"`
	Fill       Color      `json:"fill,omitempty"`
	RuleColor  Color      `json:"ruleColor,omitempty"`

	RepeatHeader bool       `json:"repeatHeader,omitempty"`
	MaxRows      int        `json:"maxRows,omitempty"`
	MaxRowsFirst int        `json:"maxRowsFirst,omitempty"`
	Columns      []Column   `json:"columns,omitempty"`
	Totals       []FieldRow `json:"totals,omitempty"`
	HeaderStyle  string     `json:"headerStyle,omitempty"`
	BodyStyle    string     `json:"bodyStyle,omitempty"`
	TotalsStyle  string     `json:"totalsStyle,omitempty"`
	SubStyle     string     `json:"subStyle,omitempty"`
	HeaderFill   Color      `json:"headerFill,omitempty"`
	HeaderRule   Color      `json:"headerRule,omitempty"`
	RowRule      Color      `json:"rowRule,omitempty"`
	Zebra        Color      `json:"zebra,omitempty"`

	FirstTop         *float64    `json:"firstTop,omitempty"`
	NextTop          *float64    `json:"nextTop,omitempty"`
	RowsFirst        int         `json:"rowsFirst,omitempty"`
	RowsNext         int         `json:"rowsNext,omitempty"`
	RowHeight        *Length     `json:"rowHeight,omitempty"`
	HeadHeight       *Length     `json:"headHeight,omitempty"`
	CarryHeight      *Length     `json:"carryHeight,omitempty"`
	SumHeight        *Length     `json:"sumHeight,omitempty"`
	RowHeightFirst   *Length     `json:"rowHeightFirst,omitempty"`
	HeadHeightFirst  *Length     `json:"headHeightFirst,omitempty"`
	CarryHeightFirst *Length     `json:"carryHeightFirst,omitempty"`
	SumHeightFirst   *Length     `json:"sumHeightFirst,omitempty"`
	FillEmpty        bool        `json:"fillEmpty,omitempty"`
	TextColor        Color       `json:"textColor,omitempty"`
	SubColor         Color       `json:"subColor,omitempty"`
	Carry            *SheetCarry `json:"carry,omitempty"`
	Sum              *SheetSum   `json:"sum,omitempty"`

	Blocks []Block      `json:"blocks,omitempty"`
	When   *Condition   `json:"when,omitempty"`
	Then   []Block      `json:"then,omitempty"`
	Else   []Block      `json:"else,omitempty"`
	Path   string       `json:"path,omitempty"`
	Cases  []SwitchCase `json:"cases,omitempty"`

	Gap       *Length  `json:"gap,omitempty"`
	Padding   *Length  `json:"padding,omitempty"`
	Stroke    *Length  `json:"stroke,omitempty"`
	Height    *Length  `json:"height,omitempty"`
	Asset     string   `json:"asset,omitempty"`
	Art       string   `json:"art,omitempty"`
	ShowText  *bool    `json:"showText,omitempty"`
	Labels    []string `json:"labels,omitempty"`
	LineColor Color    `json:"lineColor,omitempty"`
	BoxColor  Color    `json:"boxColor,omitempty"`
	LineWidth *float64 `json:"lineWidth,omitempty"`
}

// FieldRow is a row of a fields block or a totals row of a table.
type FieldRow struct {
	Label string     `json:"label"`
	Value string     `json:"value"`
	Bold  bool       `json:"bold,omitempty"`
	When  *Condition `json:"when,omitempty"`
}

// Column is a column of a table (width share), of a form table (x and w on the page) or of a columns block
// (width share and blocks).
type Column struct {
	Header      string   `json:"header,omitempty"`
	Value       string   `json:"value,omitempty"`
	Sub         string   `json:"sub,omitempty"`
	Width       *float64 `json:"width,omitempty"`
	X           *float64 `json:"x,omitempty"`
	W           *float64 `json:"w,omitempty"`
	Align       string   `json:"align,omitempty"`
	HeaderAlign string   `json:"headerAlign,omitempty"`
	Blocks      []Block  `json:"blocks,omitempty"`
}

// SheetCarry is the first row of every sheet of a form table: the balance carried over.
type SheetCarry struct {
	Label   string `json:"label"`
	Value   string `json:"value"`
	OutFill Color  `json:"outFill,omitempty"`
}

// SheetSum is the last row of every sheet of a form table.
type SheetSum struct {
	Label   string `json:"label"`
	In      string `json:"in"`
	Out     string `json:"out"`
	Balance string `json:"balance,omitempty"`
	OutFill Color  `json:"outFill,omitempty"`
}

// SwitchCase is one branch of a switch block.
type SwitchCase struct {
	Value  string  `json:"value"`
	Blocks []Block `json:"blocks"`
}

// Condition operators.
const (
	OpExists = "exists"
	OpEmpty  = "empty"
	OpEq     = "eq"
	OpNe     = "ne"
	OpGt     = "gt"
	OpLt     = "lt"
)

// Condition tests a variable.
type Condition struct {
	Path  string `json:"path"`
	Op    string `json:"op"`
	Value string `json:"value,omitempty"`
}

// Color is "#rrggbb", "$c:<colour style id>" or "transparent"; empty means the block's default.
type Color string

// ColorTransparent draws nothing.
const ColorTransparent Color = "transparent"

const (
	colorRefPrefix = "$c:"
	sizeRefPrefix  = "$s:"
)

// Length is a number or a reference "$s:<size style id>".
type Length struct {
	Value float64
	Ref   string
}

// Num is a plain length.
func Num(value float64) *Length { return &Length{Value: value} }

// SizeRef links a length to a size style.
func SizeRef(id string) *Length { return &Length{Ref: id} }

// MarshalJSON writes a number or the reference string.
func (l Length) MarshalJSON() ([]byte, error) {
	if l.Ref != "" {
		return json.Marshal(sizeRefPrefix + l.Ref)
	}
	return []byte(strconv.FormatFloat(l.Value, 'f', -1, 64)), nil
}

// UnmarshalJSON reads a number or a "$s:" reference.
func (l *Length) UnmarshalJSON(raw []byte) error {
	raw = bytes.TrimSpace(raw)
	if len(raw) > 0 && raw[0] == '"' {
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return fmt.Errorf("read length: %w", err)
		}
		ref, ok := strings.CutPrefix(text, sizeRefPrefix)
		if !ok || ref == "" {
			return fmt.Errorf("length %q is neither a number nor a size style", text)
		}
		*l = Length{Ref: ref}
		return nil
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return fmt.Errorf("read length: %w", err)
	}
	*l = Length{Value: value}
	return nil
}

// Encode writes a document as JSON.
func Encode(doc Document) ([]byte, error) {
	normalize(&doc)
	raw, err := json.Marshal(doc)
	if err != nil {
		return nil, fmt.Errorf("encode pdf template: %w", err)
	}
	return raw, nil
}

// normalize replaces nil lists by empty ones, so a document always serializes with every list present.
func normalize(doc *Document) {
	if doc.Layers == nil {
		doc.Layers = []Layer{}
	}
	if doc.Header == nil {
		doc.Header = []Block{}
	}
	if doc.Body == nil {
		doc.Body = []Block{}
	}
	if doc.Footer == nil {
		doc.Footer = []Block{}
	}
	if doc.Styles.Colors == nil {
		doc.Styles.Colors = []ColorStyle{}
	}
	if doc.Styles.Text == nil {
		doc.Styles.Text = []TextStyle{}
	}
	if doc.Styles.Sizes == nil {
		doc.Styles.Sizes = []SizeStyle{}
	}
	for i := range doc.Layers {
		if doc.Layers[i].Elements == nil {
			doc.Layers[i].Elements = []Block{}
		}
	}
}

// Regions of a document, as Check reports them.
const (
	regionLayer  = "layer"
	regionHeader = "header"
	regionBody   = "body"
	regionFooter = "footer"
)
