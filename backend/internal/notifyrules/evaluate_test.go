package notifyrules

import "testing"

func lookupFor(fields map[string]Field) FieldLookup {
	return func(key string) (Field, bool) {
		field, ok := fields[key]
		return field, ok
	}
}

var testFields = map[string]Field{
	"e.level":   {Key: "level", Type: FieldOrdered, Options: options("info", "Info", "common", "Common", "serious", "Serious", "fatal", "Fatal")},
	"e.machine": {Key: "machine", Type: FieldEnum},
	"e.code":    {Key: "code", Type: FieldText},
	"i.unpaid":  {Key: "unpaid", Type: FieldNumber, Unit: "€"},
	"i.minimum": {Key: "minimum", Type: FieldNumber},
	"i.openDay": {Key: "openDay", Type: FieldNumber},
	"i.roles":   {Key: "roles", Type: FieldList},
	"r.active":  {Key: "active", Type: FieldBool},
}

func cond(field string, op Op, value any) ConditionItem {
	return ConditionItem{Condition: &Condition{Field: field, Op: op, Value: value}}
}

func TestConditionEvaluation(t *testing.T) {
	two := 20.0
	ctx := Context{
		"e.level": "serious", "e.machine": "m1", "e.code": "0300-0100", "i.unpaid": 12.5, "i.minimum": 3,
		"i.openDay": 2, "i.roles": []string{"a", "b"}, "r.active": true,
	}
	tests := []struct {
		name string
		item ConditionItem
		want bool
	}{
		{"ordered at least holds", cond("e.level", OpGte, "common"), true},
		{"ordered at least fails", cond("e.level", OpGte, "fatal"), false},
		{"ordered at most holds", cond("e.level", OpLte, "serious"), true},
		{"ordered is", cond("e.level", OpIs, "serious"), true},
		{"ordered not", cond("e.level", OpNot, "serious"), false},
		{"enum is", cond("e.machine", OpIs, "m1"), true},
		{"enum not", cond("e.machine", OpNot, "m1"), false},
		{"enum any of strings", cond("e.machine", OpAny, []string{"m2", "m1"}), true},
		{"enum any of decoded json", cond("e.machine", OpAny, []any{"m2"}), false},
		{"enum none of", cond("e.machine", OpNone, []string{"m2"}), true},
		{"number greater", cond("i.unpaid", OpGt, 10.0), true},
		{"number greater equal boundary", cond("i.unpaid", OpGte, 12.5), true},
		{"number less", cond("i.unpaid", OpLt, 12.5), false},
		{"number less equal", cond("i.unpaid", OpLte, 12.5), true},
		{"number equal", cond("i.minimum", OpEq, 3.0), true},
		{"text contains ignores case", cond("e.code", OpContains, "0300"), true},
		{"text not contains", cond("e.code", OpNotContains, "0400"), true},
		{"text starts", cond("e.code", OpStarts, "0300-"), true},
		{"text equals", cond("e.code", OpEq, "0300-0100"), true},
		{"text not empty", cond("e.code", OpNotEmpty, nil), true},
		{"text empty", cond("e.code", OpEmpty, nil), false},
		{"list includes", cond("i.roles", OpIncludes, "b"), true},
		{"list excludes", cond("i.roles", OpExcludes, "b"), false},
		{"bool yes", cond("r.active", OpYes, nil), true},
		{"bool no", cond("r.active", OpNo, nil), false},
		{"between inside", ConditionItem{Condition: &Condition{Field: "i.unpaid", Op: OpBetween, Value: 10.0, Value2: &two}}, true},
		{"between outside", ConditionItem{Condition: &Condition{Field: "i.unpaid", Op: OpBetween, Value: 13.0, Value2: &two}}, false},
		{"ref is below another field", ConditionItem{Condition: &Condition{Field: "i.openDay", Op: OpLt, Ref: "i.minimum"}}, true},
		{"ref is not below itself", ConditionItem{Condition: &Condition{Field: "i.minimum", Op: OpLt, Ref: "i.openDay"}}, false},
	}
	for _, test := range tests {
		set := ConditionSet{Mode: ModeAll, Items: []ConditionItem{test.item}}
		if got := set.Evaluate(ctx, lookupFor(testFields)); got != test.want {
			t.Errorf("%s: got %v, want %v", test.name, got, test.want)
		}
	}
}

