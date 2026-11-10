package notifyrules

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func machineRule(event string, machines ...string) string {
	list, _ := json.Marshal(machines)
	return `{
 "trigger": {"type": "event", "event": "` + event + `", "machines": ` + string(list) + `},
 "loop": null, "conditions": {"mode": "all", "items": []},
 "actions": [{"channel": "in_app", "delayMinutes": 0, "recipients": ["operator"], "title": "Done", "body": ""}],
 "escalation": null, "throttle": null
}`
}

func TestMachineScopeValidatesTriggerAndMachines(t *testing.T) {
	unknown := "0192f6f8-743e-7c77-a349-cd07c3e8a999"
	cases := []struct {
		name, raw, reason string
	}{
		{"listed machine", machineRule("timelapse_ready", knownMachine), ""},
		{"no machines", machineRule("run_finished"), ""},
		{"trigger without machine", machineRule("check_in", knownMachine), "trigger.machines: this event is not about a machine"},
		{"unknown machine", machineRule("printer_error", unknown), "trigger.machines: contains an unknown machine"},
		{"duplicate", machineRule("run_finished", knownMachine, knownMachine), "trigger.machines: lists a machine twice"},
		{"schedule", `{"trigger": {"type": "schedule", "schedule": {"repeat": "daily", "time": "08:00"}, "machines": ["` +
			knownMachine + `"]}, "loop": null, "conditions": {"mode": "all", "items": []},
			"actions": [{"channel": "in_app", "recipients": ["role:` + knownRole.String() + `"], "title": "Hi", "body": ""}],
			"escalation": null, "throttle": null}`, "trigger.machines: only an event trigger about a machine takes machines"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := parse(t, c.raw)
			_, err := d.Validate(central())
			if got := reason(t, err); got != c.reason {
				t.Fatalf("reason = %q, want %q", got, c.reason)
			}
		})
	}
	tooMany := make([]string, MaxMachines+1)
	for i := range tooMany {
		tooMany[i] = uuid.NewString()
	}
	d := parse(t, machineRule("run_finished", tooMany...))
	if _, err := d.Validate(central()); !strings.Contains(reason(t, err), "at most 50 machines") {
		t.Fatalf("too many machines: %v", err)
	}
}

func TestMachineScopeMatchesOnlyListedMachines(t *testing.T) {
	listed, other := uuid.New(), uuid.New()
	scoped := TriggerDef{Type: TriggerEvent, Event: "run_finished", Machines: []uuid.UUID{listed}}
	if !scoped.MatchesMachine(map[string]any{"machine": listed.String()}) {
		t.Fatal("a listed machine was skipped")
	}
	if scoped.MatchesMachine(map[string]any{"machine": other.String()}) {
		t.Fatal("another machine matched")
	}
	if scoped.MatchesMachine(map[string]any{}) {
		t.Fatal("an event without a machine matched a machine list")
	}
	all := TriggerDef{Type: TriggerEvent, Event: "run_finished"}
	if !all.MatchesMachine(map[string]any{"machine": other.String()}) || !all.MatchesMachine(nil) {
		t.Fatal("a rule without machines must match every event")
	}
}

func TestMachineScopeRoundTripsAndStaysOutWhenEmpty(t *testing.T) {
	d := parse(t, machineRule("run_finished"))
	encoded, err := d.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "machines") {
		t.Fatalf("empty machine list stored: %s", encoded)
	}
	d = parse(t, machineRule("run_finished", knownMachine))
	if encoded, err = d.Marshal(); err != nil || !strings.Contains(string(encoded), `"machines":["`+knownMachine+`"]`) {
		t.Fatalf("machine list not stored: %s (%v)", encoded, err)
	}
}

func TestCatalogMarksTriggersAboutAMachine(t *testing.T) {
	for _, key := range []string{"printer_error", "run_finished", "filament_change", "timelapse_ready", "job_created"} {
		trigger, ok := LookupTrigger(key)
		if !ok || !trigger.MachineScope() {
			t.Errorf("%s should offer a machine scope", key)
		}
	}
	for _, key := range []string{"check_in", "order_created", "lab_rules_published"} {
		if trigger, _ := LookupTrigger(key); trigger.MachineScope() {
			t.Errorf("%s should not offer a machine scope", key)
		}
	}
}

func TestMailTextsDropThePrintPageForPeopleWithoutAPassword(t *testing.T) {
	d := NewDispatcher(nil, nil).WithPublicBaseURL("https://lab.example.test/")
	run := uuid.New()
	address := d.printPageAddress(run)
	if address != "https://lab.example.test/prints/"+run.String() {
		t.Fatalf("address = %q", address)
	}
	action := Action{Title: "Timelapse ready", Body: "Watch it: " + address + "\nThanks"}
	mail := d.newMailTexts(action, PrintPageLink(run), "Rule")
	subject, body, link := mail.forRecipient(true)
	if subject != "Timelapse ready" || body != action.Body || link == nil || *link != PrintPageLink(run) {
		t.Fatalf("password holder: %q %q %v", subject, body, link)
	}
	subject, body, link = mail.forRecipient(false)
	if subject != "Timelapse ready" || body != "Watch it: \nThanks" || link != nil {
		t.Fatalf("without password: %q %q %v", subject, body, link)
	}

	// A body that is only the address falls back to the subject; other links stay for everybody.
	mail = d.newMailTexts(Action{Title: address, Body: address}, "/workshop/jobs/runs/x", "Rule name")
	subject, body, link = mail.forRecipient(false)
	if subject != "Rule name" || body != "Rule name" || link == nil || *link != "/workshop/jobs/runs/x" {
		t.Fatalf("only address: %q %q %v", subject, body, link)
	}

	// Mails that do not mention a print page are the same for everybody.
	mail = d.newMailTexts(Action{Title: "Hi", Body: "Plain"}, "/workshop", "Rule")
	if mail.printPage {
		t.Fatal("a mail without a print page was treated as one")
	}
}
