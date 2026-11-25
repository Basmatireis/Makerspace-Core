package printerconnectors

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
	"github.com/google/uuid"
)

// withNotifications rebuilds the harness's service with a real rule dispatcher behind the connector and the manual
// mounts, and returns the printing service that mounts by hand.
func (h *ingestHarness) withNotifications() *printing.Service {
	h.t.Helper()
	events := notifyrules.NewSystemEvents(notifyrules.NewDispatcher(h.pool, time.UTC))
	printingService := printing.NewService(h.pool).WithNotifications(events)
	service, err := NewService(h.pool, events, printingService, nil)
	if err != nil {
		h.t.Fatal(err)
	}
	h.service = service
	return printingService
}

// untaggedFilamentRule notifies the harness's person in the app about material without a known spool, also later.
func (h *ingestHarness) untaggedFilamentRule() uuid.UUID {
	h.t.Helper()
	var category uuid.UUID
	if err := h.pool.QueryRow(h.t.Context(), `SELECT id FROM notification_categories WHERE key='service'`).Scan(&category); err != nil {
		h.t.Fatal(err)
	}
	later := 60
	rule, err := notifyrules.NewService(h.pool).CreateRule(h.t.Context(), h.principal, notifyrules.RuleInput{
		Name: "Untagged filament " + h.suffix, Enabled: true, CategoryID: &category,
		Definition: notifyrules.Definition{
			Trigger: notifyrules.TriggerDef{Type: notifyrules.TriggerEvent, Event: "filament_change"},
			Conditions: notifyrules.ConditionSet{Mode: notifyrules.ModeAll, Items: []notifyrules.ConditionItem{{
				Condition: &notifyrules.Condition{Field: "e.change", Op: notifyrules.OpAny, Value: []any{"no_tag", "unknown_tag"}},
			}}},
			Actions: []notifyrules.Action{{
				Channel: notifyrules.ChannelInApp, Recipients: []string{"person:" + h.principal.PersonID.String()},
				Title: "Unknown filament in {machine} {slot}", Body: "Please mount a spool.",
				InApp: &notifyrules.InAppOptions{
					Appearance: notifyrules.AppearanceToast, Level: notifyrules.LevelWarning, ToastSeconds: 10,
					Button: &notifyrules.Button{Kind: notifyrules.ButtonNone}, OnlineOnly: true, LaterMinutes: &later,
				},
			}},
		},
	}, nil)
	if err != nil {
		h.t.Fatalf("create rule: %v", err)
	}
	return rule.ID
}

// firing reports whether the rule fired for the slot and whether that firing is resolved.
func (h *ingestHarness) firing(rule, slot uuid.UUID) (fired, resolved bool) {
	h.t.Helper()
	var resolvedAt *time.Time
	err := h.pool.QueryRow(h.t.Context(),
		`SELECT resolved_at FROM notification_firings WHERE rule_id=$1 AND resolve_token=$2`,
		rule, "filament_slot:"+slot.String()).Scan(&resolvedAt)
	if err != nil {
		return false, false
	}
	return true, resolvedAt != nil
}

// observeLive sends a slot observation the connector made with its history complete, the kind that tells people.
func (h *ingestHarness) observeLive(name, slotExternal string, at time.Time, fields string) {
	h.t.Helper()
	h.sequence++
	receipt := h.sendEvent(EventInput{
		EventID: ids.New(), AssignmentID: h.assignment.ID, ConfigurationVersion: h.assignment.ConfigurationVersion,
		Sequence: h.sequence, OccurredAt: at, Kind: "slot_observation", HistoryComplete: true,
		Payload: json.RawMessage(fmt.Sprintf(
			`{"inputUnitExternalId":%q,"slotExternalId":%q,%s}`, h.unitExternal(name), slotExternal, fields,
		)),
	})
	if receipt.Status != "accepted" {
		h.t.Fatalf("slot observation receipt = %+v", receipt)
	}
}

func (h *ingestHarness) slotOf(slotExternal string) uuid.UUID {
	h.t.Helper()
	var id uuid.UUID
	if err := h.pool.QueryRow(h.t.Context(), `SELECT id FROM printer_slots WHERE external_identifier=$1`, slotExternal).
		Scan(&id); err != nil {
		h.t.Fatal(err)
	}
	return id
}

func TestUntaggedFilamentNotifiesWithoutAPrintUntilAManualMount(t *testing.T) {
	h := newIngestHarness(t)
	h.autoDetect()
	printingService := h.withNotifications()
	rule := h.untaggedFilamentRule()
	at := time.Now().UTC().Truncate(time.Second).Add(-10 * time.Minute)
	slotExternal := "untagged-" + h.suffix
	spoolID := h.mountSpool("Untagged", &slotExternal, at.Add(-time.Hour))
	h.unmountSpool(spoolID, at.Add(-30*time.Minute))
	slot := h.slotOf(slotExternal)

	// Nothing prints; the printer reads material without a tag in a slot without a mount.
	h.observeLive("Untagged", slotExternal, at, `"empty":true,"trayType":"PLA","color":"FF0000FF"`)
	fired, resolved := h.firing(rule, slot)
	if !fired || resolved {
		t.Fatalf("untagged filament without a print: fired %v, resolved %v", fired, resolved)
	}
	var waiting int
	if err := h.pool.QueryRow(t.Context(), `SELECT count(*) FROM notification_presence_waits WHERE person_id=$1`,
		h.principal.PersonID).Scan(&waiting); err != nil || waiting != 1 {
		t.Fatalf("the offline person does not wait for the notification: %d (%v)", waiting, err)
	}

	// Mounting the spool by hand sorts the slot out: the firing is resolved and the wait is not delivered.
	if _, err := printingService.Mount(t.Context(), h.principal, slot, spoolID, nil); err != nil {
		t.Fatal(err)
	}
	if _, resolved = h.firing(rule, slot); !resolved {
		t.Fatal("a manual mount did not resolve the untagged filament notification")
	}
}

func TestUntaggedFilamentIsResolvedWhenTheTrayIsEmptied(t *testing.T) {
	h := newIngestHarness(t)
	h.autoDetect()
	h.withNotifications()
	rule := h.untaggedFilamentRule()
	at := time.Now().UTC().Truncate(time.Second).Add(-10 * time.Minute)
	slotExternal := "emptied-" + h.suffix
	spoolID := h.mountSpool("Emptied", &slotExternal, at.Add(-time.Hour))
	h.unmountSpool(spoolID, at.Add(-30*time.Minute))
	slot := h.slotOf(slotExternal)

	h.observeLive("Emptied", slotExternal, at, `"empty":true,"trayType":"PETG"`)
	if fired, _ := h.firing(rule, slot); !fired {
		t.Fatal("untagged filament did not fire")
	}
	h.observeLive("Emptied", slotExternal, at.Add(time.Minute), `"empty":true`)
	if _, resolved := h.firing(rule, slot); !resolved {
		t.Fatal("emptying the tray did not resolve the untagged filament notification")
	}
}
