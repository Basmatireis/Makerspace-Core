package signage

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

func zonesFrom(t *testing.T, raw string) map[string]json.RawMessage {
	t.Helper()
	var zones map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &zones); err != nil {
		t.Fatal(err)
	}
	return zones
}

func mustLayout(t *testing.T, id string) Layout {
	t.Helper()
	layout, ok := LayoutByID(id)
	if !ok {
		t.Fatalf("layout %q missing", id)
	}
	return layout
}

func TestParseZonesAcceptsEveryWidgetType(t *testing.T) {
	image, video, machine, template := uuid.Must(
		uuid.NewV7(),
	), uuid.Must(
		uuid.NewV7(),
	), uuid.Must(
		uuid.NewV7(),
	), uuid.Must(
		uuid.NewV7(),
	)
	widgets := map[string]string{
		"empty":        `{"type":"empty"}`,
		"image":        `{"type":"image","mediaId":"` + image.String() + `","fit":"cover"}`,
		"image unset":  `{"type":"image","mediaId":null,"fit":"contain"}`,
		"video":        `{"type":"video","mediaId":"` + video.String() + `","fit":"contain"}`,
		"slideshow":    `{"type":"slideshow","mediaIds":["` + image.String() + `"],"seconds":8}`,
		"text":         `{"type":"text","text":"Hello\nworld <b>plain</b>","size":"m","align":"start"}`,
		"qr":           `{"type":"qr","url":"https://makerspace.example/join","caption":"Scan"}`,
		"clock":        `{"type":"clock","mode":"datetime"}`,
		"camera auto":  `{"type":"camera","source":"auto","machineId":null,"multi":"split","showProgress":true,"showRemaining":false,"fallback":"text","fallbackMediaId":null}`,
		"camera fixed": `{"type":"camera","source":"machine","machineId":"` + machine.String() + `","multi":"alternate","showProgress":true,"showRemaining":true,"fallback":"image","fallbackMediaId":"` + image.String() + `"}`,
		"status":       `{"type":"status","machineIds":["` + machine.String() + `"],"showProgress":true,"showRemaining":true}`,
		"open_days":    `{"type":"open_days","count":3}`,
		"events":       `{"type":"events","count":10}`,
		"announcement": `{"type":"announcement","templateIds":["` + template.String() + `"],"style":"banner","size":"l","whenNone":"text","fallbackText":"All quiet","whenMany":"rotate","rotateSeconds":10}`,
	}
	for name, widget := range widgets {
		t.Run(name, func(t *testing.T) {
			zones, refs, err := ParseZones(mustLayout(t, "split"), zonesFrom(t, `{"left":`+widget+`}`))
			if err != nil {
				t.Fatal(err)
			}
			if string(zones["right"]) != string(emptyWidget) {
				t.Fatalf("missing zone not emptied: %s", zones["right"])
			}
			var decoded map[string]any
			if err := json.Unmarshal(zones["left"], &decoded); err != nil || decoded["type"] == nil {
				t.Fatalf("canonical widget is not an object: %s (%v)", zones["left"], err)
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

func TestParseZonesRejectsInvalidInput(t *testing.T) {
	id := uuid.Must(uuid.NewV7()).String()
	cases := map[string]string{
		"unknown zone":          `{"nowhere":{"type":"empty"}}`,
		"unknown field":         `{"left":{"type":"empty","extra":1}}`,
		"unknown field on text": `{"left":{"type":"text","text":"x","size":"m","align":"start","html":"<b>"}}`,
		"unknown type":          `{"left":{"type":"iframe"}}`,
		"missing type":          `{"left":{"text":"x"}}`,
		"not an object":         `{"left":"text"}`,
		"null widget":           `{"left":null}`,
		"bad fit":               `{"left":{"type":"image","mediaId":null,"fit":"stretch"}}`,
		"bad uuid":              `{"left":{"type":"image","mediaId":"nope","fit":"cover"}}`,
		"http qr":               `{"left":{"type":"qr","url":"http://makerspace.example","caption":""}}`,
		"javascript qr":         `{"left":{"type":"qr","url":"javascript:alert(1)","caption":""}}`,
		"credentials qr":        `{"left":{"type":"qr","url":"https://user:pw@makerspace.example","caption":""}}`,
		"empty qr":              `{"left":{"type":"qr","url":"","caption":""}}`,
		"multiline caption":     `{"left":{"type":"qr","url":"https://x.example","caption":"a\nb"}}`,
		"long text": `{"left":{"type":"text","text":"` + strings.Repeat(
			"a",
			1001,
		) + `","size":"m","align":"start"}}`,
		"control character":  `{"left":{"type":"text","text":"a\u0000b","size":"m","align":"start"}}`,
		"bad size":           `{"left":{"type":"text","text":"x","size":"xxl","align":"start"}}`,
		"slideshow too fast": `{"left":{"type":"slideshow","mediaIds":[],"seconds":1}}`,
		"slideshow too long": `{"left":{"type":"slideshow","mediaIds":[],"seconds":3601}}`,
		"slideshow too many": `{"left":{"type":"slideshow","mediaIds":[` + strings.TrimSuffix(
			strings.Repeat(`"`+id+`",`, 51),
			",",
		) + `],"seconds":8}}`,
		"camera needs machine": `{"left":{"type":"camera","source":"machine","machineId":null,"multi":"split","showProgress":true,"showRemaining":true,"fallback":"text","fallbackMediaId":null}}`,
		"clock mode":           `{"left":{"type":"clock","mode":"seconds"}}`,
		"count zero":           `{"left":{"type":"open_days","count":0}}`,
		"count eleven":         `{"left":{"type":"events","count":11}}`,
		"rotate too fast":      `{"left":{"type":"announcement","templateIds":[],"style":"card","size":"m","whenNone":"empty","fallbackText":"","whenMany":"rotate","rotateSeconds":1}}`,
		"announcement style":   `{"left":{"type":"announcement","templateIds":[],"style":"popup","size":"m","whenNone":"empty","fallbackText":"","whenMany":"rotate","rotateSeconds":10}}`,
		"trailing data":        `{"left":{"type":"empty"} }`,
		"status too many": `{"left":{"type":"status","machineIds":[` + strings.TrimSuffix(
			strings.Repeat(`"`+id+`",`, 21),
			",",
		) + `],"showProgress":true,"showRemaining":true}}`,
		"fallback text too long": `{"left":{"type":"announcement","templateIds":[],"style":"card","size":"m","whenNone":"text","fallbackText":"` + strings.Repeat(
			"a",
			501,
		) + `","whenMany":"rotate","rotateSeconds":10}}`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if name == "trailing data" {
				// A zone map entry is decoded by encoding/json; trailing data is exercised on the widget itself.
				if _, _, err := ValidateWidget(
					"left",
					json.RawMessage(`{"type":"empty"} {"type":"empty"}`),
				); err == nil {
					t.Fatal("trailing data accepted")
				}
				return
			}
			_, _, err := ParseZones(mustLayout(t, "split"), zonesFrom(t, raw))
			if err == nil {
				t.Fatal("invalid zones accepted")
			}
			if !apperror.IsCode(err, "validation_failed") {
				t.Fatalf("error = %v, want validation_failed", err)
			}
		})
	}
}

func TestParseZonesDropsStaleCameraFields(t *testing.T) {
	machine := uuid.Must(uuid.NewV7())
	image := uuid.Must(uuid.NewV7())
	zones, refs, err := ParseZones(
		mustLayout(t, "full"),
		zonesFrom(
			t,
			`{"main":{"type":"camera","source":"auto","machineId":"`+machine.String()+`","multi":"split","showProgress":true,"showRemaining":true,"fallback":"text","fallbackMediaId":"`+image.String()+`"}}`,
		),
	)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(zones["main"]), machine.String()) ||
		strings.Contains(string(zones["main"]), image.String()) ||
		len(refs.Machines)+len(refs.ImageAssets) != 0 {
		t.Fatalf("stale references kept: %s %#v", zones["main"], refs)
	}
}

func TestLayoutsMatchOpenAPIEnumAndRemapByPosition(t *testing.T) {
	spec, err := openapi.GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	schema := spec.Components.Schemas["SignageLayoutId"]
	if schema == nil || schema.Value == nil {
		t.Fatal("SignageLayoutId schema missing")
	}
	var enum []string
	for _, value := range schema.Value.Enum {
		enum = append(enum, value.(string))
	}
	var codeIDs []string
	for _, layout := range Layouts() {
		codeIDs = append(codeIDs, layout.ID)
		if len(layout.Zones) == 0 {
			t.Fatalf("layout %s has no zones", layout.ID)
		}
	}
	if strings.Join(enum, ",") != strings.Join(codeIDs, ",") {
		t.Fatalf("OpenAPI layouts %v differ from code %v", enum, codeIDs)
	}
	for _, id := range []string{"main_footer", "quad_banner"} {
		if _, ok := LayoutByID(id); !ok {
			t.Fatalf("layout %s missing", id)
		}
	}
	quad := mustLayout(t, "quad_banner")
	if len(quad.Zones) != 5 || quad.Zones[4].ID != "banner" || quad.Zones[4].ColSpan != 2 {
		t.Fatalf("quad_banner = %#v", quad)
	}

	text := RawWidget(`{"type":"clock","mode":"time"}`)
	other := RawWidget(`{"type":"open_days","count":3}`)
	moved := remapZones(
		mustLayout(t, "split"),
		map[string]RawWidget{"left": text, "right": other},
		mustLayout(t, "stack3"),
	)
	if string(moved["header"]) != string(text) || string(moved["main"]) != string(other) ||
		string(moved["footer"]) != string(emptyWidget) {
		t.Fatalf("remap = %v", moved)
	}
	shrunk := remapZones(mustLayout(t, "stack3"), moved, mustLayout(t, "full"))
	if len(shrunk) != 1 || string(shrunk["main"]) != string(text) {
		t.Fatalf("shrunk = %v", shrunk)
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
	if typed, ok := err.(*apperror.Error); ok {
		*target = typed
		return true
	}
	return false
}

func TestValidateFieldValueByType(t *testing.T) {
	machine := uuid.Must(uuid.NewV7()).String()
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

func TestParseZonesCameraMachineList(t *testing.T) {
	a, b := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	camera := func(source, machineID, machineIDs string) string {
		return `{"main":{"type":"camera","source":"` + source + `","machineId":` + machineID + `,"multi":"split","showProgress":true,"showRemaining":true,"fallback":"text","fallbackMediaId":null` + machineIDs + `}}`
	}
	list := func(ids ...uuid.UUID) string {
		parts := make([]string, 0, len(ids))
		for _, id := range ids {
			parts = append(parts, `"`+id.String()+`"`)
		}
		return `,"machineIds":[` + strings.Join(parts, ",") + `]`
	}

	zones, refs, err := ParseZones(mustLayout(t, "full"), zonesFrom(t, camera("auto", "null", list(a, b))))
	if err != nil || len(refs.Machines) != 2 || !strings.Contains(string(zones["main"]), a.String()) {
		t.Fatalf("auto with machines: %s %#v %v", zones["main"], refs, err)
	}
	// A scene saved before machineIds existed still validates and normalizes to an empty list.
	zones, refs, err = ParseZones(mustLayout(t, "full"), zonesFrom(t, camera("auto", "null", "")))
	if err != nil || len(refs.Machines) != 0 || !strings.Contains(string(zones["main"]), `"machineIds":[]`) {
		t.Fatalf("auto without machineIds: %s %#v %v", zones["main"], refs, err)
	}
	// A fixed machine drops the list.
	zones, refs, err = ParseZones(mustLayout(t, "full"), zonesFrom(t, camera("machine", `"`+a.String()+`"`, list(b))))
	if err != nil || strings.Contains(string(zones["main"]), b.String()) || len(refs.Machines) != 1 ||
		refs.Machines[0] != a {
		t.Fatalf("machine source: %s %#v %v", zones["main"], refs, err)
	}
	for name, raw := range map[string]string{
		"duplicates": camera("auto", "null", list(a, a)),
		"too many":   camera("auto", "null", list(manyIDs(21)...)),
		"not a uuid": camera("auto", "null", `,"machineIds":["x"]`),
	} {
		if _, _, err := ParseZones(mustLayout(t, "full"), zonesFrom(t, raw)); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
	if _, _, err := ParseZones(
		mustLayout(t, "full"),
		zonesFrom(t, camera("auto", "null", list(manyIDs(20)...))),
	); err != nil {
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

func TestManifestCameraMachineIDs(t *testing.T) {
	a, b := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	manifestWith := func(widgets ...string) Manifest {
		zones := map[string]json.RawMessage{}
		for index, widget := range widgets {
			zones[string(rune('a'+index))] = json.RawMessage(widget)
		}
		return Manifest{Scenes: []ManifestScene{{Zones: zones}}}
	}
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
	if !camerasRemoved(cameraSet{all: true}, cameraSet{ids: []uuid.UUID{a}}) ||
		camerasRemoved(cameraSet{ids: []uuid.UUID{a}}, cameraSet{all: true}) ||
		camerasRemoved(cameraSet{ids: []uuid.UUID{a}}, cameraSet{ids: []uuid.UUID{a, b}}) ||
		!camerasRemoved(cameraSet{ids: []uuid.UUID{a, b}}, cameraSet{ids: []uuid.UUID{a}}) {
		t.Fatal("camerasRemoved semantics wrong")
	}
}
