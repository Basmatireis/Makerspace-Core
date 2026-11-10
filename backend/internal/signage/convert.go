package signage

import (
	"encoding/json"
	"math/big"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
)

// Before migration 00129 (and in publications before manifest version 4) a scene was a layout with one widget per
// zone, and widgets carried an optional zone style. ConvertLegacyScene turns such a scene into blocks that render
// exactly as before. Migration 00129 implements the same rules in PL/pgSQL for the stored scenes, and
// TestSignageBlocksMigrationMatchesGoConversion keeps both equal; change neither without the other.
//
// The old renderer measured everything in u, 1 % of the scene's short side, so 1u is 10.8 grid units. All
// arithmetic is integer arithmetic with round-half-up division, which PostgreSQL reproduces exactly.

const (
	// tenthsOfGridPerU is 1u in tenths of a grid unit.
	tenthsOfGridPerU = 108
	// defaultZonePadding is the 2u padding the old renderer gave unstyled text, status, clock, list, calendar
	// and QR zones.
	defaultZonePadding = 22
	defaultTextSize    = 32
	percentHundredths  = 10000
)

// legacyGridZone is a zone placed on 1-based grid lines.
type legacyGridZone struct {
	id, label                  string
	col, row, colSpan, rowSpan int
}

// legacyGrid is a layout of fr-weighted tracks without gaps.
type legacyGrid struct {
	columns, rows []int
	zones         []legacyGridZone
}

func legacyCell(id, label string, col, row, colSpan, rowSpan int) legacyGridZone {
	return legacyGridZone{id: id, label: label, col: col, row: row, colSpan: colSpan, rowSpan: rowSpan}
}

// legacyLayouts are the nine built-in layouts that scenes could use; an unknown id rendered as full.
var legacyLayouts = map[string]legacyGrid{
	"full": {columns: []int{1}, rows: []int{1}, zones: []legacyGridZone{legacyCell("main", "Main", 1, 1, 1, 1)}},
	"stack3": {columns: []int{1}, rows: []int{14, 72, 14}, zones: []legacyGridZone{
		legacyCell("header", "Header", 1, 1, 1, 1),
		legacyCell("main", "Main", 1, 2, 1, 1),
		legacyCell("footer", "Footer", 1, 3, 1, 1),
	}},
	"stack4": {columns: []int{1}, rows: []int{10, 52, 24, 14}, zones: []legacyGridZone{
		legacyCell("header", "Header", 1, 1, 1, 1),
		legacyCell("main", "Main", 1, 2, 1, 1),
		legacyCell("info", "Info", 1, 3, 1, 1),
		legacyCell("footer", "Footer", 1, 4, 1, 1),
	}},
	"split": {columns: []int{1, 1}, rows: []int{1}, zones: []legacyGridZone{
		legacyCell("left", "Left", 1, 1, 1, 1),
		legacyCell("right", "Right", 2, 1, 1, 1),
	}},
	"grid2x2": {columns: []int{1, 1}, rows: []int{1, 1}, zones: []legacyGridZone{
		legacyCell("tl", "Top left", 1, 1, 1, 1),
		legacyCell("tr", "Top right", 2, 1, 1, 1),
		legacyCell("bl", "Bottom left", 1, 2, 1, 1),
		legacyCell("br", "Bottom right", 2, 2, 1, 1),
	}},
	"quad_banner": {columns: []int{1, 1}, rows: []int{44, 44, 12}, zones: []legacyGridZone{
		legacyCell("tl", "Top left", 1, 1, 1, 1),
		legacyCell("tr", "Top right", 2, 1, 1, 1),
		legacyCell("bl", "Bottom left", 1, 2, 1, 1),
		legacyCell("br", "Bottom right", 2, 2, 1, 1),
		legacyCell("banner", "Banner", 1, 3, 2, 1),
	}},
	"main_side": {columns: []int{2, 1}, rows: []int{1, 1}, zones: []legacyGridZone{
		legacyCell("main", "Main", 1, 1, 1, 2),
		legacyCell("side_top", "Sidebar top", 2, 1, 1, 1),
		legacyCell("side_bottom", "Sidebar bottom", 2, 2, 1, 1),
	}},
	"main_footer": {columns: []int{1}, rows: []int{92, 8}, zones: []legacyGridZone{
		legacyCell("main", "Main", 1, 1, 1, 1),
		legacyCell("footer", "Footer", 1, 2, 1, 1),
	}},
	"banner_main": {columns: []int{1}, rows: []int{16, 84}, zones: []legacyGridZone{
		legacyCell("banner", "Banner", 1, 1, 1, 1),
		legacyCell("main", "Main", 1, 2, 1, 1),
	}},
}

