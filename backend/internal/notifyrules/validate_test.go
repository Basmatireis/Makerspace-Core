package notifyrules

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

var (
	knownRole    = uuid.MustParse("0192f6f8-743e-7c77-a349-cd07c3e8a921")
	knownPerson  = uuid.MustParse("0192f6f8-743e-7c77-a349-cd07c3e8a922")
	knownMachine = "0192f6f8-743e-7c77-a349-cd07c3e8a923"
)

type fakeLookups struct{}

func (fakeLookups) OptionValues(source OptionSource) (map[string]struct{}, error) {
	return map[string]struct{}{knownMachine: {}, knownRole.String(): {}}, nil
}

func (fakeLookups) ExistingIDs(kind IDKind, ids []uuid.UUID) (map[uuid.UUID]struct{}, error) {
	found := map[uuid.UUID]struct{}{}
	for _, id := range ids {
		if (kind == IDRoles && id == knownRole) || (kind != IDRoles && id == knownPerson) {
			found[id] = struct{}{}
		}
	}
	return found, nil
}

const validEventRule = `{
 "trigger": {"type": "event", "event": "printer_error"},
 "loop": null,
 "conditions": {"mode": "all", "items": [
   {"field": "e.level", "op": "gte", "value": "serious"},
   {"group": {"mode": "any", "items": [{"field": "r.systemRole", "op": "is", "value": "supervisor"}]}}
 ]},
 "actions": [{"channel": "in_app", "delayMinutes": 0, "recipients": ["operator", "role:` + "0192f6f8-743e-7c77-a349-cd07c3e8a921" + `"],
   "title": "{machine}: {level} error", "body": "{code} {meaning}"}],
 "escalation": {"stopWhen": "error_cleared", "steps": [{"after": {"value": 20, "unit": "minutes"},
   "action": {"channel": "email", "delayMinutes": 0, "recipients": ["present"], "title": "Still open", "body": ""}}]},
 "throttle": {"per": "machine", "every": {"value": 30, "unit": "minutes"}}
}`

