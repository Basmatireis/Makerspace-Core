package signage

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

// testStyleJSON is a valid block style with the default look.
const testStyleJSON = `{"backgroundColor":null,"backgroundOpacity":100,"backgroundAssetId":null,"backgroundDim":0,` +
	`"textColor":null,"borderWidth":0,"borderStyle":"solid","borderColor":null,"radius":0,"shadow":"none",` +
	`"fontFamily":"inherit","fontAssetId":null,"fontWeight":"inherit","lineHeight":125,"letterSpacing":0,` +
	`"uppercase":false,"textSize":32,"padding":0,"align":"start","verticalAlign":"start","opacity":100}`

func blockJSON(id, widget string) string {
	return `{"id":"` + id + `","name":"Block ` + id + `","x":0,"y":0,"w":1920,"h":1080,"hidden":false,"locked":false,` +
		`"widget":` + widget + `,"style":` + testStyleJSON + `}`
}

func blocksJSON(blocks ...string) json.RawMessage {
	return json.RawMessage("[" + strings.Join(blocks, ",") + "]")
}

// parseWidget validates one widget inside a single block.
func parseWidget(widget string) (Block, WidgetRefs, error) {
	blocks, refs, err := ParseBlocks(blocksJSON(blockJSON("main", widget)))
	if err != nil {
		return Block{}, refs, err
	}
	return blocks[0], refs, nil
}

func TestParseBlocksAcceptsEveryWidgetType(t *testing.T) {
	image, video, machine, template := ids.New(), ids.New(), ids.New(), ids.New()
	widgets := map[string]string{
		"empty":        `{"type":"empty"}`,
		"image":        `{"type":"image","mediaId":"` + image.String() + `","fit":"cover","dim":30}`,
		"image unset":  `{"type":"image","mediaId":null,"fit":"contain","dim":0}`,
		"video":        `{"type":"video","mediaId":"` + video.String() + `","fit":"contain"}`,
		"slideshow":    `{"type":"slideshow","mediaIds":["` + image.String() + `"],"seconds":8}`,
		"text":         `{"type":"text","text":"Hello\nworld <b>plain</b>","fit":true}`,
		"qr":           `{"type":"qr","url":"https://makerspace.example/join","caption":"Scan"}`,
		"clock":        `{"type":"clock","mode":"datetime"}`,
		"camera auto":  `{"type":"camera","source":"auto","machineId":null,"multi":"split","showProgress":true,"showRemaining":false,"fallback":"text","fallbackMediaId":null,"showLive":true,"showName":false}`,
		"camera fixed": `{"type":"camera","source":"machine","machineId":"` + machine.String() + `","multi":"alternate","showProgress":true,"showRemaining":true,"fallback":"image","fallbackMediaId":"` + image.String() + `","showLive":false,"showName":true}`,
		"status":       `{"type":"status","machineIds":["` + machine.String() + `"],"showProgress":true,"showRemaining":true}`,
		"open_days":    `{"type":"open_days","count":3}`,
		"events":       `{"type":"events","count":10}`,
		"announcement": `{"type":"announcement","templateIds":["` + template.String() + `"],"style":"banner","whenNone":"text","fallbackText":"All quiet","whenMany":"rotate","rotateSeconds":10}`,
	}
	for name, widget := range widgets {
		t.Run(name, func(t *testing.T) {
			block, refs, err := parseWidget(widget)
			if err != nil {
				t.Fatal(err)
			}
			var decoded map[string]any
			if err := json.Unmarshal(block.Widget, &decoded); err != nil || decoded["type"] == nil {
				t.Fatalf("canonical widget is not an object: %s (%v)", block.Widget, err)
			}
			if name == "camera fixed" && (len(refs.Machines) != 1 || len(refs.ImageAssets) != 1) {
				t.Fatalf("refs = %#v", refs)
			}
			if name == "video" && len(refs.VideoAssets) != 1 {
				t.Fatalf("refs = %#v", refs)
			}
		})
	}
}

