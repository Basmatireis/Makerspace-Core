package signage

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

// A scene is laid out on a grid whose short side is GridShortSide units long; block geometry and style lengths
// are integers in these units. Renderers draw the scene at that size and scale the result, so a scene looks the
// same on every screen of its aspect ratio.
const (
	GridShortSide = 1080

	// MaxBlocks is the largest number of blocks in a scene.
	MaxBlocks = 40
	// maxBlocksJSONBytes bounds the canonical blocks of one scene; rich text widgets may hold several tens of
	// thousands of characters each.
	maxBlocksJSONBytes = 1 << 20
	maxBlockNameRunes  = 60
	maxBlockCoordinate = 8000
	minBlockExtent     = 8
	maxBlockExtent     = 8000

	maxBlockBorderWidth   = 40
	maxBlockLength        = 400
	maxBlockBackgroundDim = 90
	minBlockLineHeight    = 80
	maxBlockLineHeight    = 250
	minBlockLetterSpace   = -10
	maxBlockLetterSpace   = 50
	minBlockTextSize      = 8
	maxBlockTextSize      = 400
	minBlockOpacity       = 10
	fullPercentage        = 100
)

var blockIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)

// Block is one freely positioned box of a scene that shows one widget. The order of a scene's blocks is the
// stacking order (later on top). Hidden blocks are not shown on displays; locked only matters to the editor.
type Block struct {
	ID     string     `json:"id"`
	Name   string     `json:"name"`
	X      int        `json:"x"`
	Y      int        `json:"y"`
	W      int        `json:"w"`
	H      int        `json:"h"`
	Hidden bool       `json:"hidden"`
	Locked bool       `json:"locked"`
	Widget RawWidget  `json:"widget"`
	Style  BlockStyle `json:"style"`
}

// BlockAlign is a horizontal or vertical alignment inside a block.
type BlockAlign string

const (
	BlockAlignStart  BlockAlign = "start"
	BlockAlignCenter BlockAlign = "center"
	BlockAlignEnd    BlockAlign = "end"
)

// BorderStyle is the line style of a block border.
type BorderStyle string

const (
	BorderSolid  BorderStyle = "solid"
	BorderDashed BorderStyle = "dashed"
	BorderDotted BorderStyle = "dotted"
	BorderDouble BorderStyle = "double"
)

// BlockShadow is the shadow of a block; glow uses the border colour (or the text colour).
type BlockShadow string

const (
	ShadowNone   BlockShadow = "none"
	ShadowSoft   BlockShadow = "soft"
	ShadowStrong BlockShadow = "strong"
	ShadowGlow   BlockShadow = "glow"
)

// BlockFontFamily is the font of a block; inherit uses the scene's.
type BlockFontFamily string

const (
	BlockFontInherit BlockFontFamily = "inherit"
	BlockFontSans    BlockFontFamily = "sans"
	BlockFontSerif   BlockFontFamily = "serif"
	BlockFontMono    BlockFontFamily = "mono"
	BlockFontCustom  BlockFontFamily = "custom"
)

// FontWeight is the font weight of a block; inherit keeps the widget's own.
type FontWeight string

const (
	FontWeightInherit FontWeight = "inherit"
	FontWeight400     FontWeight = "400"
	FontWeight500     FontWeight = "500"
	FontWeight600     FontWeight = "600"
	FontWeight700     FontWeight = "700"
)

