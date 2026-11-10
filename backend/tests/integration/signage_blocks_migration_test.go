package integration_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/signage"
	"github.com/google/uuid"
)

// legacyWidgetFixtures are widgets as stored before migration 00130: every widget type without a zone style and
// with one (announcements in boxStyle), including partial and odd styles.
func legacyWidgetFixtures() []string {
	machine, image, video, template, font := ids.New(), ids.New(), ids.New(), ids.New(), ids.New()
	full := func(align, vertical string, scale int) string {
		return fmt.Sprintf(`{"textColor":"#ffffff","backgroundColor":"#102030","borderColor":"#ff0000",`+
			`"backgroundOpacity":65,"padding":3,"radius":2,"borderWidth":7,"fontScale":%d,"fontFamily":"custom",`+
			`"fontAssetId":"%s","align":%q,"verticalAlign":%q}`, scale, font, align, vertical)
	}
	plain := func(align, vertical string, scale int) string {
		return fmt.Sprintf(`{"textColor":null,"backgroundColor":null,"borderColor":null,"backgroundOpacity":100,`+
			`"padding":0,"radius":0,"borderWidth":0,"fontScale":%d,"fontFamily":"mono","fontAssetId":null,`+
			`"align":%q,"verticalAlign":%q}`, scale, align, vertical)
	}
	camera := `"type":"camera","source":"machine","machineId":"` + machine.String() + `","multi":"split","showProgress":true,` +
		`"showRemaining":false,"fallback":"image","fallbackMediaId":"` + image.String() + `"`
	calendar := `"type":"calendar","view":"weeks","weeks":2,"showHolidays":true,"showBreaks":false,"showOpenDays":true,` +
		`"showEvents":true,"colors":{"holiday":"#111111","break":"#222222","openDay":"#333333","event":"#444444"},"showWeekNumbers":true`
	announcement := `"type":"announcement","templateIds":["` + template.String() + `"],"whenNone":"text","fallbackText":"Quiet",` +
		`"whenMany":"rotate","rotateSeconds":10`
	timelapse := `"type":"timelapse","source":"machines","machineIds":["` + machine.String() + `"],"count":3,"maxAgeDays":30,` +
		`"maxSeconds":60,"transition":"fade","showCaption":true,"fit":"cover"`
	return []string{
		`{"type":"empty"}`,
		`{"type":"empty","style":` + full("center", "center", 100) + `}`,
		`{"type":"image","mediaId":"` + image.String() + `","fit":"cover"}`,
		`{"type":"image","mediaId":null,"fit":"contain","style":` + plain("end", "end", 400) + `}`,
		`{"type":"video","mediaId":"` + video.String() + `","fit":"contain"}`,
		`{"type":"video","mediaId":null,"fit":"cover","style":` + full("inherit", "inherit", 25) + `}`,
		`{"type":"slideshow","mediaIds":["` + image.String() + `"],"seconds":8}`,
		`{"type":"slideshow","mediaIds":[],"seconds":5,"style":` + plain("inherit", "start", 150) + `}`,
		`{"type":"text","text":"Hello","size":"s","align":"center"}`,
		`{"type":"text","text":"# Hi","size":"xl","align":"end","format":"markdown","css":"h1{}","style":` +
			full("inherit", "inherit", 400) + `}`,
		`{"type":"text","text":"<b>x</b>","size":"m","align":"start","format":"html","style":` + plain("center", "end", 75) + `}`,
		`{"type":"text","text":"plain","size":"l","align":"start","format":"plain"}`,
		`{"type":"qr","url":"https://makerspace.example/join","caption":"Join"}`,
		`{"type":"qr","url":"https://makerspace.example","caption":"","style":` + full("start", "start", 120) + `}`,
		`{"type":"clock","mode":"time"}`,
		`{"type":"clock","mode":"date","style":` + plain("end", "inherit", 200) + `}`,
		`{` + camera + `}`,
		`{` + camera + `,"style":` + full("end", "end", 100) + `}`,
		`{"type":"camera","source":"auto","machineId":null,"multi":"alternate","showProgress":false,"showRemaining":true,` +
			`"fallback":"hide","fallbackMediaId":null,"machineIds":["` + machine.String() + `"]}`,
		`{"type":"status","machineIds":["` + machine.String() + `"],"showProgress":true,"showRemaining":true}`,
		`{"type":"status","machineIds":[],"showProgress":false,"showRemaining":false,"style":` + plain("inherit", "inherit", 90) + `}`,
		`{"type":"open_days","count":3}`,
		`{"type":"open_days","count":5,"title":"Open","showCompetencies":true,"style":` + full("center", "inherit", 110) + `}`,
		`{"type":"events","count":4,"emptyText":"None","entryTemplate":"{title}","format":"markdown"}`,
		`{"type":"events","count":2,"style":` + plain("end", "center", 100) + `}`,
		`{"type":"agenda","count":6,"includeOpenDays":true,"includeEvents":false}`,
		`{"type":"agenda","count":6,"includeOpenDays":true,"includeEvents":true,"style":` + full("inherit", "end", 80) + `}`,
		`{` + calendar + `}`,
		`{` + calendar + `,"title":"Weeks","style":` + plain("start", "inherit", 130) + `}`,
		`{` + timelapse + `}`,
		`{` + timelapse + `,"style":` + plain("center", "center", 100) + `}`,
		`{` + announcement + `,"style":"card","size":"m"}`,
		`{` + announcement + `,"style":"full","size":"xl","boxStyle":` + full("start", "inherit", 300) + `}`,
		`{` + announcement + `,"style":"banner","size":"s","boxStyle":` + plain("end", "start", 100) + `}`,
	}
}

