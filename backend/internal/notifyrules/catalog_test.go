package notifyrules

import (
	"strings"
	"testing"
)

func TestCatalogEntriesAreWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for _, trigger := range Triggers() {
		if seen[trigger.Key] || trigger.Label == "" || trigger.Area == "" || trigger.Subject == "" {
			t.Errorf("trigger %q is incomplete or duplicated", trigger.Key)
		}
		seen[trigger.Key] = true
		checkFields(t, "trigger "+trigger.Key, trigger.Fields)
		for _, placeholder := range trigger.Placeholders {
			if placeholder.Key == "" || placeholder.Example == "" {
				t.Errorf("trigger %s has an incomplete placeholder", trigger.Key)
			}
		}
		if trigger.Subject == SubjectSelf && !trigger.hasRecipient("self") {
			t.Errorf("trigger %s concerns one person but offers no self recipient", trigger.Key)
		}
		for _, resolution := range trigger.Resolutions {
			for _, generic := range GenericResolutions() {
				if resolution.Key == generic.Key {
					t.Errorf("trigger %s repeats the generic resolution %s", trigger.Key, generic.Key)
				}
			}
		}
	}
	for _, collection := range Collections() {
		checkFields(t, "collection "+collection.Key, collection.Fields)
		if collection.PlaceholderPrefix == "" || collection.Permission == "" {
			t.Errorf("collection %s lacks a placeholder prefix or permission", collection.Key)
		}
	}
	checkFields(t, "recipient fields", RecipientFields())
	checkFields(t, "now fields", NowFields())
	checkFields(t, "open day fields", OpenDayFields(true))
}

func checkFields(t *testing.T, owner string, fields []Field) {
	t.Helper()
	keys := map[string]bool{}
	for _, field := range fields {
		if keys[field.Key] || strings.Contains(field.Key, ".") || field.Label == "" {
			t.Errorf("%s: field %q is duplicated, dotted or unlabeled", owner, field.Key)
		}
		keys[field.Key] = true
		fixed := len(field.Options) > 0
		switch field.Type {
		case FieldEnum, FieldOrdered, FieldList:
			if fixed == (field.OptionsFrom != "") {
				t.Errorf("%s: %s needs exactly one of fixed options and an option source", owner, field.Key)
			}
		default:
			if fixed || field.OptionsFrom != "" {
				t.Errorf("%s: %s has options but is not an enum, ordered or list field", owner, field.Key)
			}
		}
	}
}

func TestSummaryFieldsAggregateMoneyAndDurations(t *testing.T) {
	people, _ := LookupCollection("people")
	keys := map[string]bool{}
	for _, field := range SummaryFields(people) {
		keys[field.Key] = true
	}
	for _, want := range []string{"count", "sum.unpaid", "max.oldestUnpaid", "max.lastVisit"} {
		if !keys[want] {
			t.Errorf("people summary lacks %s", want)
		}
	}
	if keys["sum.openDays"] || keys["max.minimum"] {
		t.Error("plain numbers must not be aggregated")
	}
}

func TestEveryTriggerAcceptsARuleThatUsesItsRecipientsPlaceholdersAndFields(t *testing.T) {
	for _, trigger := range Triggers() {
		recipient := "role:" + knownRole.String()
		if len(trigger.Recipients) > 0 {
			recipient = trigger.Recipients[0].Key
		}
		title := ""
		for _, placeholder := range trigger.Placeholders {
			title += "{" + placeholder.Key + "} "
		}
		def := Definition{
			Trigger:    TriggerDef{Type: TriggerEvent, Event: trigger.Key},
			Conditions: ConditionSet{Mode: ModeAll},
			Actions: []Action{{
				Channel: ChannelInApp, Recipients: []string{recipient}, Title: strings.TrimSpace(title) + " x", Body: "text",
			}},
		}
		for _, field := range trigger.Fields {
			if field.Type == FieldNumber {
				def.Conditions.Items = append(def.Conditions.Items, ConditionItem{
					Condition: &Condition{Field: PrefixEvent + "." + field.Key, Op: OpGte, Value: float64(0)},
				})
			}
		}
		if len(trigger.ThrottleSubjects) > 0 {
			def.Throttle = &Throttle{Per: trigger.ThrottleSubjects[0].Key, Every: Duration{Value: 10, Unit: "minutes"}}
		}
		if _, err := def.Validate(central()); err != nil {
			t.Errorf("trigger %s: a rule using its recipients, placeholders, numbers and throttle does not validate: %v", trigger.Key, err)
		}
	}
}

func TestNewTriggersNeverOfferPeopleOfAnonymousFeedback(t *testing.T) {
	survey, ok := LookupTrigger("survey_answered")
	if !ok || len(survey.Recipients) != 0 {
		t.Fatalf("survey_answered must offer no person recipients: %+v", survey.Recipients)
	}
	for _, placeholder := range survey.Placeholders {
		if placeholder.Key == "person" || placeholder.Key == "comment" {
			t.Errorf("survey_answered offers the placeholder %s", placeholder.Key)
		}
	}
}
