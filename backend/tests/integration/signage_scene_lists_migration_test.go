package integration_test

import (
	"path/filepath"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

// Migration 00091 turns rule targets and default playlists into scene lists, drops rules whose playlist was
// empty, gives displays with an empty default playlist a Blank scene per aspect ratio, and can be rolled back.
func TestSignageSceneListsMigrationCopiesTargetsAndDefaults(t *testing.T) {
	pool := emptySchemaPool(t)
	ctx := testContext(t)
	all, err := filepath.Glob(filepath.Join(filepath.Dir(orderedMigrationFiles(t)[0]), "*.sql"))
	if err != nil {
		t.Fatal(err)
	}
	var before []string
	var migration string
	for _, path := range all {
		switch name := filepath.Base(path); {
		case name < "00091_":
			before = append(before, path)
		case name == "00091_signage_scene_lists.sql":
			migration = path
		}
	}
	if migration == "" {
		t.Fatal("migration 00091 not found")
	}
	applyMigrationFiles(t, pool, before)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}
	count := func(query string, args ...any) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, query, args...).Scan(&n); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
		return n
	}

	scene := func(name string, width, height int) uuid.UUID {
		id := ids.New()
		exec(`INSERT INTO signage_scenes (id, name, aspect_width, aspect_height, layout_id, background_color, theme, zones)
			VALUES ($1, $2, $3, $4, 'full', '#101820', 'dark', '{"main": {"type": "empty"}}')`, id, name, width, height)
		return id
	}
	wideOne, wideTwo := scene("Wide one", 16, 9), scene("Wide two", 16, 9)
	playlist := func(name string, items ...uuid.UUID) uuid.UUID {
		id := ids.New()
		exec(`INSERT INTO signage_playlists (id, name) VALUES ($1, $2)`, id, name)
		for position, sceneID := range items {
			transition := "cut"
			if position == 1 {
				transition = "fade"
			}
			exec(`INSERT INTO signage_playlist_items (playlist_id, position, scene_id, seconds, transition) VALUES ($1, $2, $3, $4, $5)`,
				id, position, sceneID, 10+position*5, transition)
		}
		return id
	}
	both := playlist("Both", wideOne, wideTwo)
	empty := playlist("Empty")
	single := playlist("Single", wideOne)
	display := func(name string, width, height int, defaultPlaylist uuid.UUID) uuid.UUID {
		typeID, deviceID, displayID := ids.New(), ids.New(), ids.New()
		exec(`INSERT INTO device_types (id, name) VALUES ($1, $2)`, typeID, name+" type")
		exec(`INSERT INTO managed_devices (id, name, device_type_id, token_digest)
			VALUES ($1, $2, $3, decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'))`,
			deviceID, name, typeID)
		exec(`INSERT INTO signage_displays (id, managed_device_id, name, aspect_width, aspect_height, default_playlist_id)
			VALUES ($1, $2, $3, $4, $5, $6)`, displayID, deviceID, name, width, height, defaultPlaylist)
		return displayID
	}
	entrance := display("Entrance", 16, 9, single)
	portraitA := display("Portrait A", 9, 16, empty)
	portraitB := display("Portrait B", 9, 16, empty)
	ultraWide := display("Ultra wide", 21, 9, empty)
	rule := func(position int, kind string, target uuid.UUID) uuid.UUID {
		id := ids.New()
		column := "target_scene_id"
		if kind == "playlist" {
			column = "target_playlist_id"
		}
		exec(`INSERT INTO signage_rules (id, display_id, position, condition_kind, target_kind, `+column+`)
			VALUES ($1, $2, $3, 'live_data_unavailable', $4, $5)`, id, entrance, position, kind, target)
		return id
	}
	sceneRule := rule(0, "scene", wideTwo)
	emptyRule := rule(1, "playlist", empty)
	playlistRule := rule(2, "playlist", both)

	applyMigrationFiles(t, pool, []string{migration})

	type item struct {
		position, seconds int
		scene             uuid.UUID
		transition        string
	}
	items := func(query string, owner uuid.UUID) []item {
		t.Helper()
		rows, err := pool.Query(ctx, query, owner)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var result []item
		for rows.Next() {
			var value item
			if err := rows.Scan(&value.position, &value.scene, &value.seconds, &value.transition); err != nil {
				t.Fatal(err)
			}
			result = append(result, value)
		}
		return result
	}
	ruleItems := func(id uuid.UUID) []item {
		return items(`SELECT position, scene_id, seconds, transition FROM signage_rule_scenes WHERE rule_id = $1 ORDER BY position`, id)
	}
	defaultItems := func(id uuid.UUID) []item {
		return items(`SELECT position, scene_id, seconds, transition FROM signage_default_scenes WHERE display_id = $1 ORDER BY position`, id)
	}

	// A scene target becomes a one-item list of ten seconds with a cut.
	if got := ruleItems(sceneRule); len(got) != 1 || got[0] != (item{0, 10, wideTwo, "cut"}) {
		t.Fatalf("scene rule items = %#v", got)
	}
	// A playlist target takes the playlist's items in order.
	if got := ruleItems(playlistRule); len(got) != 2 || got[0] != (item{0, 10, wideOne, "cut"}) ||
		got[1] != (item{1, 15, wideTwo, "fade"}) {
		t.Fatalf("playlist rule items = %#v", got)
	}
	// The rule with the empty playlist is gone and the later rule closed the gap.
	if n := count(`SELECT count(*) FROM signage_rules WHERE id = $1`, emptyRule); n != 0 {
		t.Fatal("the rule with an empty playlist survived")
	}
	var position int
	if err := pool.QueryRow(ctx, `SELECT position FROM signage_rules WHERE id = $1`, playlistRule).Scan(&position); err != nil ||
		position != 1 {
		t.Fatalf("playlist rule position = %d, %v", position, err)
	}
	// Default playlists become default lists.
	if got := defaultItems(entrance); len(got) != 1 || got[0] != (item{0, 10, wideOne, "cut"}) {
		t.Fatalf("entrance default = %#v", got)
	}
	// Empty default playlists become a Blank scene, one per aspect ratio.
	if n := count(`SELECT count(*) FROM signage_scenes WHERE name = 'Blank'`); n != 2 {
		t.Fatalf("blank scenes = %d, want one for 9:16 and one for 21:9", n)
	}
	portraitDefault, otherPortraitDefault, wideDefault := defaultItems(portraitA), defaultItems(portraitB), defaultItems(ultraWide)
	if len(portraitDefault) != 1 || len(otherPortraitDefault) != 1 || len(wideDefault) != 1 ||
		portraitDefault[0].scene != otherPortraitDefault[0].scene || portraitDefault[0].scene == wideDefault[0].scene ||
		portraitDefault[0].seconds != 10 || portraitDefault[0].transition != "cut" {
		t.Fatalf("blank defaults = %#v %#v %#v", portraitDefault, otherPortraitDefault, wideDefault)
	}
	var name, layout, background, theme, zones string
	var width, height int
	blank := portraitDefault[0].scene
	if err := pool.QueryRow(ctx, `SELECT name, layout_id, background_color, theme, zones::text, aspect_width, aspect_height
		FROM signage_scenes WHERE id = $1`, blank).Scan(&name, &layout, &background, &theme, &zones, &width, &height); err != nil {
		t.Fatal(err)
	}
	if name != "Blank" || layout != "full" || background != "#000000" || theme != "dark" ||
		zones != `{"main": {"type": "empty"}}` || width != 9 || height != 16 || blank.Version() != 7 {
		t.Fatalf("blank scene = %s %s %s %s %s %d:%d version %d", name, layout, background, theme, zones, width, height, blank.Version())
	}
	if n := count(`SELECT count(*) FROM information_schema.tables WHERE table_schema = current_schema()
		AND table_name IN ('signage_playlists', 'signage_playlist_items')`); n != 0 {
		t.Fatal("playlist tables survived")
	}
	if n := count(`SELECT count(*) FROM information_schema.columns WHERE table_schema = current_schema()
		AND column_name IN ('target_kind', 'target_scene_id', 'target_playlist_id', 'default_playlist_id')`); n != 0 {
		t.Fatal("target or default playlist columns survived")
	}

	// Down rebuilds one playlist per list; up again reproduces the lists.
	if err := rollbackMigration(t, pool, migration); err != nil {
		t.Fatal(err)
	}
	var defaultName, ruleName string
	if err := pool.QueryRow(ctx, `SELECT p.name FROM signage_displays d JOIN signage_playlists p ON p.id = d.default_playlist_id
		WHERE d.id = $1`, entrance).Scan(&defaultName); err != nil || defaultName != "Default of Entrance" {
		t.Fatalf("default playlist after down = %q, %v", defaultName, err)
	}
	if err := pool.QueryRow(ctx, `SELECT p.name FROM signage_rules r JOIN signage_playlists p ON p.id = r.target_playlist_id
		WHERE r.id = $1 AND r.target_kind = 'playlist'`, playlistRule).Scan(&ruleName); err != nil || ruleName != "Rule 2 of Entrance" {
		t.Fatalf("rule playlist after down = %q, %v", ruleName, err)
	}
	if n := count(`SELECT count(*) FROM signage_playlist_items WHERE playlist_id = $1`, playlistRule); n != 2 {
		t.Fatalf("rule playlist items after down = %d", n)
	}
	applyMigrationFiles(t, pool, []string{migration})
	if got := ruleItems(playlistRule); len(got) != 2 || got[1] != (item{1, 15, wideTwo, "fade"}) {
		t.Fatalf("playlist rule items after down and up = %#v", got)
	}
	if got := defaultItems(portraitB); len(got) != 1 || got[0].scene != blank {
		t.Fatalf("portrait default after down and up = %#v", got)
	}
	if n := count(`SELECT count(*) FROM signage_scenes WHERE name = 'Blank'`); n != 2 {
		t.Fatalf("blank scenes after down and up = %d", n)
	}
}