// BlockStyle is the style of a block's box. Lengths are grid units; colours are lowercase #rrggbb or null.
// TextSize is the font size of text and announcement widgets (of the announcement title) and the scale of every
// other widget's internal sizes, where 32 is the default look.
type BlockStyle struct {
	BackgroundColor   *string         `json:"backgroundColor"`
	BackgroundOpacity int             `json:"backgroundOpacity"`
	BackgroundAssetID *uuid.UUID      `json:"backgroundAssetId"`
	BackgroundDim     int             `json:"backgroundDim"`
	TextColor         *string         `json:"textColor"`
	BorderWidth       int             `json:"borderWidth"`
	BorderStyle       BorderStyle     `json:"borderStyle"`
	BorderColor       *string         `json:"borderColor"`
	Radius            int             `json:"radius"`
	Shadow            BlockShadow     `json:"shadow"`
	FontFamily        BlockFontFamily `json:"fontFamily"`
	FontAssetID       *uuid.UUID      `json:"fontAssetId"`
	FontWeight        FontWeight      `json:"fontWeight"`
	LineHeight        int             `json:"lineHeight"`
	LetterSpacing     int             `json:"letterSpacing"`
	Uppercase         bool            `json:"uppercase"`
	TextSize          int             `json:"textSize"`
	Padding           int             `json:"padding"`
	Align             BlockAlign      `json:"align"`
	VerticalAlign     BlockAlign      `json:"verticalAlign"`
	Opacity           int             `json:"opacity"`
}

var (
	blockKeys = []string{"id", "name", "x", "y", "w", "h", "hidden", "locked", "widget", "style"}
	styleKeys = []string{
		"backgroundColor", "backgroundOpacity", "backgroundAssetId", "backgroundDim", "textColor", "borderWidth",
		"borderStyle", "borderColor", "radius", "shadow", "fontFamily", "fontAssetId", "fontWeight", "lineHeight",
		"letterSpacing", "uppercase", "textSize", "padding", "align", "verticalAlign", "opacity",
	}
	styleNullableKeys = []string{"backgroundColor", "backgroundAssetId", "textColor", "borderColor", "fontAssetId"}
)

// requireKeys rejects a JSON object that misses one of keys or holds null where null is not allowed.
func requireKeys(raw json.RawMessage, keys, nullable []string) (map[string]json.RawMessage, bool) {
	var generic map[string]json.RawMessage
	if err := json.Unmarshal(raw, &generic); err != nil || generic == nil {
		return nil, false
	}
	for _, key := range keys {
		value, ok := generic[key]
		if !ok || (string(value) == "null" && !contains(nullable, key)) {
			return nil, false
		}
	}
	return generic, true
}

// isMediaWidget reports the widgets that fill their block with a picture; their blocks have no background image.
func isMediaWidget(widgetType WidgetType) bool {
	return inSet(widgetType, WidgetImage, WidgetVideo, WidgetSlideshow, WidgetCamera, WidgetTimelapse)
}

// ValidateBlockStyle checks a block style for a widget type and adds its assets to refs.
func ValidateBlockStyle(block string, widgetType WidgetType, style BlockStyle, refs *WidgetRefs) error {
	for _, color := range []*string{style.BackgroundColor, style.TextColor, style.BorderColor} {
		if color != nil && !colorPattern.MatchString(*color) {
			return blockError(block, "style colours must be lowercase #rrggbb or null")
		}
	}
	if style.BackgroundOpacity < 0 || style.BackgroundOpacity > fullPercentage ||
		style.BackgroundDim < 0 || style.BackgroundDim > maxBlockBackgroundDim ||
		style.BorderWidth < 0 || style.BorderWidth > maxBlockBorderWidth ||
		style.Radius < 0 || style.Radius > maxBlockLength || style.Padding < 0 || style.Padding > maxBlockLength ||
		style.LineHeight < minBlockLineHeight || style.LineHeight > maxBlockLineHeight ||
		style.LetterSpacing < minBlockLetterSpace || style.LetterSpacing > maxBlockLetterSpace ||
		style.TextSize < minBlockTextSize || style.TextSize > maxBlockTextSize ||
		style.Opacity < minBlockOpacity || style.Opacity > fullPercentage {
		return blockError(block, "a style length or percentage is out of range")
	}
	if !inSet(style.BorderStyle, BorderSolid, BorderDashed, BorderDotted, BorderDouble) ||
		!inSet(style.Shadow, ShadowNone, ShadowSoft, ShadowStrong, ShadowGlow) {
		return blockError(block, "style borderStyle or shadow is invalid")
	}
	if !inSet(style.FontFamily, BlockFontInherit, BlockFontSans, BlockFontSerif, BlockFontMono, BlockFontCustom) ||
		!inSet(style.FontWeight, FontWeightInherit, FontWeight400, FontWeight500, FontWeight600, FontWeight700) {
		return blockError(block, "style fontFamily or fontWeight is invalid")
	}
	if !inSet(style.Align, BlockAlignStart, BlockAlignCenter, BlockAlignEnd) ||
		!inSet(style.VerticalAlign, BlockAlignStart, BlockAlignCenter, BlockAlignEnd) {
		return blockError(block, "style align or verticalAlign is invalid")
	}
	if (style.FontFamily == BlockFontCustom) != (style.FontAssetID != nil) {
		return blockError(block, "style fontAssetId is required exactly when fontFamily is custom")
	}
	if isMediaWidget(widgetType) && (style.BackgroundAssetID != nil || style.BackgroundDim != 0) {
		return blockError(block, "a %s block has no background image", widgetType)
	}
	if style.FontAssetID != nil {
		refs.FontAssets = append(refs.FontAssets, *style.FontAssetID)
	}
	if style.BackgroundAssetID != nil {
		refs.ImageAssets = append(refs.ImageAssets, *style.BackgroundAssetID)
	}
	return nil
}