// LegacyCustomLayout is a custom layout as stored before migration 00129 and published before manifest version 4.
type LegacyCustomLayout struct {
	ID      uuid.UUID          `json:"id"`
	Mode    string             `json:"mode"`
	Columns []int              `json:"columns"`
	Rows    []int              `json:"rows"`
	Zones   []LegacyCustomZone `json:"zones"`
}

// LegacyCustomZone is a zone of a custom layout: grid layouts placed it on tracks, free layouts in percent.
type LegacyCustomZone struct {
	ID    string            `json:"id"`
	Label string            `json:"label"`
	Grid  *LegacyGridPlace  `json:"grid"`
	Rect  *LegacyPercentBox `json:"rect"`
}

// LegacyGridPlace is a zone's position on 1-based grid lines.
type LegacyGridPlace struct {
	Col     int `json:"col"`
	Row     int `json:"row"`
	ColSpan int `json:"colSpan"`
	RowSpan int `json:"rowSpan"`
}

// LegacyPercentBox is a free zone in percent of the screen with at most two decimals. The values stay decimal
// numbers so that rounding them matches PostgreSQL's numeric arithmetic.
type LegacyPercentBox struct {
	X      json.Number `json:"x"`
	Y      json.Number `json:"y"`
	Width  json.Number `json:"width"`
	Height json.Number `json:"height"`
}

// legacyZone is a zone resolved to a box in grid units.
type legacyZone struct {
	id, label  string
	x, y, w, h int
}

// GridSize is the size of a scene's layout grid: the short side is GridShortSide units long.
func GridSize(ratio AspectRatio) (width, height int) {
	if ratio.Width < 1 || ratio.Height < 1 {
		ratio = AspectRatio{Width: 16, Height: 9}
	}
	if ratio.Width >= ratio.Height {
		return roundDiv(GridShortSide*ratio.Width, ratio.Height), GridShortSide
	}
	return GridShortSide, roundDiv(GridShortSide*ratio.Height, ratio.Width)
}

// roundDiv is n/d rounded half up for d > 0; Go and PostgreSQL both truncate integer division towards zero.
func roundDiv(n, d int) int {
	return int((2*int64(n) + int64(d)) / (2 * int64(d)))
}

func clampInt(value, low, high int) int {
	return min(max(value, low), high)
}

// trackEdges are the grid lines of fr-weighted tracks across total units, rounded so that tracks tile.
func trackEdges(total int, weights []int) []int {
	if len(weights) == 0 {
		weights = []int{1}
	}
	sum := 0
	for _, weight := range weights {
		sum += weight
	}
	if sum < 1 {
		sum = 1
	}
	edges := make([]int, len(weights)+1)
	running := 0
	for index, weight := range weights {
		running += weight
		edges[index+1] = roundDiv(total*running, sum)
	}
	return edges
}

func gridZones(width, height int, grid legacyGrid) []legacyZone {
	columns, rows := trackEdges(width, grid.columns), trackEdges(height, grid.rows)
	zones := make([]legacyZone, 0, len(grid.zones))
	for _, zone := range grid.zones {
		col := clampInt(zone.col, 1, len(columns)-1)
		row := clampInt(zone.row, 1, len(rows)-1)
		colSpan := clampInt(zone.colSpan, 1, len(columns)-col)
		rowSpan := clampInt(zone.rowSpan, 1, len(rows)-row)
		zones = append(zones, legacyZone{
			id:    zone.id,
			label: zone.label,
			x:     columns[col-1],
			y:     rows[row-1],
			w:     columns[col-1+colSpan] - columns[col-1],
			h:     rows[row-1+rowSpan] - rows[row-1],
		})
	}
	return zones
}

