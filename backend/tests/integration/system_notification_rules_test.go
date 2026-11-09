package integration_test

import (
	"slices"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/testdb"
	"github.com/google/uuid"
)

// everythingExists is the validation lookup of a fresh database: the seeded test rules name no stored rows, and any
// identifier a custom rule adds is accepted.
type everythingExists struct{}

func (everythingExists) OptionValues(notifyrules.OptionSource) (map[string]struct{}, error) {
	return map[string]struct{}{}, nil
}

func (everythingExists) ExistingIDs(_ notifyrules.IDKind, ids []uuid.UUID) (map[uuid.UUID]struct{}, error) {
	found := make(map[uuid.UUID]struct{}, len(ids))
	for _, id := range ids {
		found[id] = struct{}{}
	}
	return found, nil
}

// TestMigrationsShipNoNotificationRules checks that a new installation sends no notification until staff create a rule.
func TestMigrationsShipNoNotificationRules(t *testing.T) {
	env := newRulesEnv(t)
	var count int
	if err := env.pool.QueryRow(testContext(t), `SELECT count(*) FROM notification_rules`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("notification rules after the migrations = %d, want 0", count)
	}
}

// TestSeededSystemRulesAreValidCentralRulesOfTheServiceCategory loads every rule testdb.SeedNotificationRules creates
// for the tests of system events and runs it through the validator the editor uses, so the fixture can never drift
// from the catalog.
func TestSeededSystemRulesAreValidCentralRulesOfTheServiceCategory(t *testing.T) {
	env := newRulesEnv(t)
	testdb.SeedNotificationRules(t, env.pool)
	rows, err := env.pool.Query(testContext(t), `
		SELECT r.system_key, r.trigger_event, r.enabled, r.mandatory, r.owner_account_id IS NULL, r.category_id, r.definition::text
		FROM notification_rules r WHERE r.system_key IS NOT NULL`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var keys []string
	for rows.Next() {
		var key, event, definition string
		var enabled, mandatory, central bool
		var category uuid.UUID
		if err = rows.Scan(&key, &event, &enabled, &mandatory, &central, &category, &definition); err != nil {
			t.Fatal(err)
		}
		keys = append(keys, key)
		if !central || category != env.service {
			t.Errorf("%s is not a central rule of the service category", key)
		}
		if mandatory != (key == "lab_rules_published") {
			t.Errorf("%s: mandatory = %v", key, mandatory)
		}
		def, err := notifyrules.ParseDefinition([]byte(definition))
		if err != nil {
			t.Errorf("%s does not parse: %v", key, err)
			continue
		}
		if def.Trigger.Event != event {
			t.Errorf("%s: trigger %q differs from the column %q", key, def.Trigger.Event, event)
		}
		warnings, err := def.Validate(notifyrules.Env{Lookups: everythingExists{}})
		if err != nil {
			t.Errorf("%s does not validate: %v", key, err)
		}
		if len(warnings) > 0 {
			t.Errorf("%s uses placeholders its trigger does not fill: %q", key, warnings)
		}
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"filament_loaded", "filament_no_tag", "filament_unknown_tag", "filament_unloaded", "lab_rules_published",
		"open_day_assigned_by_other", "open_day_cancelled", "open_day_period_open", "open_day_place_freed",
		"open_day_timeslot_changed", "open_day_timeslot_removed", "open_day_unassigned_by_other", "printer_error",
		"run_finished",
	}
	slices.Sort(keys)
	if !slices.Equal(keys, want) {
		t.Fatalf("seeded system rules = %q, want %q", keys, want)
	}
}
