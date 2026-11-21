package engine

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

// Limits of a template document. Exceeding one is the error pdf_template_too_large.
const (
	// MaxDocumentBytes bounds the JSON of one template.
	MaxDocumentBytes = 256 << 10
	// MaxNodes bounds the number of layers and blocks.
	MaxNodes = 500
	// MaxDepth bounds how deeply blocks nest (a layer counts as one level).
	MaxDepth = 16
	// MaxTextLength bounds every text field in characters.
	MaxTextLength = 4000
	// MaxStyles bounds each style list.
	MaxStyles = 64
	// MaxNameLength bounds the template name; MaxTitleLength the editor title of a node.
	MaxNameLength  = 120
	MaxTitleLength = 120
	// MaxStyleNameLength bounds the name of a document style.
	MaxStyleNameLength = 60
	// MaxFilenameLength bounds the file name expression.
	MaxFilenameLength = 200
)

// Bounds of lists inside blocks; they keep a document reviewable and its rendering cheap.
const (
	maxFlowColumns   = 4
	maxTableColumns  = 20
	maxGridColumns   = 20
	maxGridRows      = 100
	minSheetColumns  = 3
	maxSheetColumns  = 20
	maxFieldRows     = 100
	maxTotalRows     = 20
	maxSwitchCases   = 100
	maxSignatures    = 8
	maxViolations    = 50
	maxCoordinate    = 2000.0
	maxExtent        = 1000.0
	maxTextSize      = 200.0
	maxStrokeWidth   = 20.0
	maxGapOrPadding  = 200.0
	maxSheetRows     = 500
	maxRowLimit      = 10000
	minCustomPaper   = 20.0
	maxCustomPaper   = 1000.0
	maxMargin        = 200.0
	minBaseSize      = 4.0
	maxBaseSize      = 72.0
	minLineHeight    = 0.8
	maxLineHeight    = 3.0
	maxSheetRowExtra = 200.0
)

// Error codes of the engine.
const (
	CodeInvalid     = "pdf_template_invalid"
	CodeTooLarge    = "pdf_template_too_large"
	CodeRenderLimit = "pdf_render_limit"
)

var (
	idPattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)
	identPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,39}$`)
	hexColor     = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)
	listPathExpr = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$`)
)