func TestParseBlocksRejectsInvalidWidgets(t *testing.T) {
	id := ids.New().String()
	cases := map[string]string{
		"unknown field":         `{"type":"empty","extra":1}`,
		"unknown field on text": `{"type":"text","text":"x","fit":false,"html":"<b>"}`,
		"old text size":         `{"type":"text","text":"x","fit":false,"size":"m"}`,
		"old widget style":      `{"type":"clock","mode":"time","style":` + testStyleJSON + `}`,
		"old announcement box":  `{"type":"announcement","templateIds":[],"style":"card","whenNone":"empty","fallbackText":"","whenMany":"rotate","rotateSeconds":10,"boxStyle":{}}`,
		"unknown type":          `{"type":"iframe"}`,
		"missing type":          `{"text":"x"}`,
		"not an object":         `"text"`,
		"null widget":           `null`,
		"bad fit":               `{"type":"image","mediaId":null,"fit":"stretch","dim":0}`,
		"image dim":             `{"type":"image","mediaId":null,"fit":"cover","dim":91}`,
		"video dim":             `{"type":"video","mediaId":null,"fit":"cover","dim":0}`,
		"bad uuid":              `{"type":"image","mediaId":"nope","fit":"cover","dim":0}`,
		"http qr":               `{"type":"qr","url":"http://makerspace.example","caption":""}`,
		"javascript qr":         `{"type":"qr","url":"javascript:alert(1)","caption":""}`,
		"credentials qr":        `{"type":"qr","url":"https://user:pw@makerspace.example","caption":""}`,
		"empty qr":              `{"type":"qr","url":"","caption":""}`,
		"multiline caption":     `{"type":"qr","url":"https://x.example","caption":"a\nb"}`,
		"long text":             `{"type":"text","text":"` + strings.Repeat("a", 20001) + `","fit":false}`,
		"control character":     `{"type":"text","text":"a\u0000b","fit":false}`,
		"slideshow too fast":    `{"type":"slideshow","mediaIds":[],"seconds":1}`,
		"slideshow too long":    `{"type":"slideshow","mediaIds":[],"seconds":3601}`,
		"slideshow too many": `{"type":"slideshow","mediaIds":[` +
			strings.TrimSuffix(strings.Repeat(`"`+id+`",`, 51), ",") + `],"seconds":8}`,
		"camera needs machine": `{"type":"camera","source":"machine","machineId":null,"multi":"split","showProgress":true,"showRemaining":true,"fallback":"text","fallbackMediaId":null,"showLive":true,"showName":true}`,
		"clock mode":           `{"type":"clock","mode":"seconds"}`,
		"count zero":           `{"type":"open_days","count":0}`,
		"count twenty-one":     `{"type":"events","count":21}`,
		"rotate too fast":      `{"type":"announcement","templateIds":[],"style":"card","whenNone":"empty","fallbackText":"","whenMany":"rotate","rotateSeconds":1}`,
		"announcement style":   `{"type":"announcement","templateIds":[],"style":"popup","whenNone":"empty","fallbackText":"","whenMany":"rotate","rotateSeconds":10}`,
		"status too many": `{"type":"status","machineIds":[` +
			strings.TrimSuffix(strings.Repeat(`"`+id+`",`, 21), ",") + `],"showProgress":true,"showRemaining":true}`,
		"fallback text too long": `{"type":"announcement","templateIds":[],"style":"card","whenNone":"text","fallbackText":"` +
			strings.Repeat("a", 501) + `","whenMany":"rotate","rotateSeconds":10}`,
	}
	for name, widget := range cases {
		t.Run(name, func(t *testing.T) {
			_, _, err := parseWidget(widget)
			if err == nil {
				t.Fatal("invalid widget accepted")
			}
			if !apperror.IsCode(err, "validation_failed") {
				t.Fatalf("error = %v, want validation_failed", err)
			}
		})
	}
	if _, _, err := ValidateWidget("main", json.RawMessage(`{"type":"empty"} {"type":"empty"}`)); err == nil {
		t.Fatal("trailing data accepted")
	}
}

