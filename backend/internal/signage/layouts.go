package signage

// Zone is one cell of a layout grid. Rows and columns are 1-based CSS grid lines.
type Zone struct {
	ID                         string
	Label                      string
	Col, Row, ColSpan, RowSpan int
}

// Layout is a fixed, code-defined zone arrangement. The list is versioned together with the
// OpenAPI SignageLayoutId enum and the frontend grid CSS; scenes only store the layout id.
type Layout struct {
	ID, Name string
	Columns  string
	Rows     string
	Zones    []Zone
}

func cell(id, label string, col, row, colSpan, rowSpan int) Zone {
	return Zone{ID: id, Label: label, Col: col, Row: row, ColSpan: colSpan, RowSpan: rowSpan}
}

var layouts = []Layout{
	{ID: "full", Name: "Full screen", Columns: "1fr", Rows: "1fr", Zones: []Zone{cell("main", "Main", 1, 1, 1, 1)}},
	{ID: "stack3", Name: "Header, main, footer", Columns: "1fr", Rows: "14fr 72fr 14fr", Zones: []Zone{
		cell("header", "Header", 1, 1, 1, 1), cell("main", "Main", 1, 2, 1, 1), cell("footer", "Footer", 1, 3, 1, 1),
	}},
	{ID: "stack4", Name: "Header, main, info, footer", Columns: "1fr", Rows: "10fr 52fr 24fr 14fr", Zones: []Zone{
		cell("header", "Header", 1, 1, 1, 1), cell("main", "Main", 1, 2, 1, 1), cell("info", "Info", 1, 3, 1, 1), cell("footer", "Footer", 1, 4, 1, 1),
	}},
	{ID: "split", Name: "Two columns", Columns: "1fr 1fr", Rows: "1fr", Zones: []Zone{
		cell("left", "Left", 1, 1, 1, 1), cell("right", "Right", 2, 1, 1, 1),
	}},
	{ID: "grid2x2", Name: "Four quarters", Columns: "1fr 1fr", Rows: "1fr 1fr", Zones: []Zone{
		cell("tl", "Top left", 1, 1, 1, 1), cell("tr", "Top right", 2, 1, 1, 1), cell("bl", "Bottom left", 1, 2, 1, 1), cell("br", "Bottom right", 2, 2, 1, 1),
	}},
	{ID: "quad_banner", Name: "Four quarters with banner", Columns: "1fr 1fr", Rows: "44fr 44fr 12fr", Zones: []Zone{
		cell("tl", "Top left", 1, 1, 1, 1), cell("tr", "Top right", 2, 1, 1, 1), cell("bl", "Bottom left", 1, 2, 1, 1), cell("br", "Bottom right", 2, 2, 1, 1), cell("banner", "Banner", 1, 3, 2, 1),
	}},
	{ID: "main_side", Name: "Main with sidebar", Columns: "2fr 1fr", Rows: "1fr 1fr", Zones: []Zone{
		cell("main", "Main", 1, 1, 1, 2), cell("side_top", "Sidebar top", 2, 1, 1, 1), cell("side_bottom", "Sidebar bottom", 2, 2, 1, 1),
	}},
	{ID: "main_footer", Name: "Main and footer banner", Columns: "1fr", Rows: "92fr 8fr", Zones: []Zone{
		cell("main", "Main", 1, 1, 1, 1), cell("footer", "Footer", 1, 2, 1, 1),
	}},
	{ID: "banner_main", Name: "Banner and main", Columns: "1fr", Rows: "16fr 84fr", Zones: []Zone{
		cell("banner", "Banner", 1, 1, 1, 1), cell("main", "Main", 1, 2, 1, 1),
	}},
}

// Layouts returns the fixed layout list in display order.
func Layouts() []Layout {
	result := make([]Layout, len(layouts))
	copy(result, layouts)
	return result
}

// LayoutByID returns the layout with the given id.
func LayoutByID(id string) (Layout, bool) {
	for _, layout := range layouts {
		if layout.ID == id {
			return layout, true
		}
	}
	return Layout{}, false
}

// remapZones keeps widgets by position when the layout changes: zone n of the new layout takes
// the widget of zone n of the old one; surplus old widgets are dropped, missing ones become empty.
func remapZones(old Layout, zones map[string]RawWidget, next Layout) map[string]RawWidget {
	result := make(map[string]RawWidget, len(next.Zones))
	for index, zone := range next.Zones {
		if index < len(old.Zones) {
			if widget, ok := zones[old.Zones[index].ID]; ok {
				result[zone.ID] = widget
				continue
			}
		}
		result[zone.ID] = emptyWidget
	}
	return result
}

func emptyZones(layout Layout) map[string]RawWidget {
	result := make(map[string]RawWidget, len(layout.Zones))
	for _, zone := range layout.Zones {
		result[zone.ID] = emptyWidget
	}
	return result
}