// Violation is one structural error of a document, with a JSON-like path such as body[2].columns[0].width.
type Violation struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// Decode reads a template strictly: unknown properties, wrong types, values out of range, duplicate or malformed
// ids and exceeded limits are errors. Structural errors are a 422 pdf_template_invalid, exceeded limits a 422
// pdf_template_too_large; both list the violations in Details["violations"]. Problems a draft may still have
// (unknown variables, style references) are not errors here; Check reports them.
func Decode(raw []byte) (Document, error) {
	if len(raw) > MaxDocumentBytes {
		return Document{}, tooLarge([]Violation{{Message: fmt.Sprintf("The template exceeds %d KiB", MaxDocumentBytes>>10)}})
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var tree any
	if err := decoder.Decode(&tree); err != nil {
		return Document{}, invalid([]Violation{{Message: "The template is not valid JSON"}})
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return Document{}, invalid([]Violation{{Message: "The template must be a single JSON object"}})
	}
	v := &validator{ids: map[string]bool{}}
	v.document(tree)
	if len(v.limits) > 0 {
		return Document{}, tooLarge(append(v.limits, v.errors...))
	}
	if len(v.errors) > 0 {
		return Document{}, invalid(v.errors)
	}
	var doc Document
	strict := json.NewDecoder(bytes.NewReader(raw))
	strict.DisallowUnknownFields()
	if err := strict.Decode(&doc); err != nil {
		// The validator admits only what the typed model reads, so this is a defect, not user input.
		return Document{}, invalid([]Violation{{Message: "The template does not match the document model"}})
	}
	normalize(&doc)
	return doc, nil
}

func invalid(violations []Violation) error {
	err := apperror.New(http.StatusUnprocessableEntity, CodeInvalid, "The template is not valid")
	return withViolations(err, violations)
}

func tooLarge(violations []Violation) error {
	return withViolations(
		apperror.New(http.StatusUnprocessableEntity, CodeTooLarge, "The template exceeds a size limit"),
		violations,
	)
}

func withViolations(err *apperror.Error, violations []Violation) error {
	if len(violations) > maxViolations {
		violations = violations[:maxViolations]
	}
	listed := make([]map[string]any, 0, len(violations))
	for _, violation := range violations {
		listed = append(listed, map[string]any{"path": violation.Path, "message": violation.Message})
	}
	err.Details["violations"] = listed
	return err
}

type validator struct {
	errors []Violation
	limits []Violation
	ids    map[string]bool
	nodes  int
}

func (v *validator) fail(path, format string, args ...any) {
	if len(v.errors) < maxViolations {
		v.errors = append(v.errors, Violation{Path: path, Message: fmt.Sprintf(format, args...)})
	}
}

func (v *validator) limit(path, format string, args ...any) {
	if len(v.limits) < maxViolations {
		v.limits = append(v.limits, Violation{Path: path, Message: fmt.Sprintf(format, args...)})
	}
}

// propKind says how a property is checked.
type propKind int

const (
	pString   propKind = iota // plain text up to MaxTextLength
	pExpr                     // text with expressions
	pTitle                    // editor title
	pIdent                    // loop alias
	pListPath                 // dotted path of a list
	pStyleRef                 // id of a text style
	pNumber
	pInt
	pBool
	pLength
	pColor
	pEnum
	pBlocks
	pCondition
	pFieldRows
	pTableColumns
	pSheetColumns
	pFlowColumns
	pCases
	pLabels
	pCarry
	pSum
	pAsset
	pArt
	pGridColumns
	pGridRows
)

type prop struct {
	kind     propKind
	min, max float64
	values   []string
	required bool
}

func num(min, max float64) prop     { return prop{kind: pNumber, min: min, max: max} }
func integer(min, max float64) prop { return prop{kind: pInt, min: min, max: max} }
func length(min, max float64) prop  { return prop{kind: pLength, min: min, max: max} }
func enum(values ...string) prop    { return prop{kind: pEnum, values: values} }
func required(p prop) prop          { p.required = true; return p }
func simple(kind propKind) prop     { return prop{kind: kind} }
func weights() prop                 { return enum("400", "500", "600") }
func textSize() prop                { return length(1, maxTextSize) }
func lineHeight() prop              { return num(minLineHeight, maxLineHeight) }
func alignment() prop               { return enum("left", "center", "right") }
func strokeWidth() prop             { return length(0, maxStrokeWidth) }
func extent() prop                  { return num(0, maxExtent) }

var textProps = map[string]prop{
	"text": simple(pExpr), "textStyle": simple(pStyleRef), "size": textSize(), "weight": weights(),
	"color": simple(pColor), "align": alignment(), "lineHeight": lineHeight(),
}

// blockProps are the properties each block type admits besides id, type, title and the layer position.
var blockProps = map[string]map[string]prop{
	BlockHeading: textProps,
	BlockText:    textProps,
	BlockPText:   textProps,
	BlockValue: {
		"label": simple(pExpr), "value": simple(pExpr), "labelStyle": simple(pStyleRef),
		"textStyle": simple(pStyleRef), "size": textSize(), "weight": weights(), "align": alignment(),
		"color": simple(pColor),
	},
	BlockList: {
		"source": required(simple(pListPath)), "as": required(simple(pIdent)), "text": simple(pExpr),
		"style": enum("bullet", "number"), "emptyText": simple(pExpr), "textStyle": simple(pStyleRef),
		"size": textSize(), "color": simple(pColor), "weight": weights(), "lineHeight": lineHeight(),
	},
	BlockFields: {
		"labelWidth": length(0, maxExtent), "boxed": simple(pBool), "rows": simple(pFieldRows),
		"labelStyle": simple(pStyleRef), "valueStyle": simple(pStyleRef), "fill": simple(pColor),
		"ruleColor": simple(pColor),
	},
	BlockTable: {
		"source": required(simple(pListPath)), "as": required(simple(pIdent)), "repeatHeader": simple(pBool),
		"maxRows": integer(0, maxRowLimit), "maxRowsFirst": integer(0, maxRowLimit), "emptyText": simple(pExpr),
		"columns": required(simple(pTableColumns)), "totals": simple(pFieldRows), "headerStyle": simple(pStyleRef),
		"bodyStyle": simple(pStyleRef), "totalsStyle": simple(pStyleRef), "subStyle": simple(pStyleRef),
		"headerFill": simple(pColor), "headerRule": simple(pColor), "rowRule": simple(pColor), "zebra": simple(pColor),
	},
	BlockSheet: {
		"source": required(simple(pListPath)), "as": required(simple(pIdent)),
		"firstTop": required(num(0, maxExtent)), "nextTop": required(num(0, maxExtent)),
		"rowsFirst": required(integer(1, maxSheetRows)), "rowsNext": required(integer(1, maxSheetRows)),
		"rowHeight": required(length(1, maxSheetRowExtra)), "headHeight": required(length(1, maxSheetRowExtra)),
		"carryHeight": required(length(1, maxSheetRowExtra)), "sumHeight": required(length(1, maxSheetRowExtra)),
		"rowHeightFirst": length(1, maxSheetRowExtra), "headHeightFirst": length(1, maxSheetRowExtra),
		"carryHeightFirst": length(1, maxSheetRowExtra), "sumHeightFirst": length(1, maxSheetRowExtra),
		"fillEmpty": simple(pBool), "color": simple(pColor), "textColor": simple(pColor), "subColor": simple(pColor),
		"stroke": strokeWidth(), "headerStyle": simple(pStyleRef), "bodyStyle": simple(pStyleRef),
		"subStyle": simple(pStyleRef), "totalsStyle": simple(pStyleRef),
		"columns": required(simple(pSheetColumns)), "carry": required(simple(pCarry)), "sum": required(simple(pSum)),
	},
	BlockRepeat: {
		"source": required(simple(pListPath)), "as": required(simple(pIdent)), "blocks": simple(pBlocks),
	},
	BlockIf:      {"when": required(simple(pCondition)), "then": simple(pBlocks), "else": simple(pBlocks)},
	BlockSwitch:  {"path": required(simple(pListPath)), "cases": simple(pCases), "else": simple(pBlocks)},
	BlockColumns: {"gap": length(0, maxGapOrPadding), "columns": required(simple(pFlowColumns))},
	BlockBox: {
		"padding": length(0, maxGapOrPadding), "stroke": strokeWidth(), "color": simple(pColor),
		"fill": simple(pColor), "blocks": simple(pBlocks),
	},
	BlockImage:   {"height": length(0, maxExtent), "source": simple(pListPath)},
	BlockPicture: {"asset": required(simple(pAsset))},
	BlockGraphic: {"art": required(simple(pArt)), "color": simple(pColor)},
	BlockQR:      {"value": simple(pExpr)},
	BlockBarcode: {"value": simple(pExpr), "showText": simple(pBool)},
	BlockSignatures: {
		"labels": simple(pLabels), "height": length(0, maxExtent), "labelStyle": simple(pStyleRef),
		"lineColor": simple(pColor),
	},
	BlockCheckbox: {
		"label": simple(pExpr), "when": simple(pCondition), "boxColor": simple(pColor),
		"textStyle": simple(pStyleRef), "size": textSize(), "color": simple(pColor),
	},
	BlockInputLine: {
		"label": simple(pExpr), "lineWidth": extent(), "labelStyle": simple(pStyleRef), "lineColor": simple(pColor),
	},
	BlockSpacer:    {"height": length(0, maxExtent)},
	BlockDivider:   {"stroke": strokeWidth(), "color": simple(pColor)},
	BlockPageBreak: {},
	BlockLine:      {"stroke": strokeWidth(), "color": simple(pColor)},
	BlockRect:      {"stroke": strokeWidth(), "color": simple(pColor), "fill": simple(pColor)},
	BlockEllipse:   {"stroke": strokeWidth(), "color": simple(pColor), "fill": simple(pColor)},
	BlockGrid: {
		"colWidths": required(simple(pGridColumns)), "rows": required(simple(pGridRows)), "stroke": strokeWidth(),
		"color": simple(pColor), "padding": length(0, maxGapOrPadding),
	},
}

// sizedBlocks have a width and a height of their own.
var sizedBlocks = map[string]bool{
	BlockPicture: true, BlockGraphic: true, BlockQR: true, BlockBarcode: true,
	BlockLine: true, BlockRect: true, BlockEllipse: true,
}

func (v *validator) object(path string, value any) (map[string]any, bool) {
	m, ok := value.(map[string]any)
	if !ok {
		v.fail(path, "Expected an object")
	}
	return m, ok
}

func (v *validator) array(path string, value any) ([]any, bool) {
	list, ok := value.([]any)
	if !ok {
		v.fail(path, "Expected a list")
	}
	return list, ok
}

func join(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

func index(path string, i int) string { return path + "[" + strconv.Itoa(i) + "]" }

// keys rejects properties outside the allowed set and reports missing required ones.
func (v *validator) keys(path string, m map[string]any, allowed map[string]prop, extra ...string) {
	for key := range m {
		if _, ok := allowed[key]; ok {
			continue
		}
		known := false
		for _, e := range extra {
			known = known || e == key
		}
		if !known {
			v.fail(join(path, key), "Unknown property")
		}
	}
	for key, p := range allowed {
		if _, ok := m[key]; p.required && !ok {
			v.fail(join(path, key), "Required")
		}
	}
}

func (v *validator) document(tree any) {
	m, ok := v.object("", tree)
	if !ok {
		return
	}
	top := map[string]prop{
		"schemaVersion": required(integer(SchemaVersion, SchemaVersion)), "name": required(simple(pString)),
		"export": required(enum(
			string(KindWiRef), string(KindCashbook), string(KindReceipt), string(KindProjektantrag),
		)),
		"page": required(simple(pString)), "styles": simple(pString), "layers": simple(pString),
		"header": simple(pBlocks), "body": simple(pBlocks), "footer": simple(pBlocks),
	}
	v.keys("", m, top)
	if version, ok := m["schemaVersion"]; ok {
		v.value("schemaVersion", version, top["schemaVersion"])
	}
	if name, ok := m["name"]; ok {
		v.text("name", name, 1, MaxNameLength)
	}
	if export, ok := m["export"]; ok {
		v.value("export", export, top["export"])
	}
	if page, ok := m["page"]; ok {
		v.page(page)
	}
	if styles, ok := m["styles"]; ok {
		v.styles(styles)
	}
	if layers, ok := m["layers"]; ok {
		v.layers(layers)
	}
	for _, region := range []string{"header", "body", "footer"} {
		if blocks, ok := m[region]; ok {
			v.blocks(region, blocks, 1, false)
		}
	}
	if v.nodes > MaxNodes {
		v.limit("", "The template has %d elements; at most %d are allowed", v.nodes, MaxNodes)
	}
}

func (v *validator) page(value any) {
	m, ok := v.object("page", value)
	if !ok {
		return
	}
	sizes := append(append([]string(nil), paperOrder...), PaperCustom)
	allowed := map[string]prop{
		"size": required(enum(sizes...)), "width": num(minCustomPaper, maxCustomPaper),
		"height": num(minCustomPaper, maxCustomPaper), "orientation": required(enum("portrait", "landscape")),
		"margins": required(simple(pString)), "font": required(enum(FontPlexSans, FontHelvetica)),
		"baseSize": required(num(minBaseSize, maxBaseSize)), "accent": simple(pColor),
		"locale": required(enum("de", "en")), "accentBar": simple(pBool), "filename": simple(pString),
	}
	v.keys("page", m, allowed)
	for key, p := range allowed {
		raw, ok := m[key]
		if !ok {
			continue
		}
		switch key {
		case "margins":
			v.margins(raw)
		case "filename":
			v.text("page.filename", raw, 0, MaxFilenameLength)
		default:
			v.value(join("page", key), raw, p)
		}
	}
	custom := m["size"] == PaperCustom
	for _, key := range []string{"width", "height"} {
		if _, ok := m[key]; ok != custom {
			if custom {
				v.fail(join("page", key), "Required for a custom paper size")
			} else {
				v.fail(join("page", key), "Only a custom paper size takes a width and a height")
			}
		}
	}
}

func (v *validator) margins(value any) {
	list, ok := v.array("page.margins", value)
	if !ok {
		return
	}
	if len(list) != 4 {
		v.fail("page.margins", "Four margins are required: top, right, bottom, left")
		return
	}
	for i, raw := range list {
		v.value(index("page.margins", i), raw, num(0, maxMargin))
	}
}

func (v *validator) styles(value any) {
	m, ok := v.object("styles", value)
	if !ok {
		return
	}
	v.keys("styles", m, map[string]prop{"colors": {}, "text": {}, "sizes": {}})
	styleIDs := map[string]map[string]bool{"colors": {}, "text": {}, "sizes": {}}
	shapes := map[string]map[string]prop{
		"colors": {"id": required(simple(pString)), "name": required(simple(pString)), "value": required(simple(pColor))},
		"text": {
			"id": required(simple(pString)), "name": required(simple(pString)),
			"font": required(enum(FontPlexSans, FontHelvetica)), "size": required(textSize()),
			"weight": required(weights()), "lineHeight": required(lineHeight()), "color": required(simple(pColor)),
		},
		"sizes": {
			"id": required(simple(pString)), "name": required(simple(pString)),
			"value": required(num(0, maxExtent)), "unit": required(enum("mm", "pt")),
		},
	}
	for _, group := range []string{"colors", "text", "sizes"} {
		raw, ok := m[group]
		if !ok {
			continue
		}
		path := join("styles", group)
		list, ok := v.array(path, raw)
		if !ok {
			continue
		}
		if len(list) > MaxStyles {
			v.limit(path, "At most %d styles are allowed", MaxStyles)
		}
		for i, entry := range list {
			entryPath := index(path, i)
			style, ok := v.object(entryPath, entry)
			if !ok {
				continue
			}
			v.keys(entryPath, style, shapes[group])
			for key, p := range shapes[group] {
				fieldValue, ok := style[key]
				if !ok {
					continue
				}
				switch key {
				case "id":
					id, _ := fieldValue.(string)
					if !idPattern.MatchString(id) {
						v.fail(join(entryPath, key), "Style ids use letters, digits, - and _ (at most 40)")
					} else if styleIDs[group][id] {
						v.fail(join(entryPath, key), "Duplicate style id")
					}
					styleIDs[group][id] = true
				case "name":
					v.text(join(entryPath, key), fieldValue, 1, MaxStyleNameLength)
				default:
					v.value(join(entryPath, key), fieldValue, p)
				}
			}
		}
	}
}

func (v *validator) layers(value any) {
	list, ok := v.array("layers", value)
	if !ok {
		return
	}
	for i, raw := range list {
		path := index("layers", i)
		m, ok := v.object(path, raw)
		if !ok {
			continue
		}
		v.nodes++
		v.keys(path, m, map[string]prop{
			"id": required(simple(pString)), "type": required(enum("layer")), "title": simple(pTitle),
			"pages":  required(enum(LayerAllPages, LayerFirstPage, LayerNextPages, LayerLastPage)),
			"hidden": simple(pBool), "elements": simple(pBlocks),
		})
		v.nodeID(path, m["id"])
		v.value(join(path, "type"), m["type"], enum("layer"))
		if title, ok := m["title"]; ok {
			v.text(join(path, "title"), title, 0, MaxTitleLength)
		}
		if pages, ok := m["pages"]; ok {
			v.value(join(path, "pages"), pages, enum(LayerAllPages, LayerFirstPage, LayerNextPages, LayerLastPage))
		}
		if hidden, ok := m["hidden"]; ok {
			v.value(join(path, "hidden"), hidden, simple(pBool))
		}
		if elements, ok := m["elements"]; ok {
			v.blocks(join(path, "elements"), elements, 2, true)
		}
	}
}

func (v *validator) nodeID(path string, value any) {
	id, ok := value.(string)
	switch {
	case !ok || !idPattern.MatchString(id):
		v.fail(join(path, "id"), "Ids use letters, digits, - and _ (at most 40)")
	case v.ids[id]:
		v.fail(join(path, "id"), "Duplicate id")
	default:
		v.ids[id] = true
	}
}

func (v *validator) blocks(path string, value any, depth int, inLayer bool) {
	list, ok := v.array(path, value)
	if !ok {
		return
	}
	for i, raw := range list {
		v.block(index(path, i), raw, depth, inLayer)
	}
}

func (v *validator) block(path string, value any, depth int, inLayer bool) {
	m, ok := v.object(path, value)
	if !ok {
		return
	}
	v.nodes++
	if depth > MaxDepth {
		v.limit(path, "Elements nest at most %d levels deep", MaxDepth)
		return
	}
	v.nodeID(path, m["id"])
	typ, _ := m["type"].(string)
	allowed, known := blockProps[typ]
	if !known {
		v.fail(join(path, "type"), "Unknown element type")
		return
	}
	extra := []string{"id", "type", "title", "x", "y", "w", "h"}
	v.keys(path, m, allowed, extra...)
	if title, ok := m["title"]; ok {
		v.text(join(path, "title"), title, 0, MaxTitleLength)
	}
	for _, key := range []string{"x", "y"} {
		if raw, ok := m[key]; ok {
			v.value(join(path, key), raw, num(-maxCoordinate, maxCoordinate))
		} else if inLayer {
			v.fail(join(path, key), "Required inside a layer")
		}
	}
	for _, key := range []string{"w", "h"} {
		raw, ok := m[key]
		if ok {
			v.value(join(path, key), raw, extent())
			continue
		}
		// A grid takes its width from its columns.
		needed := (key == "w" && inLayer && typ != BlockGrid) ||
			(sizedBlocks[typ] && (key == "w" || key == "h") && typ != BlockLine)
		if needed {
			v.fail(join(path, key), "Required")
		}
	}
	for key, p := range allowed {
		raw, ok := m[key]
		if !ok {
			continue
		}
		v.property(join(path, key), raw, p, depth, typ)
	}
	if typ == BlockGrid {
		if rows, ok := m["rows"]; ok {
			columns, _ := m["colWidths"].([]any)
			v.gridRows(join(path, "rows"), rows, len(columns))
		}
	}
}

func (v *validator) gridColumns(path string, raw any) {
	list, ok := v.array(path, raw)
	if !ok {
		return
	}
	if len(list) < 1 || len(list) > maxGridColumns {
		v.fail(path, "Between 1 and %d columns are required", maxGridColumns)
	}
	for i, entry := range list {
		v.value(index(path, i), entry, num(0, maxExtent))
		if n, ok := number(entry); ok && n <= 0 {
			v.fail(index(path, i), "A column needs a width above 0")
		}
	}
}

// gridRows checks the rows of a grid: each row has a minimum height and at most as many cells as the grid has
// columns, counting spans.
func (v *validator) gridRows(path string, raw any, columns int) {
	list, ok := v.array(path, raw)
	if !ok {
		return
	}
	if len(list) < 1 || len(list) > maxGridRows {
		v.fail(path, "Between 1 and %d rows are required", maxGridRows)
	}
	rowShape := map[string]prop{"height": required(length(0, maxExtent)), "cells": {}}
	cellShape := map[string]prop{
		"text": simple(pExpr), "align": alignment(), "valign": enum("top", "middle", "bottom"),
		"textStyle": simple(pStyleRef), "size": textSize(), "weight": weights(), "color": simple(pColor),
		"fill": simple(pColor), "span": integer(1, maxGridColumns),
	}
	for i, entry := range list {
		rowPath := index(path, i)
		row, ok := v.object(rowPath, entry)
		if !ok {
			continue
		}
		v.keys(rowPath, row, rowShape)
		if height, ok := row["height"]; ok {
			v.value(join(rowPath, "height"), height, rowShape["height"])
		}
		cells, ok := row["cells"]
		if !ok {
			continue
		}
		cellList, ok := v.array(join(rowPath, "cells"), cells)
		if !ok {
			continue
		}
		used := 0
		for c, cellRaw := range cellList {
			cellPath := index(join(rowPath, "cells"), c)
			cell, ok := v.object(cellPath, cellRaw)
			if !ok {
				continue
			}
			v.keys(cellPath, cell, cellShape)
			for key, p := range cellShape {
				if value, ok := cell[key]; ok {
					v.value(join(cellPath, key), value, p)
				}
			}
			span := 1
			if n, ok := number(cell["span"]); ok && n >= 1 {
				span = int(n)
			}
			used += span
		}
		if used > columns {
			v.fail(join(rowPath, "cells"), "The cells of a row span more columns than the grid has")
		}
	}
}

// property checks one block property; nested blocks are never positioned by a layer.
func (v *validator) property(path string, raw any, p prop, depth int, blockType string) {
	switch p.kind {
	case pBlocks:
		v.blocks(path, raw, depth+1, false)
	case pCondition:
		v.condition(path, raw)
	case pFieldRows:
		v.fieldRows(path, raw, blockType)
	case pGridColumns:
		v.gridColumns(path, raw)
	case pGridRows:
		// Checked by gridRows, which needs the number of columns.
	case pTableColumns, pSheetColumns, pFlowColumns:
		v.columns(path, raw, p.kind, depth)
	case pCases:
		v.cases(path, raw, depth)
	case pLabels:
		v.labels(path, raw)
	case pCarry:
		v.record(path, raw, map[string]prop{
			"label": simple(pExpr), "value": simple(pExpr), "outFill": simple(pColor),
		})
	case pSum:
		v.record(path, raw, map[string]prop{
			"label": simple(pExpr), "in": simple(pExpr), "out": simple(pExpr), "balance": simple(pExpr),
			"outFill": simple(pColor),
		})
	default:
		v.value(path, raw, p)
	}
}

func (v *validator) record(path string, raw any, shape map[string]prop) {
	m, ok := v.object(path, raw)
	if !ok {
		return
	}
	v.keys(path, m, shape)
	for key, p := range shape {
		if value, ok := m[key]; ok {
			v.value(join(path, key), value, p)
		}
	}
}

func (v *validator) condition(path string, raw any) {
	m, ok := v.object(path, raw)
	if !ok {
		return
	}
	shape := map[string]prop{
		"path": required(simple(pListPath)), "op": required(enum(OpExists, OpEmpty, OpEq, OpNe, OpGt, OpLt)),
		"value": simple(pString),
	}
	v.keys(path, m, shape)
	for key, p := range shape {
		if value, ok := m[key]; ok {
			v.value(join(path, key), value, p)
		}
	}
}

func (v *validator) fieldRows(path string, raw any, blockType string) {
	list, ok := v.array(path, raw)
	if !ok {
		return
	}
	limit := maxFieldRows
	if blockType == BlockTable {
		limit = maxTotalRows
	}
	if len(list) > limit {
		v.limit(path, "At most %d rows are allowed", limit)
	}
	for i, entry := range list {
		entryPath := index(path, i)
		m, ok := v.object(entryPath, entry)
		if !ok {
			continue
		}
		shape := map[string]prop{
			"label": simple(pExpr), "value": simple(pExpr), "bold": simple(pBool), "when": simple(pCondition),
		}
		v.keys(entryPath, m, shape)
		for key, p := range shape {
			value, ok := m[key]
			if !ok {
				continue
			}
			if key == "when" {
				v.condition(join(entryPath, key), value)
				continue
			}
			v.value(join(entryPath, key), value, p)
		}
	}
}

func (v *validator) columns(path string, raw any, kind propKind, depth int) {
	list, ok := v.array(path, raw)
	if !ok {
		return
	}
	var shape map[string]prop
	minCount, maxCount := 1, maxTableColumns
	switch kind {
	case pTableColumns:
		shape = map[string]prop{
			"header": simple(pExpr), "value": simple(pExpr), "sub": simple(pExpr),
			"width": required(num(0, maxExtent)), "align": alignment(),
		}
	case pSheetColumns:
		minCount, maxCount = minSheetColumns, maxSheetColumns
		shape = map[string]prop{
			"header": simple(pExpr), "value": simple(pExpr), "sub": simple(pExpr),
			"x": required(num(0, maxExtent)), "w": required(num(0, maxExtent)), "align": alignment(),
			"headerAlign": alignment(),
		}
	default:
		maxCount = maxFlowColumns
		shape = map[string]prop{"width": required(num(0, maxExtent)), "blocks": simple(pBlocks)}
	}
	if len(list) < minCount || len(list) > maxCount {
		v.fail(path, "Between %d and %d columns are required", minCount, maxCount)
	}
	for i, entry := range list {
		entryPath := index(path, i)
		m, ok := v.object(entryPath, entry)
		if !ok {
			continue
		}
		v.keys(entryPath, m, shape)
		for key, p := range shape {
			value, ok := m[key]
			if !ok {
				continue
			}
			if key == "blocks" {
				v.blocks(join(entryPath, key), value, depth+1, false)
				continue
			}
			v.value(join(entryPath, key), value, p)
			if kind == pTableColumns && key == "width" {
				if n, ok := number(value); ok && n <= 0 {
					v.fail(join(entryPath, key), "A table column needs a width share above 0")
				}
			}
		}
	}
}

func (v *validator) cases(path string, raw any, depth int) {
	list, ok := v.array(path, raw)
	if !ok {
		return
	}
	if len(list) > maxSwitchCases {
		v.limit(path, "At most %d cases are allowed", maxSwitchCases)
	}
	for i, entry := range list {
		entryPath := index(path, i)
		m, ok := v.object(entryPath, entry)
		if !ok {
			continue
		}
		v.keys(entryPath, m, map[string]prop{"value": required(simple(pString)), "blocks": simple(pBlocks)})
		if value, ok := m["value"]; ok {
			v.value(join(entryPath, "value"), value, simple(pString))
		}
		if blocks, ok := m["blocks"]; ok {
			v.blocks(join(entryPath, "blocks"), blocks, depth+1, false)
		}
	}
}

func (v *validator) labels(path string, raw any) {
	list, ok := v.array(path, raw)
	if !ok {
		return
	}
	if len(list) == 0 || len(list) > maxSignatures {
		v.fail(path, "Between 1 and %d signature fields are required", maxSignatures)
	}
	for i, entry := range list {
		v.value(index(path, i), entry, simple(pExpr))
	}
}

func number(value any) (float64, bool) {
	n, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	f, err := n.Float64()
	return f, err == nil
}

func (v *validator) text(path string, value any, minLength, maxLength int) {
	text, ok := value.(string)
	if !ok {
		v.fail(path, "Expected text")
		return
	}
	count := utf8.RuneCountInString(text)
	if count < minLength {
		v.fail(path, "Required")
	}
	if count > maxLength {
		v.limit(path, "At most %d characters are allowed", maxLength)
	}
}

// value checks a scalar property.
func (v *validator) value(path string, raw any, p prop) {
	switch p.kind {
	case pString, pExpr:
		v.text(path, raw, 0, MaxTextLength)
	case pTitle:
		v.text(path, raw, 0, MaxTitleLength)
	case pIdent:
		if text, ok := raw.(string); !ok || !identPattern.MatchString(text) {
			v.fail(path, "A loop name is a letter or _ followed by letters, digits or _")
		} else if reservedLocals[text] {
			v.fail(path, "This name is reserved")
		}
	case pListPath:
		if text, ok := raw.(string); !ok || len(text) > MaxTitleLength || !listPathExpr.MatchString(text) {
			v.fail(path, "Expected a variable path such as items or order.number")
		}
	case pStyleRef:
		if text, ok := raw.(string); !ok || !idPattern.MatchString(text) {
			v.fail(path, "Expected the id of a text style")
		}
	case pAsset:
		if text, ok := raw.(string); !ok || !canonicalUUID(text) {
			v.fail(path, "Expected the id of an uploaded image")
		}
	case pArt:
		text, ok := raw.(string)
		id, isAsset := strings.CutPrefix(text, artAssetPrefix)
		if !ok || (!builtinArt(text) && (!isAsset || !canonicalUUID(id))) {
			v.fail(path, "Expected a built-in artwork such as %s or asset:<id>", ArtLogo)
		}
	case pBool:
		if _, ok := raw.(bool); !ok {
			v.fail(path, "Expected true or false")
		}
	case pNumber, pInt:
		n, ok := number(raw)
		switch {
		case !ok:
			v.fail(path, "Expected a number")
		case p.kind == pInt && n != float64(int64(n)):
			v.fail(path, "Expected a whole number")
		case n < p.min || n > p.max:
			v.fail(path, "Expected a number from %s to %s", formatBound(p.min), formatBound(p.max))
		}
	case pLength:
		if text, ok := raw.(string); ok {
			ref, isRef := strings.CutPrefix(text, sizeRefPrefix)
			if !isRef || !idPattern.MatchString(ref) {
				v.fail(path, "Expected a number or a size style ($s:<id>)")
			}
			return
		}
		v.value(path, raw, num(p.min, p.max))
	case pColor:
		text, ok := raw.(string)
		if !ok || !validColor(text) {
			v.fail(path, "Expected #rrggbb, transparent or a colour style ($c:<id>)")
		}
	case pEnum:
		text, ok := raw.(string)
		if n, isNumber := raw.(json.Number); isNumber {
			text, ok = n.String(), true
		}
		allowed := false
		for _, candidate := range p.values {
			allowed = allowed || (ok && candidate == text)
		}
		if !allowed {
			v.fail(path, "Expected one of %s", strings.Join(p.values, ", "))
		}
	default:
		v.fail(path, "Unexpected value")
	}
}

func validColor(text string) bool {
	if text == string(ColorTransparent) || hexColor.MatchString(text) {
		return true
	}
	ref, ok := strings.CutPrefix(text, colorRefPrefix)
	return ok && idPattern.MatchString(ref)
}

func formatBound(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

// canonicalUUID says whether text is a UUID in its one canonical spelling (lower case, hyphenated). Other spellings
// that uuid.Parse accepts (braces, urn: prefix, no hyphens, upper case) are refused, so an asset id has exactly one
// form: the asset-in-use test and the reference check at publication compare it as text.
func canonicalUUID(text string) bool {
	parsed, err := uuid.Parse(text)
	return err == nil && parsed.String() == text
}