func TestParseBlocksRejectsInvalidBlocks(t *testing.T) {
	empty := `{"type":"empty"}`
	valid := blockJSON("main", empty)
	image := `{"type":"image","mediaId":null,"fit":"cover","dim":0}`
	withStyle := func(widget, old, replacement string) string {
		return strings.Replace(blockJSON("main", widget), old, replacement, 1)
	}
	many := make([]string, 0, MaxBlocks+1)
	for index := 0; index <= MaxBlocks; index++ {
		many = append(many, blockJSON(fmt.Sprintf("b%d", index), empty))
	}
	cases := map[string]json.RawMessage{
		"not an array":           json.RawMessage(`{"main":{"type":"empty"}}`),
		"too many blocks":        blocksJSON(many...),
		"duplicate ids":          blocksJSON(valid, valid),
		"bad id":                 blocksJSON(strings.Replace(valid, `"id":"main"`, `"id":"main block"`, 1)),
		"long id":                blocksJSON(strings.Replace(valid, `"id":"main"`, `"id":"`+strings.Repeat("a", 41)+`"`, 1)),
		"empty name":             blocksJSON(strings.Replace(valid, `"name":"Block main"`, `"name":"  "`, 1)),
		"long name":              blocksJSON(strings.Replace(valid, `"name":"Block main"`, `"name":"`+strings.Repeat("a", 61)+`"`, 1)),
		"multiline name":         blocksJSON(strings.Replace(valid, `"name":"Block main"`, `"name":"a\nb"`, 1)),
		"missing field":          blocksJSON(strings.Replace(valid, `"locked":false,`, "", 1)),
		"unknown field":          blocksJSON(strings.Replace(valid, `"locked":false,`, `"locked":false,"z":1,`, 1)),
		"too narrow":             blocksJSON(strings.Replace(valid, `"w":1920`, `"w":7`, 1)),
		"too far":                blocksJSON(strings.Replace(valid, `"x":0`, `"x":120001`, 1)),
		"fractional":             blocksJSON(strings.Replace(valid, `"x":0`, `"x":0.5`, 1)),
		"null style":             blocksJSON(strings.Replace(valid, `"style":`+testStyleJSON, `"style":null`, 1)),
		"style missing field":    blocksJSON(withStyle(empty, `"opacity":100`, `"opacity":100,"margin":1`)),
		"style null number":      blocksJSON(withStyle(empty, `"padding":0`, `"padding":null`)),
		"style without field":    blocksJSON(withStyle(empty, `"uppercase":false,`, "")),
		"uppercase colour":       blocksJSON(withStyle(empty, `"textColor":null`, `"textColor":"#FFFFFF"`)),
		"short colour":           blocksJSON(withStyle(empty, `"borderColor":null`, `"borderColor":"#fff"`)),
		"opacity too small":      blocksJSON(withStyle(empty, `"opacity":100`, `"opacity":9`)),
		"background opacity":     blocksJSON(withStyle(empty, `"backgroundOpacity":100`, `"backgroundOpacity":101`)),
		"text size too small":    blocksJSON(withStyle(empty, `"textSize":32`, `"textSize":7`)),
		"line height":            blocksJSON(withStyle(empty, `"lineHeight":125`, `"lineHeight":79`)),
		"letter spacing":         blocksJSON(withStyle(empty, `"letterSpacing":0`, `"letterSpacing":51`)),
		"border width":           blocksJSON(withStyle(empty, `"borderWidth":0`, `"borderWidth":41`)),
		"radius":                 blocksJSON(withStyle(empty, `"radius":0`, `"radius":401`)),
		"padding":                blocksJSON(withStyle(empty, `"padding":0`, `"padding":-1`)),
		"background dim":         blocksJSON(withStyle(empty, `"backgroundDim":0`, `"backgroundDim":91`)),
		"border style":           blocksJSON(withStyle(empty, `"borderStyle":"solid"`, `"borderStyle":"groove"`)),
		"shadow":                 blocksJSON(withStyle(empty, `"shadow":"none"`, `"shadow":"inset"`)),
		"font weight":            blocksJSON(withStyle(empty, `"fontWeight":"inherit"`, `"fontWeight":"800"`)),
		"font weight number":     blocksJSON(withStyle(empty, `"fontWeight":"inherit"`, `"fontWeight":400`)),
		"align inherit":          blocksJSON(withStyle(empty, `"align":"start"`, `"align":"inherit"`)),
		"vertical align":         blocksJSON(withStyle(empty, `"verticalAlign":"start"`, `"verticalAlign":"middle"`)),
		"font family":            blocksJSON(withStyle(empty, `"fontFamily":"inherit"`, `"fontFamily":"comic"`)),
		"custom without font":    blocksJSON(withStyle(empty, `"fontFamily":"inherit"`, `"fontFamily":"custom"`)),
		"font without custom":    blocksJSON(withStyle(empty, `"fontAssetId":null`, `"fontAssetId":"`+ids.New().String()+`"`)),
		"media background image": blocksJSON(withStyle(image, `"backgroundAssetId":null`, `"backgroundAssetId":"`+ids.New().String()+`"`)),
		"media background dim":   blocksJSON(withStyle(image, `"backgroundDim":0`, `"backgroundDim":20`)),
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, _, err := ParseBlocks(raw); err == nil {
				t.Fatal("invalid blocks accepted")
			} else if !apperror.IsCode(err, "validation_failed") {
				t.Fatalf("error = %v, want validation_failed", err)
			}
		})
	}
}