func migrationFile(t *testing.T, prefix string) (before []string, file string) {
	t.Helper()
	all, err := filepath.Glob(filepath.Join(filepath.Dir(orderedMigrationFiles(t)[0]), "*.sql"))
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range all {
		switch name := filepath.Base(path); {
		case name < prefix:
			before = append(before, path)
		case strings.HasPrefix(name, prefix):
			file = path
		}
	}
	if file == "" {
		t.Fatalf("migration %s not found", prefix)
	}
	return before, file
}

// Migration 00130 converts every scene into blocks with exactly the rules that convert older publications in Go
// (signage.ConvertLegacyScene): all built-in layouts, custom grid and free layouts, every widget type with and
// without a style, on landscape, portrait, square and odd aspect ratios. The result validates as blocks, scene
// versions are kept, and the lossy Down migration leaves a valid older schema.
func TestSignageBlocksMigrationMatchesGoConversion(t *testing.T) {
	pool := emptySchemaPool(t)
	ctx := testContext(t)
	before, migration := migrationFile(t, "00130_")
	applyMigrationFiles(t, pool, before)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}

	customGrid := ids.New()
	exec(`INSERT INTO signage_custom_layouts (id, name, mode, columns, rows, zones) VALUES ($1, 'Grid', 'grid', '{1,3,2}', '{5,1}', $2)`,
		customGrid, `[{"id":"top","label":"Top","grid":{"col":1,"row":1,"colSpan":3,"rowSpan":1},"rect":null},
		  {"id":"a","label":"  Spaced label  ","grid":{"col":1,"row":2,"colSpan":1,"rowSpan":1},"rect":null},
		  {"id":"b","label":"B","grid":{"col":2,"row":2,"colSpan":2,"rowSpan":1},"rect":null}]`)
	customFree := ids.New()
	exec(`INSERT INTO signage_custom_layouts (id, name, mode, columns, rows, zones) VALUES ($1, 'Free', 'free', '{1}', '{1}', $2)`,
		customFree, `[{"id":"back","label":"Back","grid":null,"rect":{"x":0,"y":0,"width":100,"height":100}},
		  {"id":"card","label":"Card","grid":null,"rect":{"x":12.5,"y":33.33,"width":40.07,"height":10.01}},
		  {"id":"tiny","label":"Tiny","grid":null,"rect":{"x":99,"y":0.01,"width":1,"height":1}}]`)

	widgets := legacyWidgetFixtures()
	next := 0
	zonesFor := func(zoneIDs []string) string {
		zones := map[string]json.RawMessage{}
		// The last zone stays missing: it renders empty.
		for _, id := range zoneIDs[:max(len(zoneIDs)-1, 1)] {
			zones[id] = json.RawMessage(widgets[next%len(widgets)])
			next++
		}
		encoded, err := json.Marshal(zones)
		if err != nil {
			t.Fatal(err)
		}
		return string(encoded)
	}
	builtins := map[string][]string{
		"full": {"main"}, "stack3": {"header", "main", "footer"}, "stack4": {"header", "main", "info", "footer"},
		"split": {"left", "right"}, "grid2x2": {"tl", "tr", "bl", "br"}, "quad_banner": {"tl", "tr", "bl", "br", "banner"},
		"main_side": {"main", "side_top", "side_bottom"}, "main_footer": {"main", "footer"}, "banner_main": {"banner", "main"},
	}
	ratios := [][2]int{{16, 9}, {9, 16}, {21, 9}, {7, 3}, {1, 1}, {3, 4}}
	insert := func(width, height int, layout string, custom *uuid.UUID, zones string) {
		exec(`INSERT INTO signage_scenes (id, name, aspect_width, aspect_height, layout_id, custom_layout_id, background_color, theme, zones, version)
			VALUES ($1, $2, $3, $4, $5, $6, '#101820', 'dark', $7, 3)`,
			ids.New(), fmt.Sprintf("%s %d:%d", layout, width, height), width, height, layout, custom, zones)
	}
	for round := 0; round < 2; round++ {
		for _, ratio := range ratios {
			for layout, zoneIDs := range builtins {
				insert(ratio[0], ratio[1], layout, nil, zonesFor(zoneIDs))
			}
			insert(ratio[0], ratio[1], "custom", &customGrid, zonesFor([]string{"top", "a", "b"}))
			insert(ratio[0], ratio[1], "custom", &customFree, zonesFor([]string{"back", "card", "tiny"}))
		}
	}
	// Zones outside the layout are ignored; an odd widget value renders empty.
	insert(16, 9, "split", nil, `{"left":"oops","right":null,"ghost":{"type":"clock","mode":"time"}}`)
	// A 100:1 screen is 108000 units wide: geometry must not be clamped to the old 8000 limit.
	wide := ids.New()
	exec(`INSERT INTO signage_scenes (id, name, aspect_width, aspect_height, layout_id, background_color, theme, zones, version)
		VALUES ($1, 'wide', 100, 1, 'split', '#101820', 'dark', $2, 3)`,
		wide, `{"left":{"type":"clock","mode":"time"},"right":{"type":"clock","mode":"time"}}`)
	if next < len(widgets) {
		t.Fatalf("only %d of %d widget fixtures used", next, len(widgets))
	}

	type legacyRow struct {
		id             uuid.UUID
		ratio          signage.AspectRatio
		layout         string
		customLayoutID *uuid.UUID
		zones          map[string]json.RawMessage
	}
	rows, err := pool.Query(ctx, `SELECT id, aspect_width, aspect_height, layout_id, custom_layout_id, zones FROM signage_scenes`)
	if err != nil {
		t.Fatal(err)
	}
	var scenes []legacyRow
	for rows.Next() {
		var row legacyRow
		var width, height int16
		var zones []byte
		if err := rows.Scan(&row.id, &width, &height, &row.layout, &row.customLayoutID, &zones); err != nil {
			t.Fatal(err)
		}
		row.ratio = signage.AspectRatio{Width: int(width), Height: int(height)}
		if err := json.Unmarshal(zones, &row.zones); err != nil {
			t.Fatal(err)
		}
		scenes = append(scenes, row)
	}
	rows.Close()
	layouts := map[uuid.UUID]signage.LegacyCustomLayout{}
	layoutRows, err := pool.Query(ctx, `SELECT id, mode, columns, rows, zones FROM signage_custom_layouts`)
	if err != nil {
		t.Fatal(err)
	}
	for layoutRows.Next() {
		var layout signage.LegacyCustomLayout
		var columns, trackRows []int32
		var zones []byte
		if err := layoutRows.Scan(&layout.ID, &layout.Mode, &columns, &trackRows, &zones); err != nil {
			t.Fatal(err)
		}
		for _, value := range columns {
			layout.Columns = append(layout.Columns, int(value))
		}
		for _, value := range trackRows {
			layout.Rows = append(layout.Rows, int(value))
		}
		if err := json.Unmarshal(zones, &layout.Zones); err != nil {
			t.Fatal(err)
		}
		layouts[layout.ID] = layout
	}
	layoutRows.Close()
	want := map[uuid.UUID][]byte{}
	for _, scene := range scenes {
		var custom *signage.LegacyCustomLayout
		if scene.customLayoutID != nil {
			layout := layouts[*scene.customLayoutID]
			custom = &layout
		}
		blocks, err := signage.ConvertLegacyScene(scene.ratio, scene.layout, custom, scene.zones)
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(blocks)
		if err != nil {
			t.Fatal(err)
		}
		want[scene.id] = encoded
	}

	applyMigrationFiles(t, pool, []string{migration})

	for id, expected := range want {
		var equal bool
		var stored []byte
		var version int64
		if err := pool.QueryRow(ctx, `SELECT blocks = $2::jsonb, blocks, version FROM signage_scenes WHERE id = $1`, id, string(expected)).
			Scan(&equal, &stored, &version); err != nil {
			t.Fatal(err)
		}
		if !equal {
			t.Fatalf("scene %s: SQL conversion differs from Go\nsql: %s\ngo:  %s", id, stored, expected)
		}
		if version != 3 {
			t.Fatalf("scene %s: version %d, want it kept", id, version)
		}
		if _, _, err := signage.ParseBlocks(stored); err != nil {
			t.Fatalf("scene %s: converted blocks do not validate: %v\n%s", id, err, stored)
		}
	}
	var wideRightX, wideRightW int
	if err := pool.QueryRow(ctx, `SELECT (b ->> 'x')::int, (b ->> 'w')::int FROM signage_scenes, jsonb_array_elements(blocks) b
		WHERE id = $1 AND b ->> 'id' = 'right'`, wide).Scan(&wideRightX, &wideRightW); err != nil {
		t.Fatal(err)
	}
	if wideRightX != 54000 || wideRightW <= 8000 {
		t.Fatalf("100:1 split right block at x=%d w=%d, want x=54000 and a width beyond the old limit", wideRightX, wideRightW)
	}
	var leftovers int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_proc WHERE proname LIKE 'signage_00130_%'`).Scan(&leftovers); err != nil ||
		leftovers != 0 {
		t.Fatalf("helper functions left behind: %d, %v", leftovers, err)
	}

	// Down is lossy but leaves the older schema with valid full-screen scenes.
	content, err := os.ReadFile(migration)
	if err != nil {
		t.Fatal(err)
	}
	_, down, _ := strings.Cut(string(content), "-- +goose Down")
	exec(down)
	var invalid int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM signage_scenes WHERE layout_id <> 'full' OR custom_layout_id IS NOT NULL
		OR NOT zones ? 'main' OR version <> 4`).Scan(&invalid); err != nil || invalid != 0 {
		t.Fatalf("%d scenes not rolled back to the full layout (%v)", invalid, err)
	}
	var sizeless, shown int
	if err := pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE zones -> 'main' ->> 'type' IN ('text', 'announcement')
		AND NOT zones -> 'main' ? 'size'), count(*) FILTER (WHERE zones -> 'main' ->> 'type' <> 'empty') FROM signage_scenes`).
		Scan(&sizeless, &shown); err != nil || sizeless != 0 || shown == 0 {
		t.Fatalf("rolled back widgets: %d without size, %d not empty (%v)", sizeless, shown, err)
	}
	applyMigrationFiles(t, pool, []string{migration})
}
