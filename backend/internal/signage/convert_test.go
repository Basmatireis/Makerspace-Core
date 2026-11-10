package signage

import (
	"encoding/json"
	"testing"
)

// Every built-in layout becomes blocks that tile the grid exactly (no gap, no overlap) at any aspect ratio.
func TestConvertLegacySceneTilesEveryBuiltInLayout(t *testing.T) {
	ratios := []AspectRatio{{16, 9}, {9, 16}, {21, 9}, {4, 3}, {1, 1}, {7, 3}, {3, 7}, {100, 1}}
	for id, layout := range legacyLayouts {
		for _, ratio := range ratios {
			blocks, err := ConvertLegacyScene(ratio, id, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			width, height := GridSize(ratio)
			if len(blocks) != len(layout.zones) {
				t.Fatalf("%s %s: %d blocks for %d zones", id, ratio, len(blocks), len(layout.zones))
			}
			if width > maxBlockExtent {
				continue // clamped; covered below
			}
			area := 0
			for index, block := range blocks {
				if block.ID != layout.zones[index].id || block.Name != layout.zones[index].label {
					t.Fatalf("%s: block %d is %s %q", id, index, block.ID, block.Name)
				}
				if block.X < 0 || block.Y < 0 || block.X+block.W > width || block.Y+block.H > height {
					t.Fatalf("%s %s: block %s outside %dx%d: %+v", id, ratio, block.ID, width, height, block)
				}
				area += block.W * block.H
			}
			if area != width*height {
				t.Fatalf("%s %s: blocks cover %d of %d units", id, ratio, area, width*height)
			}
			if _, _, err := ParseBlocks(mustMarshal(t, blocks)); err != nil {
				t.Fatalf("%s %s: %v", id, ratio, err)
			}
		}
	}
	wide, err := ConvertLegacyScene(AspectRatio{100, 1}, "split", nil, nil)
	if err != nil || wide[1].X != maxBlockCoordinate || wide[1].W != maxBlockExtent {
		t.Fatalf("an extreme ratio is not clamped to the block bounds: %+v %v", wide, err)
	}
	unknown, err := ConvertLegacyScene(AspectRatio{16, 9}, "carousel", nil, nil)
	if err != nil || len(unknown) != 1 || unknown[0].ID != "main" || unknown[0].W != 1920 {
		t.Fatalf("unknown layout = %+v %v", unknown, err)
	}
}

func TestConvertLegacyWidgetKeepsTheOldLook(t *testing.T) {
	style := func(fields string) string {
		return `{"textColor":null,"backgroundColor":"#123456","borderColor":"#abcdef","backgroundOpacity":40,` +
			`"padding":0,"radius":10,"borderWidth":20,"fontScale":25,"fontFamily":"custom",` +
			`"fontAssetId":"01a163eb-b3fd-74c6-9fa2-4aeb568c12f3"` + fields + `}`
	}
	cases := []struct {
		name, widget string
		want         func(BlockStyle) bool
	}{
		{"plain text", `{"type":"text","text":"x","size":"s","align":"center"}`, func(s BlockStyle) bool {
			return s.TextSize == 32 && s.Align == BlockAlignCenter && s.VerticalAlign == BlockAlignCenter &&
				s.Padding == 22 && s.FontWeight == FontWeight600 && s.LineHeight == 115
		}},
		{"rich text", `{"type":"text","text":"x","size":"xl","align":"start","format":"html"}`, func(s BlockStyle) bool {
			return s.TextSize == 108 && s.FontWeight == FontWeightInherit && s.LineHeight == 130
		}},
		{"styled text", `{"type":"text","text":"x","size":"m","align":"end","style":` +
			style(`,"align":"inherit","verticalAlign":"start"`) + `}`, func(s BlockStyle) bool {
			return s.TextSize == 12 && s.Align == BlockAlignEnd && s.VerticalAlign == BlockAlignStart && s.Padding == 0 &&
				s.Radius == 108 && s.BorderWidth == 22 && s.BackgroundOpacity == 40 && *s.BackgroundColor == "#123456" &&
				*s.BorderColor == "#abcdef" && s.TextColor == nil && s.FontFamily == BlockFontCustom && s.FontAssetID != nil
		}},
		{"announcement box style", `{"type":"announcement","templateIds":[],"style":"full","size":"l","whenNone":"empty",` +
			`"fallbackText":"","whenMany":"rotate","rotateSeconds":10,"boxStyle":` +
			style(`,"align":"start","verticalAlign":"inherit"`) + `}`, func(s BlockStyle) bool {
			return s.TextSize == 19 && s.Align == BlockAlignCenter && s.VerticalAlign == BlockAlignCenter &&
				s.LineHeight == 115 && s.Radius == 108
		}},
		{"unstyled image", `{"type":"image","mediaId":null,"fit":"cover"}`, func(s BlockStyle) bool {
			return s.TextSize == 32 && s.Padding == 0 && s.Align == BlockAlignStart && s.VerticalAlign == BlockAlignStart &&
				s.BackgroundColor == nil && s.BackgroundOpacity == 100 && s.FontFamily == BlockFontInherit
		}},
		{"clock ignores alignment", `{"type":"clock","mode":"time","style":` +
			style(`,"align":"end","verticalAlign":"inherit"`) + `}`, func(s BlockStyle) bool {
			return s.Align == BlockAlignCenter && s.VerticalAlign == BlockAlignCenter && s.TextSize == 8
		}},
		{"list", `{"type":"open_days","count":3}`, func(s BlockStyle) bool {
			return s.Padding == 22 && s.VerticalAlign == BlockAlignStart && s.LineHeight == 125
		}},
		{"custom font without asset", `{"type":"status","machineIds":[],"showProgress":true,"showRemaining":true,"style":` +
			`{"fontFamily":"custom","fontAssetId":null,"padding":1,"align":"inherit","verticalAlign":"inherit"}}`,
			func(s BlockStyle) bool {
				return s.FontFamily == BlockFontInherit && s.FontAssetID == nil && s.Padding == 11 && s.TextSize == 32
			}},
		{"not a widget", `"oops"`, func(s BlockStyle) bool { return s.TextSize == 32 }},
	}
	for _, c := range cases {
		widget, style, err := convertLegacyWidget(json.RawMessage(c.widget))
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if !c.want(style) {
			t.Errorf("%s: style = %+v", c.name, style)
		}
		var head widgetType
		if err := json.Unmarshal(widget, &head); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		var refs WidgetRefs
		if _, _, err := ValidateWidget("main", widget); err != nil {
			t.Errorf("%s: converted widget %s does not validate: %v", c.name, widget, err)
		}
		if err := ValidateBlockStyle("main", head.Type, style, &refs); err != nil {
			t.Errorf("%s: converted style does not validate: %v", c.name, err)
		}
	}
}