func TestParseBlocksKeepsOrderAndCollectsStyleReferences(t *testing.T) {
	font, background := ids.New(), ids.New()
	styled := strings.Replace(
		strings.Replace(blockJSON("top", `{"type":"clock","mode":"time"}`), `"fontFamily":"inherit","fontAssetId":null`,
			`"fontFamily":"custom","fontAssetId":"`+font.String()+`"`, 1),
		`"backgroundAssetId":null,"backgroundDim":0`, `"backgroundAssetId":"`+background.String()+`","backgroundDim":40`, 1)
	hidden := strings.Replace(blockJSON("hidden", `{"type":"empty"}`), `"hidden":false`, `"hidden":true`, 1)
	blocks, refs, err := ParseBlocks(blocksJSON(blockJSON("bottom", `{"type":"empty"}`), styled, hidden))
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 3 || blocks[0].ID != "bottom" || blocks[1].ID != "top" || !blocks[2].Hidden {
		t.Fatalf("blocks = %#v", blocks)
	}
	if len(refs.FontAssets) != 1 || refs.FontAssets[0] != font || len(refs.ImageAssets) != 1 || refs.ImageAssets[0] != background {
		t.Fatalf("refs = %#v", refs)
	}
	if empty, _, err := ParseBlocks(json.RawMessage(`[]`)); err != nil || len(empty) != 0 {
		t.Fatalf("empty scene = %#v, %v", empty, err)
	}
	if visible := visibleWidgets(blocks); len(visible) != 2 {
		t.Fatalf("visible widgets = %d", len(visible))
	}
}

func TestParseBlocksDropsStaleCameraFields(t *testing.T) {
	machine := ids.New()
	image := ids.New()
	block, refs, err := parseWidget(
		`{"type":"camera","source":"auto","machineId":"` + machine.String() + `","multi":"split","showProgress":true,"showRemaining":true,"fallback":"text","fallbackMediaId":"` + image.String() + `","showLive":true,"showName":true}`,
	)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(block.Widget), machine.String()) ||
		strings.Contains(string(block.Widget), image.String()) ||
		len(refs.Machines)+len(refs.ImageAssets) != 0 {
		t.Fatalf("stale references kept: %s %#v", block.Widget, refs)
	}
}

func TestValidateTemplateInput(t *testing.T) {
	valid := TemplateInput{
		Name: "Closed", Tone: "warning", Title: "Closed until {back_on}", Body: "{reason} - {ends}",
		Fields: []TemplateField{
			{Key: "back_on", Label: "Back on", Type: "datetime", Required: true},
			{
				Key:          "reason",
				Label:        "Reason",
				Type:         "choice",
				Options:      []string{"Holiday", "Repair"},
				DefaultValue: "Holiday",
			},
		},
	}
	if _, err := validateTemplateInput(valid); err != nil {
		t.Fatal(err)
	}
	mutate := func(change func(*TemplateInput)) TemplateInput {
		copy := valid
		copy.Fields = append([]TemplateField(nil), valid.Fields...)
		change(&copy)
		return copy
	}
	cases := map[string]TemplateInput{
		"unknown placeholder in title": mutate(func(i *TemplateInput) { i.Title = "Hello {who}" }),
		"unknown placeholder in body":  mutate(func(i *TemplateInput) { i.Body = "{nobody}" }),
		"bad tone":                     mutate(func(i *TemplateInput) { i.Tone = "loud" }),
		"empty title":                  mutate(func(i *TemplateInput) { i.Title = "" }),
		"builtin key":                  mutate(func(i *TemplateInput) { i.Fields[0].Key = "today" }),
		"duplicate key":                mutate(func(i *TemplateInput) { i.Fields[1].Key = "back_on" }),
		"bad key":                      mutate(func(i *TemplateInput) { i.Fields[0].Key = "Back-On" }),
		"unknown type":                 mutate(func(i *TemplateInput) { i.Fields[0].Type = "colour" }),
		"choice without options":       mutate(func(i *TemplateInput) { i.Fields[1].Options = nil }),
		"options on text":              mutate(func(i *TemplateInput) { i.Fields[0].Options = []string{"x"} }),
		"default not an option":        mutate(func(i *TemplateInput) { i.Fields[1].DefaultValue = "Party" }),
		"bad default time": mutate(func(i *TemplateInput) {
			i.Fields = append(i.Fields, TemplateField{Key: "t", Label: "T", Type: "time", DefaultValue: "25:00"})
		}),
		"too many fields": mutate(func(i *TemplateInput) {
			for index := 0; index < 21; index++ {
				i.Fields = append(
					i.Fields,
					TemplateField{Key: "f" + strings.Repeat("x", index+1), Label: "F", Type: "text"},
				)
			}
		}),
	}
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := validateTemplateInput(input); err == nil {
				t.Fatal("invalid template accepted")
			}
		})
	}
	_, err := validateTemplateInput(cases["unknown placeholder in title"])
	var appErr *apperror.Error
	if !apperror.IsCode(err, "unknown_placeholders") || !asApp(err, &appErr) || appErr.Details["placeholders"] == nil {
		t.Fatalf("unknown placeholder error = %v", err)
	}
}

