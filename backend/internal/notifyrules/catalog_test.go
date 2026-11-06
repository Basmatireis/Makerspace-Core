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