// parseBlock strictly decodes and validates one block; its widget is returned in canonical form.
func parseBlock(position int, raw json.RawMessage) (Block, WidgetRefs, error) {
	label := fmt.Sprintf("#%d", position+1)
	generic, ok := requireKeys(raw, blockKeys, nil)
	if !ok {
		return Block{}, WidgetRefs{}, blockError(label, "a block needs id, name, x, y, w, h, hidden, locked, widget and style")
	}
	var decoded struct {
		ID     string          `json:"id"`
		Name   string          `json:"name"`
		X      int             `json:"x"`
		Y      int             `json:"y"`
		W      int             `json:"w"`
		H      int             `json:"h"`
		Hidden bool            `json:"hidden"`
		Locked bool            `json:"locked"`
		Widget json.RawMessage `json:"widget"`
		Style  json.RawMessage `json:"style"`
	}
	if err := strictDecode(raw, &decoded); err != nil {
		return Block{}, WidgetRefs{}, blockError(label, "invalid block: %s", decodeMessage(err))
	}
	if !blockIDPattern.MatchString(decoded.ID) {
		return Block{}, WidgetRefs{}, blockError(label, "id must be 1 to 40 letters, digits, underscores or hyphens")
	}
	name, err := cleanName(decoded.Name, fmt.Sprintf("block %q: name", decoded.ID), maxBlockNameRunes)
	if err != nil {
		return Block{}, WidgetRefs{}, err
	}
	if decoded.X < -maxBlockCoordinate || decoded.X > maxBlockCoordinate ||
		decoded.Y < -maxBlockCoordinate || decoded.Y > maxBlockCoordinate ||
		decoded.W < minBlockExtent || decoded.W > maxBlockExtent || decoded.H < minBlockExtent || decoded.H > maxBlockExtent {
		return Block{}, WidgetRefs{}, blockError(
			decoded.ID,
			"x and y must be between %d and %d, w and h between %d and %d",
			-maxBlockCoordinate, maxBlockCoordinate, minBlockExtent, maxBlockExtent,
		)
	}
	widget, refs, err := ValidateWidget(decoded.ID, decoded.Widget)
	if err != nil {
		return Block{}, WidgetRefs{}, err
	}
	if _, ok := requireKeys(generic["style"], styleKeys, styleNullableKeys); !ok {
		return Block{}, WidgetRefs{}, blockError(decoded.ID, "style needs every field (only colours and assets may be null)")
	}
	var style BlockStyle
	if err := strictDecode(decoded.Style, &style); err != nil {
		return Block{}, WidgetRefs{}, blockError(decoded.ID, "invalid style: %s", decodeMessage(err))
	}
	var head widgetType
	if err := json.Unmarshal(widget, &head); err != nil {
		return Block{}, WidgetRefs{}, err
	}
	if err := ValidateBlockStyle(decoded.ID, head.Type, style, &refs); err != nil {
		return Block{}, WidgetRefs{}, err
	}
	return Block{
		ID:     decoded.ID,
		Name:   name,
		X:      decoded.X,
		Y:      decoded.Y,
		W:      decoded.W,
		H:      decoded.H,
		Hidden: decoded.Hidden,
		Locked: decoded.Locked,
		Widget: widget,
		Style:  style,
	}, refs, nil
}