func asApp(err error, target **apperror.Error) bool {
	return errors.As(err, target)
}

func TestValidateFieldValueByType(t *testing.T) {
	machine := ids.New().String()
	good := []struct {
		field TemplateField
		value string
	}{
		{TemplateField{Type: "text"}, "Room 4"},
		{TemplateField{Type: "longtext"}, "a\nb"},
		{TemplateField{Type: "time"}, "09:05"},
		{TemplateField{Type: "date"}, "2026-10-19"},
		{TemplateField{Type: "datetime"}, "2026-10-19T09:05"},
		{TemplateField{Type: "number"}, "-12,5"},
		{TemplateField{Type: "choice", Options: []string{"A", "B"}}, "B"},
		{TemplateField{Type: "machine"}, machine},
		{TemplateField{Type: "date"}, ""},
	}
	for _, item := range good {
		if err := ValidateFieldValue(item.field, item.value); err != nil {
			t.Errorf("%s %q rejected: %v", item.field.Type, item.value, err)
		}
	}
	bad := []struct {
		field TemplateField
		value string
	}{
		{TemplateField{Type: "text"}, "a\nb"},
		{TemplateField{Type: "text"}, strings.Repeat("a", 201)},
		{TemplateField{Type: "longtext"}, strings.Repeat("a", 2001)},
		{TemplateField{Type: "time"}, "24:00"},
		{TemplateField{Type: "time"}, "9:05"},
		{TemplateField{Type: "date"}, "2026-02-30"},
		{TemplateField{Type: "date"}, "19.10.2026"},
		{TemplateField{Type: "datetime"}, "2026-10-19 09:05"},
		{TemplateField{Type: "number"}, "12abc"},
		{TemplateField{Type: "choice", Options: []string{"A"}}, "C"},
		{TemplateField{Type: "machine"}, "h2d"},
	}
	for _, item := range bad {
		if err := ValidateFieldValue(item.field, item.value); err == nil {
			t.Errorf("%s %q accepted", item.field.Type, item.value)
		}
	}
}

func TestNormalizeValuesAppliesDefaultsAndRequired(t *testing.T) {
	fields := []TemplateField{
		{Key: "reason", Label: "Reason", Type: "text", Required: true},
		{Key: "room", Label: "Room", Type: "text", DefaultValue: "Main hall"},
		{Key: "note", Label: "Note", Type: "longtext"},
	}
	values, err := normalizeValues(fields, map[string]string{"reason": "Fire drill", "note": ""})
	if err != nil {
		t.Fatal(err)
	}
	if len(values) != 2 || values["room"] != "Main hall" || values["reason"] != "Fire drill" {
		t.Fatalf("values = %v", values)
	}
	if _, err := normalizeValues(fields, map[string]string{}); err == nil {
		t.Fatal("missing required value accepted")
	}
	if _, err := normalizeValues(fields, map[string]string{"reason": "x", "ghost": "y"}); err == nil {
		t.Fatal("unknown key accepted")
	}
}