func TestConditionSetCombination(t *testing.T) {
	ctx := Context{"e.machine": "m1", "i.unpaid": 5.0}
	yes, no := cond("e.machine", OpIs, "m1"), cond("e.machine", OpIs, "m2")
	tests := []struct {
		name string
		set  ConditionSet
		want bool
	}{
		{"empty set is true", ConditionSet{Mode: ModeAll}, true},
		{"all with one failure", ConditionSet{Mode: ModeAll, Items: []ConditionItem{yes, no}}, false},
		{"any with one success", ConditionSet{Mode: ModeAny, Items: []ConditionItem{yes, no}}, true},
		{"any with none", ConditionSet{Mode: ModeAny, Items: []ConditionItem{no, no}}, false},
		{"unknown fields are ignored", ConditionSet{Mode: ModeAll, Items: []ConditionItem{yes, cond("e.code", OpIs, "x")}}, true},
		{"only unknown fields is true", ConditionSet{Mode: ModeAny, Items: []ConditionItem{cond("n.hour", OpGt, 3.0)}}, true},
		{"group any inside all", ConditionSet{Mode: ModeAll, Items: []ConditionItem{
			yes, {Group: &ConditionGroup{Mode: ModeAny, Items: []Condition{*no.Condition, *yes.Condition}}},
		}}, true},
		{"failing group inside all", ConditionSet{Mode: ModeAll, Items: []ConditionItem{
			yes, {Group: &ConditionGroup{Mode: ModeAll, Items: []Condition{*no.Condition, *yes.Condition}}},
		}}, false},
		{"group without applicable conditions is skipped", ConditionSet{Mode: ModeAll, Items: []ConditionItem{
			yes, {Group: &ConditionGroup{Mode: ModeAll, Items: []Condition{{Field: "e.code", Op: OpIs, Value: "x"}}}},
		}}, true},
	}
	for _, test := range tests {
		if got := test.set.Evaluate(ctx, lookupFor(testFields)); got != test.want {
			t.Errorf("%s: got %v, want %v", test.name, got, test.want)
		}
	}
}

func TestSummaryContextSumsMoneyAndTakesMaxima(t *testing.T) {
	people, _ := LookupCollection("people")
	items := []map[string]any{
		{"unpaid": 10.1, "oldestUnpaid": 4, "lastVisit": 9},
		{"unpaid": 20.2, "oldestUnpaid": 30, "lastVisit": 1},
		{"unpaid": 0.0},
	}
	ctx := SummaryContext(people, items)
	want := Context{"s.count": 3.0, "s.sum.unpaid": 30.3, "s.max.oldestUnpaid": 30.0, "s.max.lastVisit": 9.0}
	for key, value := range want {
		if ctx[key] != value {
			t.Errorf("%s = %v, want %v", key, ctx[key], value)
		}
	}
	if empty := SummaryContext(people, nil); empty["s.count"] != 0.0 || empty["s.max.lastVisit"] != 0.0 {
		t.Errorf("empty summary = %v", empty)
	}
}

func TestFillKeepsUnknownPlaceholdersVisible(t *testing.T) {
	text, unknown := Fill("{machine} reports {code} {nope} {a.b}", map[string]string{"machine": "H2D", "code": "E1"})
	if text != "H2D reports E1 {nope} {a.b}" || len(unknown) != 2 {
		t.Errorf("Fill = %q, unknown %v", text, unknown)
	}
	if keys := PlaceholderKeys("{a} {a} {b.c} {} { x }"); len(keys) != 2 || keys[0] != "a" || keys[1] != "b.c" {
		t.Errorf("PlaceholderKeys = %v", keys)
	}
	if got := Clip("abcdef", 4); got != "abc…" {
		t.Errorf("Clip = %q", got)
	}
}