// hundredths is a percentage in hundredths, rounded half away from zero like PostgreSQL's round(numeric) and
// clamped to 0–100 %. A missing or malformed value is fallback.
func hundredths(value json.Number, fallback int) int {
	parsed, ok := new(big.Rat).SetString(value.String())
	if value == "" || !ok {
		return fallback
	}
	scaled := new(big.Rat).Mul(parsed, big.NewRat(100, 1))
	half := big.NewRat(1, 2)
	if scaled.Sign() < 0 {
		scaled.Sub(scaled, half)
	} else {
		scaled.Add(scaled, half)
	}
	rounded := new(big.Int).Quo(scaled.Num(), scaled.Denom())
	if !rounded.IsInt64() {
		return clampInt(rounded.Sign()*percentHundredths, 0, percentHundredths)
	}
	return clampInt(int(rounded.Int64()), 0, percentHundredths)
}

func customZones(width, height int, custom LegacyCustomLayout) []legacyZone {
	if custom.Mode == string(legacyModeFree) {
		zones := make([]legacyZone, 0, len(custom.Zones))
		for _, zone := range custom.Zones {
			box := LegacyPercentBox{X: "0", Y: "0", Width: "100", Height: "100"}
			if zone.Rect != nil {
				box = *zone.Rect
			}
			x, y := hundredths(box.X, 0), hundredths(box.Y, 0)
			w, h := hundredths(box.Width, percentHundredths), hundredths(box.Height, percentHundredths)
			left, top := roundDiv(width*x, percentHundredths), roundDiv(height*y, percentHundredths)
			zones = append(zones, legacyZone{
				id:    zone.ID,
				label: zone.Label,
				x:     left,
				y:     top,
				w:     roundDiv(width*(x+w), percentHundredths) - left,
				h:     roundDiv(height*(y+h), percentHundredths) - top,
			})
		}
		return zones
	}
	grid := legacyGrid{columns: custom.Columns, rows: custom.Rows}
	for _, zone := range custom.Zones {
		place := LegacyGridPlace{Col: 1, Row: 1, ColSpan: 1, RowSpan: 1}
		if zone.Grid != nil {
			place = *zone.Grid
		}
		grid.zones = append(grid.zones, legacyCell(zone.ID, zone.Label, place.Col, place.Row, place.ColSpan, place.RowSpan))
	}
	return gridZones(width, height, grid)
}

type legacyLayoutMode string

const legacyModeFree legacyLayoutMode = "free"

// legacyCustomLayoutID is the layout id with which a scene used a custom layout.
const legacyCustomLayoutID = "custom"

var invalidBlockIDRunes = regexp.MustCompile(`[^A-Za-z0-9_-]`)

// legacyBlockID turns a zone id into a block id; zone ids already fit, so this only guards odd input.
func legacyBlockID(zoneID string) string {
	id := invalidBlockIDRunes.ReplaceAllString(zoneID, "_")
	if utf8.RuneCountInString(id) > 40 {
		id = string([]rune(id)[:40])
	}
	if id == "" {
		return "block"
	}
	return id
}

func legacyBlockName(label, id string) string {
	name := strings.Trim(label, " ")
	if utf8.RuneCountInString(name) > maxBlockNameRunes {
		name = string([]rune(name)[:maxBlockNameRunes])
	}
	if name == "" {
		return id
	}
	return name
}

// ConvertLegacyScene returns the blocks of a scene that showed one widget per zone of a layout: one block per
// zone in layout order (for free layouts that is the stacking order), empty zones included. custom is the scene's
// custom layout when layoutID is "custom"; a missing or empty one, like an unknown layout id, renders as full.
func ConvertLegacyScene(
	ratio AspectRatio,
	layoutID string,
	custom *LegacyCustomLayout,
	zones map[string]json.RawMessage,
) ([]Block, error) {
	width, height := GridSize(ratio)
	var placed []legacyZone
	switch grid, builtin := legacyLayouts[layoutID]; {
	case layoutID == legacyCustomLayoutID && custom != nil && len(custom.Zones) > 0:
		placed = customZones(width, height, *custom)
	case builtin:
		placed = gridZones(width, height, grid)
	default:
		placed = gridZones(width, height, legacyLayouts["full"])
	}
	blocks := make([]Block, 0, len(placed))
	for _, zone := range placed {
		raw, ok := zones[zone.id]
		if !ok {
			raw = json.RawMessage(`{"type":"empty"}`)
		}
		widget, style, err := convertLegacyWidget(raw)
		if err != nil {
			return nil, err
		}
		id := legacyBlockID(zone.id)
		blocks = append(blocks, Block{
			ID:     id,
			Name:   legacyBlockName(zone.label, id),
			X:      clampInt(zone.x, -maxBlockCoordinate, maxBlockCoordinate),
			Y:      clampInt(zone.y, -maxBlockCoordinate, maxBlockCoordinate),
			W:      clampInt(zone.w, minBlockExtent, maxBlockExtent),
			H:      clampInt(zone.h, minBlockExtent, maxBlockExtent),
			Widget: widget,
			Style:  style,
		})
	}
	return blocks, nil
}