func TestParseBlocksCameraMachineList(t *testing.T) {
	a, b := ids.New(), ids.New()
	camera := func(source, machineID, machineIDs string) string {
		return `{"type":"camera","source":"` + source + `","machineId":` + machineID + `,"multi":"split","showProgress":true,"showRemaining":true,"fallback":"text","fallbackMediaId":null,"showLive":true,"showName":true` + machineIDs + `}`
	}
	list := func(ids ...uuid.UUID) string {
		parts := make([]string, 0, len(ids))
		for _, id := range ids {
			parts = append(parts, `"`+id.String()+`"`)
		}
		return `,"machineIds":[` + strings.Join(parts, ",") + `]`
	}

	block, refs, err := parseWidget(camera("auto", "null", list(a, b)))
	if err != nil || len(refs.Machines) != 2 || !strings.Contains(string(block.Widget), a.String()) {
		t.Fatalf("auto with machines: %s %#v %v", block.Widget, refs, err)
	}
	// A widget without machineIds still validates and normalizes to an empty list.
	block, refs, err = parseWidget(camera("auto", "null", ""))
	if err != nil || len(refs.Machines) != 0 || !strings.Contains(string(block.Widget), `"machineIds":[]`) {
		t.Fatalf("auto without machineIds: %s %#v %v", block.Widget, refs, err)
	}
	// A fixed machine drops the list.
	block, refs, err = parseWidget(camera("machine", `"`+a.String()+`"`, list(b)))
	if err != nil || strings.Contains(string(block.Widget), b.String()) || len(refs.Machines) != 1 ||
		refs.Machines[0] != a {
		t.Fatalf("machine source: %s %#v %v", block.Widget, refs, err)
	}
	for name, raw := range map[string]string{
		"duplicates": camera("auto", "null", list(a, a)),
		"too many":   camera("auto", "null", list(manyIDs(21)...)),
		"not a uuid": camera("auto", "null", `,"machineIds":["x"]`),
	} {
		if _, _, err := parseWidget(raw); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
	if _, _, err := parseWidget(camera("auto", "null", list(manyIDs(20)...))); err != nil {
		t.Fatalf("20 machines rejected: %v", err)
	}
}

func manyIDs(n int) []uuid.UUID {
	ids := make([]uuid.UUID, 0, n)
	for len(ids) < n {
		ids = append(ids, uuid.Must(uuid.NewV7()))
	}
	return ids
}

// manifestWith is a manifest with one scene whose blocks show the widgets.
func manifestWith(widgets ...string) Manifest {
	blocks := make([]Block, 0, len(widgets))
	for index, widget := range widgets {
		blocks = append(blocks, Block{ID: fmt.Sprintf("b%d", index), Widget: json.RawMessage(widget)})
	}
	return Manifest{Scenes: []ManifestScene{{Blocks: blocks}}}
}

func TestManifestCameraMachineIDs(t *testing.T) {
	a, b := ids.New(), ids.New()
	auto := func(ids string) string {
		return `{"type":"camera","source":"auto","machineId":null,"machineIds":[` + ids + `]}`
	}
	fixed := `{"type":"camera","source":"machine","machineId":"` + b.String() + `","machineIds":[]}`
	ids, all := ManifestCameraMachineIDs(manifestWith(auto(`"`+a.String()+`"`), fixed))
	if all || len(ids) != 2 {
		t.Fatalf("restricted auto + fixed = %v all=%v", ids, all)
	}
	if ids, all = ManifestCameraMachineIDs(manifestWith(auto(""))); !all || len(ids) != 0 {
		t.Fatalf("unrestricted auto = %v all=%v", ids, all)
	}
	if ids, all = ManifestCameraMachineIDs(manifestWith(`{"type":"status","machineIds":["` + a.String() + `"]}`)); all ||
		len(ids) != 0 {
		t.Fatalf("status widget gives cameras: %v %v", ids, all)
	}
	// Displays never show hidden blocks, so their cameras and machines are not published.
	hidden := manifestWith(fixed, `{"type":"status","machineIds":["`+a.String()+`"]}`)
	hidden.Scenes[0].Blocks[0].Hidden, hidden.Scenes[0].Blocks[1].Hidden = true, true
	if ids, all = ManifestCameraMachineIDs(hidden); all || len(ids) != 0 || len(ManifestMachineIDs(hidden)) != 0 {
		t.Fatalf("hidden blocks give cameras %v or machines %v", ids, ManifestMachineIDs(hidden))
	}
}