func parse(t *testing.T, raw string) Definition {
	t.Helper()
	d, err := ParseDefinition([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func central() Env { return Env{Lookups: fakeLookups{}} }

func personal() Env {
	return Env{Personal: true, Lookups: fakeLookups{}, CanSee: func(p authorization.Permission) bool {
		return p == authorization.MachinesRead
	}}
}

func reason(t *testing.T, err error) string {
	t.Helper()
	var app *apperror.Error
	if err == nil {
		return ""
	}
	if !asApp(err, &app) {
		t.Fatalf("not an application error: %v", err)
	}
	text, _ := app.Details["reason"].(string)
	return text
}

func asApp(err error, target **apperror.Error) bool {
	app, ok := err.(*apperror.Error)
	*target = app
	return ok
}

func TestValidDefinitionRoundTripsAndNormalizes(t *testing.T) {
	d := parse(t, validEventRule)
	warnings, err := d.Validate(central())
	if err != nil || len(warnings) != 0 {
		t.Fatalf("validate: %v %v", err, warnings)
	}
	if d.Actions[0].InApp == nil || d.Actions[0].InApp.Appearance != AppearanceToast || d.Actions[0].InApp.Button.Kind != ButtonNone {
		t.Errorf("in-app defaults not filled: %+v", d.Actions[0].InApp)
	}
	data, err := d.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	again, err := ParseDefinition(data)
	if err != nil {
		t.Fatalf("stored JSON no longer parses: %v", err)
	}
	if _, err := again.Validate(central()); err != nil {
		t.Fatalf("stored JSON no longer validates: %v", err)
	}
	var generic map[string]any
	if err := json.Unmarshal(data, &generic); err != nil || generic["loop"] != nil {
		t.Errorf("loop must stay explicit null: %v", generic["loop"])
	}
}

func TestParseRejectsUnknownPropertiesAndTrailingData(t *testing.T) {
	for name, raw := range map[string]string{
		"unknown property": `{"trigger":{"type":"manual"},"surprise":1}`,
		"trailing data":    `{"trigger":{"type":"manual"}} {}`,
		"wrong type":       `{"trigger":{"type":"manual"},"actions":"x"}`,
		"group with extra": `{"conditions":{"mode":"all","items":[{"group":{"mode":"all","items":[]},"field":"x"}]}}`,
		"nested group":     `{"conditions":{"mode":"all","items":[{"group":{"mode":"all","items":[{"group":{}}]}}]}}`,
	} {
		if _, err := ParseDefinition([]byte(raw)); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}

func TestValidationRejections(t *testing.T) {
	mutations := map[string]struct {
		edit func(d *Definition)
		env  Env
		want string
	}{
		"unknown event":         {func(d *Definition) { d.Trigger.Event = "nope" }, central(), "trigger.event"},
		"event with schedule":   {func(d *Definition) { d.Trigger.Schedule = &Schedule{Repeat: RepeatDaily} }, central(), "trigger.schedule"},
		"unknown field":         {func(d *Definition) { d.Conditions.Items[0].Condition.Field = "e.nothing" }, central(), "conditions.items[0].field"},
		"operator for the type": {func(d *Definition) { d.Conditions.Items[0].Condition.Op = OpContains }, central(), "conditions.items[0].op"},
		"unknown ordered value": {func(d *Definition) { d.Conditions.Items[0].Condition.Value = "dire" }, central(), "conditions.items[0].value"},
		"loop field outside":    {func(d *Definition) { d.Conditions.Items[0].Condition.Field = "i.unpaid" }, central(), "conditions.items[0].field"},
		"empty group":           {func(d *Definition) { d.Conditions.Items[1].Group.Items = nil }, central(), "group.items"},
		"too many conditions": {func(d *Definition) {
			for range MaxConditions {
				d.Conditions.Items = append(d.Conditions.Items, cond("e.code", OpContains, "x"))
			}
		}, central(), "conditions.items"},
		"no actions": {func(d *Definition) { d.Actions = nil }, central(), "actions"},
		"too many actions": {func(d *Definition) {
			for range MaxActions {
				d.Actions = append(d.Actions, d.Actions[0])
			}
		}, central(), "actions"},
		"unknown recipient":    {func(d *Definition) { d.Actions[0].Recipients = []string{"everybody"} }, central(), "recipients"},
		"me in a central rule": {func(d *Definition) { d.Actions[0].Recipients = []string{"me"} }, central(), "recipients"},
		"missing role":         {func(d *Definition) { d.Actions[0].Recipients = []string{"role:" + knownPerson.String()} }, central(), "does not exist"},
		"duplicate recipient":  {func(d *Definition) { d.Actions[0].Recipients = []string{"operator", "operator"} }, central(), "twice"},
		"empty title":          {func(d *Definition) { d.Actions[0].Title = "  " }, central(), "title"},
		"long title":           {func(d *Definition) { d.Actions[0].Title = strings.Repeat("a", MaxTitleLength+1) }, central(), "title"},
		"long body":            {func(d *Definition) { d.Actions[0].Body = strings.Repeat("a", MaxBodyLength+1) }, central(), "body"},
		"bad delay":            {func(d *Definition) { d.Actions[0].DelayMinutes = -1 }, central(), "delayMinutes"},
		"toast time on a banner": {func(d *Definition) {
			d.Actions[0].InApp = &InAppOptions{Appearance: AppearanceBanner, Level: LevelInfo, ToastSeconds: 5}
		}, central(), "toastSeconds"},
		"later on a toast": {func(d *Definition) {
			d.Actions[0].InApp = &InAppOptions{Appearance: AppearanceToast, Level: LevelInfo, AllowLater: true}
		}, central(), "banner or dialog"},
		"link button without link": {func(d *Definition) {
			d.Actions[0].InApp = &InAppOptions{Appearance: AppearanceDialog, Level: LevelInfo, Button: &Button{Kind: ButtonLink, Label: "Open"}}
		}, central(), "link button"},
		"javascript link": {func(d *Definition) {
			d.Actions[0].InApp = &InAppOptions{
				Appearance: AppearanceDialog, Level: LevelInfo,
				Button: &Button{Kind: ButtonLink, Label: "Open", Link: "javascript:alert(1)"},
			}
		}, central(), "link button"},
		"options on the wrong channel": {func(d *Definition) {
			d.Escalation.Steps[0].Action.InApp = &InAppOptions{Appearance: AppearanceBell, Level: LevelInfo}
		}, central(), "only in-app"},
		"signage without displays": {func(d *Definition) {
			d.Actions[0] = Action{Channel: ChannelSignage, Title: "x", Signage: &SignageTarget{DurationMinutes: 5, Tone: ToneInfo}}
		}, central(), "displayIds"},
		"unknown escalation stop": {func(d *Definition) { d.Escalation.StopWhen = "tuesday" }, central(), "stopWhen"},
		"escalation order": {func(d *Definition) {
			d.Escalation.Steps = append(d.Escalation.Steps, d.Escalation.Steps[0])
		}, central(), "later than the step before"},
		"escalation delay": {func(d *Definition) { d.Escalation.Steps[0].Action.DelayMinutes = 5 }, central(), "delayMinutes"},
		"too many steps": {func(d *Definition) {
			for i := range MaxEscalationSteps {
				step := d.Escalation.Steps[0]
				step.After = Duration{Value: 30 + i, Unit: UnitMinutes}
				d.Escalation.Steps = append(d.Escalation.Steps, step)
			}
		}, central(), "escalation.steps"},
		"unknown throttle":    {func(d *Definition) { d.Throttle.Per = "colour" }, central(), "throttle.per"},
		"throttle too long":   {func(d *Definition) { d.Throttle.Every = Duration{Value: 31, Unit: UnitDays} }, central(), "throttle.every"},
		"hidden trigger":      {func(d *Definition) {}, Env{Lookups: fakeLookups{}, CanSee: func(authorization.Permission) bool { return false }}, "trigger.event"},
		"personal escalation": {func(d *Definition) { d.Actions[0].Recipients = []string{"me"} }, personal(), "escalation"},
		"personal others":     {func(d *Definition) { d.Escalation = nil; d.Actions[0].Recipients = []string{"operator"} }, personal(), `exactly "me"`},
		"personal signage": {func(d *Definition) {
			d.Escalation = nil
			d.Actions[0] = Action{Channel: ChannelSignage, Title: "x", Signage: &SignageTarget{DisplayIDs: []uuid.UUID{knownPerson}, DurationMinutes: 5, Tone: ToneInfo}}
		}, personal(), "channel"},
		"personal manual": {func(d *Definition) {
			d.Trigger = TriggerDef{Type: TriggerManual}
			d.Escalation, d.Throttle = nil, nil
			d.Conditions = ConditionSet{Mode: ModeAll}
			d.Actions[0].Recipients = []string{"me"}
		}, personal(), "trigger.type"},
	}
	for name, test := range mutations {
		d := parse(t, validEventRule)
		test.edit(&d)
		_, err := d.Validate(test.env)
		if err == nil {
			t.Errorf("%s: accepted", name)
			continue
		}
		if got := reason(t, err); !strings.Contains(got, test.want) {
			t.Errorf("%s: reason %q lacks %q", name, got, test.want)
		}
	}
}

func TestPersonalRuleOnVisibleTriggerPasses(t *testing.T) {
	d := parse(t, validEventRule)
	d.Escalation = nil
	d.Actions[0].Recipients = []string{"me"}
	if _, err := d.Validate(personal()); err != nil {
		t.Fatal(err)
	}
	// The same trigger is refused once the author may no longer see machines.
	d = parse(t, validEventRule)
	d.Escalation = nil
	d.Actions[0].Recipients = []string{"me"}
	blind := Env{Personal: true, Lookups: fakeLookups{}, CanSee: func(authorization.Permission) bool { return false }}
	if _, err := d.Validate(blind); err == nil {
		t.Fatal("a personal rule used a trigger its owner may not see")
	}
}

func TestLoopRules(t *testing.T) {
	raw := `{
 "trigger": {"type": "schedule", "schedule": {"repeat": "weekly", "weekdays": ["mon","thu"], "time": "09:00"}},
 "loop": {"collection": "people", "mode": "each", "filter": {"mode": "all", "items": [
    {"field": "i.unpaid", "op": "gt", "value": 5}, {"field": "i.openDays", "op": "lt", "ref": "i.minimum"}]}},
 "conditions": {"mode": "all", "items": [{"field": "r.unpaid", "op": "gt", "value": 0}]},
 "actions": [{"channel": "email", "recipients": ["item:item"], "title": "Unpaid: {person.unpaid}", "body": "{person.nope}"}],
 "escalation": null, "throttle": {"per": "item", "every": {"value": 7, "unit": "days"}}
}`
	d := parse(t, raw)
	warnings, err := d.Validate(central())
	if err != nil {
		t.Fatal(reason(t, err))
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "person.nope") {
		t.Errorf("warnings = %v", warnings)
	}

	summary := parse(t, strings.Replace(strings.Replace(raw, `"mode": "each"`, `"mode": "summary"`, 1), `"item:item"`, `"role:`+knownRole.String()+`"`, 1))
	summary.Conditions = ConditionSet{Mode: ModeAll, Items: []ConditionItem{cond("s.count", OpGt, 3.0), cond("s.sum.unpaid", OpGte, 50.0)}}
	summary.Throttle = nil
	if _, err := summary.Validate(central()); err != nil {
		t.Fatal(reason(t, err))
	}
	summary.Conditions.Items[0].Condition.Field = "i.unpaid"
	if _, err := summary.Validate(central()); err == nil {
		t.Error("a summary rule used an item field in its conditions")
	}

	mismatch := parse(t, raw)
	mismatch.Conditions.Items[0].Condition = &Condition{Field: "r.unpaid", Op: OpGt, Ref: "i.unpaid"}
	if _, err := mismatch.Validate(central()); err == nil || !strings.Contains(reason(t, err), "same part") {
		t.Errorf("ref across contexts accepted: %v", err)
	}
	notNumber := parse(t, raw)
	notNumber.Loop.Filter.Items[1].Condition = &Condition{Field: "i.name", Op: OpEq, Ref: "i.minimum"}
	if _, err := notNumber.Validate(central()); err == nil {
		t.Error("a text field compared with a number field")
	}
	between := parse(t, raw)
	between.Loop.Filter.Items[1].Condition = &Condition{Field: "i.unpaid", Op: OpBetween, Value: 5.0}
	if _, err := between.Validate(central()); err == nil {
		t.Error("between without a second value")
	}
	hiddenField := parse(t, raw)
	noOrders := Env{Lookups: fakeLookups{}, CanSee: func(p authorization.Permission) bool { return p != authorization.OrdersRead }}
	if _, err := hiddenField.Validate(noOrders); err == nil {
		t.Error("a field needing orders.read passed without it")
	}
}

func TestScheduleRules(t *testing.T) {
	hours := 24
	bad := 99
	valid := []Schedule{
		{Repeat: RepeatDaily, Time: "09:00"},
		{Repeat: RepeatWeekdays, Time: "18:30"},
		{Repeat: RepeatWeekly, Weekdays: []string{"mon"}, Time: "09:00"},
		{Repeat: RepeatMonthly, DayOfMonth: 28, Time: "09:00"},
		{Repeat: RepeatBeforeOpenDay, Hours: &hours},
	}
	invalid := []Schedule{
		{Repeat: RepeatDaily},
		{Repeat: RepeatDaily, Time: "9am"},
		{Repeat: RepeatDaily, Time: "09:00", Weekdays: []string{"mon"}},
		{Repeat: RepeatWeekly, Time: "09:00"},
		{Repeat: RepeatWeekly, Weekdays: []string{"mon", "mon"}, Time: "09:00"},
		{Repeat: RepeatWeekly, Weekdays: []string{"someday"}, Time: "09:00"},
		{Repeat: RepeatMonthly, DayOfMonth: 29, Time: "09:00"},
		{Repeat: RepeatBeforeOpenDay, Hours: &bad},
		{Repeat: RepeatBeforeOpenDay},
		{Repeat: RepeatBeforeOpenDay, Hours: &hours, Time: "09:00"},
		{Repeat: "yearly", Time: "09:00"},
	}
	run := func(s Schedule) error {
		d := parse(t, `{"trigger":{"type":"manual"},"loop":null,"conditions":{"mode":"all","items":[]},
		 "actions":[{"channel":"email","recipients":["role:`+knownRole.String()+`"],"title":"x","body":""}],"escalation":null,"throttle":null}`)
		d.Trigger = TriggerDef{Type: TriggerSchedule, Schedule: &s}
		_, err := d.Validate(central())
		return err
	}
	for _, s := range valid {
		if err := run(s); err != nil {
			t.Errorf("%+v: %v", s, reason(t, err))
		}
	}
	for _, s := range invalid {
		if run(s) == nil {
			t.Errorf("%+v accepted", s)
		}
	}
}

func TestOpenDayScheduleOffersItsContext(t *testing.T) {
	hours := 24
	d := Definition{
		Trigger:    TriggerDef{Type: TriggerSchedule, Schedule: &Schedule{Repeat: RepeatBeforeOpenDay, Hours: &hours}},
		Conditions: ConditionSet{Mode: ModeAll, Items: []ConditionItem{cond("e.free", OpGt, 0.0), cond("e.mine", OpYes, nil)}},
		Actions:    []Action{{Channel: ChannelInApp, Recipients: []string{"me"}, Title: "{day} {time}", Body: "{free} free"}},
	}
	if _, err := d.Validate(personal()); err != nil {
		t.Fatal(reason(t, err))
	}
	central := Definition{
		Trigger:    d.Trigger,
		Conditions: ConditionSet{Mode: ModeAll, Items: []ConditionItem{cond("e.mine", OpYes, nil)}},
		Actions:    []Action{{Channel: ChannelInApp, Recipients: []string{"day_team"}, Title: "x"}},
	}
	if _, err := central.Validate(Env{Lookups: fakeLookups{}}); err == nil {
		t.Error(`the "mine" field exists for personal rules only`)
	}
}