// legacyStyle is the zone style a widget could carry (`boxStyle` on announcements); lengths are in u, the
// border width in tenths of u and the font scale in percent.
type legacyStyle struct {
	TextColor         *string    `json:"textColor"`
	BackgroundColor   *string    `json:"backgroundColor"`
	BorderColor       *string    `json:"borderColor"`
	BackgroundOpacity *int       `json:"backgroundOpacity"`
	Padding           *int       `json:"padding"`
	Radius            *int       `json:"radius"`
	BorderWidth       *int       `json:"borderWidth"`
	FontScale         *int       `json:"fontScale"`
	FontFamily        *string    `json:"fontFamily"`
	FontAssetID       *uuid.UUID `json:"fontAssetId"`
	Align             *string    `json:"align"`
	VerticalAlign     *string    `json:"verticalAlign"`
}

func valueOr[T any](value *T, fallback T) T {
	if value == nil {
		return fallback
	}
	return *value
}

// legacyTextSizeTenths are the old text sizes s, m, l and xl in tenths of u.
var legacyTextSizeTenths = map[string]int{"s": 30, "m": 46, "l": 70, "xl": 100}

func jsonString(raw json.RawMessage) string {
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	return value
}

func validAlign(value string) bool {
	return inSet(BlockAlign(value), BlockAlignStart, BlockAlignCenter, BlockAlignEnd)
}

// convertLegacyWidget moves the zone style of a widget into a block style that reproduces the old look and
// adapts the widget's own fields: text loses size and align (now in the style) and gains fit, announcements lose
// size, cameras show the live badge and the name, images are not dimmed. Anything that is not a widget object
// becomes an empty widget, which is what the old renderer showed.
func convertLegacyWidget(raw json.RawMessage) (RawWidget, BlockStyle, error) {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || object == nil || jsonString(object["type"]) == "" {
		object = map[string]json.RawMessage{"type": json.RawMessage(`"empty"`)}
	}
	kind := WidgetType(jsonString(object["type"]))
	styleKey := "style"
	if kind == WidgetAnnouncement {
		styleKey = "boxStyle"
	}
	var zoneStyle *legacyStyle
	if stored, ok := object[styleKey]; ok && strings.HasPrefix(strings.TrimSpace(string(stored)), "{") {
		zoneStyle = &legacyStyle{}
		if err := json.Unmarshal(stored, zoneStyle); err != nil {
			return nil, BlockStyle{}, err
		}
	}
	delete(object, styleKey)
	style := legacyBlockStyle(kind, object, zoneStyle)
	switch kind {
	case WidgetText:
		delete(object, "size")
		delete(object, "align")
		object["fit"] = json.RawMessage(`false`)
	case WidgetAnnouncement:
		delete(object, "size")
	case WidgetCamera:
		object["showLive"] = json.RawMessage(`true`)
		object["showName"] = json.RawMessage(`true`)
	case WidgetImage:
		object["dim"] = json.RawMessage(`0`)
	}
	widget, err := json.Marshal(object)
	if err != nil {
		return nil, BlockStyle{}, err
	}
	return widget, style, nil
}

