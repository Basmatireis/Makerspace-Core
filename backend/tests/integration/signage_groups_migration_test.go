package integration_test

import (
	"path/filepath"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

// Rolling back migration 00092 gives member displays a copy of their group's rules and default list and turns
// group targets of announcements into display targets; the group tables and columns are dropped.
func TestSignageGroupsMigrationDownCopiesGroupContentToMembers(t *testing.T) {
	pool := emptySchemaPool(t)
	ctx := testContext(t)
	all, err := filepath.Glob(filepath.Join(filepath.Dir(orderedMigrationFiles(t)[0]), "*.sql"))
	if err != nil {
		t.Fatal(err)
	}
	var upTo []string
	var migration string
	for _, path := range all {
		name := filepath.Base(path)
		if name <= "00092_signage_display_groups.sql" {
			upTo = append(upTo, path)
		}
		if name == "00092_signage_display_groups.sql" {
			migration = path
		}
	}
	if migration == "" {
		t.Fatal("migration 00092 not found")
	}
	applyMigrationFiles(t, pool, upTo)
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
	sceneID := ids.New()
	exec(`INSERT INTO signage_scenes (id, name, aspect_width, aspect_height, layout_id, background_color, theme, zones)
		VALUES ($1, 'Wide', 16, 9, 'full', '#101820', 'dark', '{"main": {"type": "empty"}}')`, sceneID)
	groupID := ids.New()
	exec(`INSERT INTO signage_display_groups (id, name, aspect_width, aspect_height) VALUES ($1, 'Hall', 16, 9)`, groupID)
	exec(`INSERT INTO signage_default_scenes (group_id, position, scene_id, seconds, transition) VALUES ($1, 0, $2, 10, 'cut')`,
		groupID, sceneID)
	groupRule := ids.New()
	exec(`INSERT INTO signage_rules (id, group_id, position, condition_kind) VALUES ($1, $2, 0, 'live_data_unavailable')`,
		groupRule, groupID)
	exec(`INSERT INTO signage_rule_scenes (rule_id, position, scene_id, seconds, transition) VALUES ($1, 0, $2, 15, 'fade')`,
		groupRule, sceneID)
	display := func(name string, group *uuid.UUID) uuid.UUID {
		typeID, deviceID, displayID := ids.New(), ids.New(), ids.New()
		exec(`INSERT INTO device_types (id, name) VALUES ($1, $2)`, typeID, name+" type")
		exec(`INSERT INTO managed_devices (id, name, device_type_id, token_digest)
			VALUES ($1, $2, $3, decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'))`,
			deviceID, name, typeID)
		exec(`INSERT INTO signage_displays (id, managed_device_id, name, aspect_width, aspect_height, group_id)
			VALUES ($1, $2, $3, 16, 9, $4)`, displayID, deviceID, name, group)
		return displayID
	}
	memberA, memberB := display("Member A", &groupID), display("Member B", &groupID)
	standalone := display("Standalone", nil)
	exec(`INSERT INTO signage_default_scenes (display_id, position, scene_id, seconds, transition) VALUES ($1, 0, $2, 10, 'cut')`,
		standalone, sceneID)
	templateID, announcementID := ids.New(), ids.New()
	exec(`INSERT INTO signage_announcement_templates (id, name, tone, title) VALUES ($1, 'Notice', 'info', 'Hi')`, templateID)
	exec(`INSERT INTO signage_announcements (id, template_id, all_displays, starts_at) VALUES ($1, $2, false, now())`,
		announcementID, templateID)
	exec(`INSERT INTO signage_announcement_displays (announcement_id, display_id) VALUES ($1, $2)`, announcementID, memberA)
	exec(`INSERT INTO signage_announcement_groups (announcement_id, group_id) VALUES ($1, $2)`, announcementID, groupID)

	if err := rollbackMigration(t, pool, migration); err != nil {
		t.Fatal(err)
	}
	for _, member := range []uuid.UUID{memberA, memberB} {
		if n := count(`SELECT count(*) FROM signage_rules r JOIN signage_rule_scenes rs ON rs.rule_id = r.id
			WHERE r.display_id = $1 AND r.id <> $2 AND r.position = 0 AND rs.seconds = 15 AND rs.transition = 'fade'`,
			member, groupRule); n != 1 {
			t.Fatalf("member %s rules after down = %d", member, n)
		}
		if n := count(`SELECT count(*) FROM signage_default_scenes WHERE display_id = $1 AND scene_id = $2`, member, sceneID); n != 1 {
			t.Fatalf("member %s default after down = %d", member, n)
		}
		if n := count(`SELECT count(*) FROM signage_announcement_displays WHERE announcement_id = $1 AND display_id = $2`,
			announcementID, member); n != 1 {
			t.Fatalf("member %s announcement target after down = %d", member, n)
		}
	}
	if n := count(`SELECT count(*) FROM signage_rules WHERE id = $1`, groupRule); n != 0 {
		t.Fatal("group rule survived")
	}
	if n := count(`SELECT count(*) FROM information_schema.tables WHERE table_schema = current_schema()
		AND table_name IN ('signage_display_groups', 'signage_announcement_groups')`); n != 0 {
		t.Fatal("group tables survived")
	}
	applyMigrationFiles(t, pool, []string{migration})
	if n := count(`SELECT count(*) FROM signage_default_scenes WHERE display_id IS NOT NULL`); n != 3 {
		t.Fatalf("default rows after up again = %d", n)
	}
}