// ParseBlocks strictly decodes and validates the blocks of a scene: at most MaxBlocks blocks with distinct ids,
// each with a valid widget and style. It returns the canonical blocks and everything they reference; null or an
// absent array is an empty scene.
func ParseBlocks(raw json.RawMessage) ([]Block, WidgetRefs, error) {
	if len(raw) > maxBlocksJSONBytes {
		return nil, WidgetRefs{}, validation("scene blocks are too large")
	}
	var items []json.RawMessage
	if len(raw) > 0 && strings.TrimSpace(string(raw)) != "null" {
		if err := json.Unmarshal(raw, &items); err != nil {
			return nil, WidgetRefs{}, validation("blocks must be an array of blocks")
		}
	}
	if len(items) > MaxBlocks {
		return nil, WidgetRefs{}, validation("a scene has at most %d blocks", MaxBlocks)
	}
	blocks := make([]Block, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	var refs WidgetRefs
	for position, item := range items {
		block, blockRefs, err := parseBlock(position, item)
		if err != nil {
			return nil, WidgetRefs{}, err
		}
		if _, duplicate := seen[block.ID]; duplicate {
			return nil, WidgetRefs{}, blockError(block.ID, "block ids must be unique within the scene")
		}
		seen[block.ID] = struct{}{}
		blocks = append(blocks, block)
		refs.merge(blockRefs)
	}
	encoded, err := json.Marshal(blocks)
	if err != nil {
		return nil, WidgetRefs{}, err
	}
	if len(encoded) > maxBlocksJSONBytes {
		return nil, WidgetRefs{}, apperror.New(http.StatusUnprocessableEntity, "validation_failed", "scene blocks are too large")
	}
	refs.ImageAssets, refs.VideoAssets = distinct(refs.ImageAssets), distinct(refs.VideoAssets)
	refs.FontAssets = distinct(refs.FontAssets)
	refs.Machines, refs.Templates = distinct(refs.Machines), distinct(refs.Templates)
	return blocks, refs, nil
}

// visibleWidgets lists the widgets that displays show: those of blocks that are not hidden.
func visibleWidgets(blocks []Block) []RawWidget {
	widgets := make([]RawWidget, 0, len(blocks))
	for _, block := range blocks {
		if !block.Hidden {
			widgets = append(widgets, block.Widget)
		}
	}
	return widgets
}

// blockRefs lists what one stored block refers to.
func blockRefs(block Block) (WidgetRefs, error) {
	_, refs, err := ValidateWidget(block.ID, block.Widget)
	if err != nil {
		return WidgetRefs{}, err
	}
	if block.Style.FontAssetID != nil {
		refs.FontAssets = append(refs.FontAssets, *block.Style.FontAssetID)
	}
	if block.Style.BackgroundAssetID != nil {
		refs.ImageAssets = append(refs.ImageAssets, *block.Style.BackgroundAssetID)
	}
	return refs, nil
}

func compactJSON(raw json.RawMessage) (json.RawMessage, error) {
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return nil, err
	}
	return compact.Bytes(), nil
}

func marshalBlocks(blocks []Block) ([]byte, error) {
	if blocks == nil {
		blocks = []Block{}
	}
	return json.Marshal(blocks)
}