// legacyBlockStyle derives the block style from a widget (before its fields are adapted) and its zone style.
func legacyBlockStyle(kind WidgetType, widget map[string]json.RawMessage, zone *legacyStyle) BlockStyle {
	if zone == nil {
		zone = &legacyStyle{}
	} else if zone.Padding == nil {
		zero := 0
		zone.Padding = &zero
	}
	fontScale := valueOr(zone.FontScale, 100)
	richText := !inSet(jsonString(widget["format"]), "", string(FormatPlain))
	style := BlockStyle{
		BackgroundColor:   zone.BackgroundColor,
		BackgroundOpacity: clampInt(valueOr(zone.BackgroundOpacity, fullPercentage), 0, fullPercentage),
		TextColor:         zone.TextColor,
		BorderWidth:       clampInt(roundDiv(valueOr(zone.BorderWidth, 0)*tenthsOfGridPerU, 100), 0, maxBlockBorderWidth),
		BorderStyle:       BorderSolid,
		BorderColor:       zone.BorderColor,
		Radius:            clampInt(roundDiv(valueOr(zone.Radius, 0)*tenthsOfGridPerU, 10), 0, maxBlockLength),
		Shadow:            ShadowNone,
		FontFamily:        BlockFontInherit,
		FontWeight:        FontWeightInherit,
		LineHeight:        125,
		Opacity:           fullPercentage,
		Align:             BlockAlignStart,
		VerticalAlign:     BlockAlignStart,
	}
	// A zone without a style kept the renderer's default padding; a style replaced it, even with 0.
	switch {
	case zone.Padding != nil:
		style.Padding = clampInt(roundDiv(*zone.Padding*tenthsOfGridPerU, 10), 0, maxBlockLength)
	case inSet(kind, WidgetText, WidgetStatus, WidgetClock, WidgetOpenDays, WidgetEvents, WidgetAgenda, WidgetCalendar, WidgetQR):
		style.Padding = defaultZonePadding
	}
	switch family := BlockFontFamily(valueOr(zone.FontFamily, "")); {
	case family == BlockFontCustom && zone.FontAssetID != nil:
		style.FontFamily, style.FontAssetID = BlockFontCustom, zone.FontAssetID
	case inSet(family, BlockFontSans, BlockFontSerif, BlockFontMono):
		style.FontFamily = family
	}
	if inSet(kind, WidgetText, WidgetAnnouncement) {
		tenths, ok := legacyTextSizeTenths[jsonString(widget["size"])]
		if !ok {
			tenths = legacyTextSizeTenths["m"]
		}
		style.TextSize = roundDiv(tenths*tenthsOfGridPerU*fontScale, 100*100)
	} else {
		style.TextSize = roundDiv(defaultTextSize*fontScale, 100)
	}
	style.TextSize = clampInt(style.TextSize, minBlockTextSize, maxBlockTextSize)
	switch {
	case kind == WidgetText && !richText:
		style.FontWeight, style.LineHeight = FontWeight600, 115
	case kind == WidgetText:
		style.LineHeight = 130
	case kind == WidgetAnnouncement:
		style.LineHeight = 115
	}
	// Clocks and QR codes, and full-screen announcements, were always centred; the zone style aligned the rest.
	zoneAlign := valueOr(zone.Align, "")
	switch {
	case inSet(kind, WidgetClock, WidgetQR):
		style.Align = BlockAlignCenter
	case kind == WidgetAnnouncement && jsonString(widget["style"]) == string(AnnouncementStyleFull):
		style.Align = BlockAlignCenter
	case validAlign(zoneAlign):
		style.Align = BlockAlign(zoneAlign)
	case kind == WidgetText && validAlign(jsonString(widget["align"])):
		style.Align = BlockAlign(jsonString(widget["align"]))
	}
	switch zoneVertical := valueOr(zone.VerticalAlign, ""); {
	case validAlign(zoneVertical):
		style.VerticalAlign = BlockAlign(zoneVertical)
	case inSet(kind, WidgetText, WidgetClock, WidgetQR, WidgetStatus, WidgetAnnouncement, WidgetCamera):
		style.VerticalAlign = BlockAlignCenter
	}
	return style
}

// legacyManifestScene is the part of a scene published before manifest version 4 that blocks replace.
type legacyManifestScene struct {
	LayoutID       string                     `json:"layoutId"`
	CustomLayoutID *uuid.UUID                 `json:"customLayoutId"`
	Zones          map[string]json.RawMessage `json:"zones"`
}
