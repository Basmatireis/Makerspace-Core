package engine

import (
	"strings"
	"testing"
	"time"

	"github.com/shopspring/decimal"
)

type collected struct{ messages []string }

func (c *collected) report(_, message string) { c.messages = append(c.messages, message) }

func testEvaluator(kind Kind, locale string, root Data) (*evaluator, *collected) {
	ev := newEvaluator(evalConfig{
		kind: kind, locale: locale, location: viennaLocation, blankZero: kind == KindCashbook, can: allowAll,
	}, root)
	c := &collected{}
	ev.report = c.report
	return ev, c
}

func TestFiltersFormatValues(t *testing.T) {
	late := time.Date(2026, 11, 18, 23, 30, 0, 0, time.UTC) // 19.11.2026 00:30 in Vienna
	root := Data{
		"request": map[string]any{
			"number": "W-1", "approvedAt": late, "approver": "", "serviceDescription": "makerspace",
			"servicePeriod": map[string]any{"from": "2026-10-01"},
		},
		"recipient": map[string]any{"addressLines": []string{"Samplegasse 1", "8010 Graz"}, "organization": "Ex"},
		"amounts":   map[string]any{"total": decimal.RequireFromString("1234.5"), "alreadyPaid": -5.0, "toInvoice": 0},
		"items": []map[string]any{
			{"amount": decimal.RequireFromString("12.00"), "quantity": 2.5},
			{"amount": decimal.RequireFromString("60.50"), "quantity": 1},
		},
	}
	cases := []struct {
		locale, text, want string
	}{
		{"en", "{{amounts.total | currency}}", "EUR 1,234.50"},
		{"de", "{{amounts.total | currency}}", "1.234,50 €"},
		{"en", "{{amounts.alreadyPaid | currency}}", "-EUR 5.00"},
		{"en", "{{amounts.total | amount}}", "1,234.50"},
		{"de", "{{amounts.total | amount}}", "1.234,50"},
		{"en", "{{amounts.toInvoice | amount}}", "0.00"},
		{"en", "{{amounts.total | number(0)}}", "1,235"},
		{"de", "{{amounts.total | number(1)}}", "1.234,5"},
		{"en", "{{amounts.total}}", "1,234.50"},
		{"en", "{{request.approvedAt | date}}", "19.11.2026"},
		{"en", `{{request.approvedAt | date("yyyy-MM-dd")}}`, "2026-11-19"},
		{"en", "{{request.approvedAt | datetime}}", "19.11.2026 00:30"},
		{"en", "{{request.approvedAt | time}}", "00:30"},
		{"en", "{{request.approvedAt}}", "19.11.2026"},
		{"en", "{{request.servicePeriod.from | date}}", "01.10.2026"},
		{"en", "{{request.servicePeriod.from}}", "01.10.2026"},
		{"en", "{{request.serviceDescription | upper}}", "MAKERSPACE"},
		{"en", "{{recipient.organization | lower}}", "ex"},
		{"en", "{{request.serviceDescription | capitalize}}", "Makerspace"},
		{"en", `{{request.approver | default("—")}}`, "—"},
		{"en", `{{request.number | default("—")}}`, "W-1"},
		{"en", `{{request.number | prefix("No. ")}}`, "No. W-1"},
		{"en", `{{request.approver | prefix("No. ")}}`, ""},
		{"en", `{{request.number | suffix(" h")}}`, "W-1 h"},
		{"en", `{{request.approver | suffix(" h")}}`, ""},
		{"en", "{{request.serviceDescription | truncate(5)}}", "make…"},
		{"en", `{{recipient.addressLines | join(" / ")}}`, "Samplegasse 1 / 8010 Graz"},
		{"en", "{{recipient.addressLines}}", "Samplegasse 1, 8010 Graz"},
		{"en", "{{items | count}}", "2"},
		{"en", `{{items | sum("amount") | currency}}`, "EUR 72.50"},
		{"de", `{{items | sum("quantity")}}`, "3,5"},
		{"en", "{{recipient.addressLines | first}}", "Samplegasse 1"},
		{"en", "{{recipient.addressLines | last}}", "8010 Graz"},
		{"en", "Request {{ request.number }} for {{recipient.organization}}.", "Request W-1 for Ex."},
	}
	for _, tc := range cases {
		ev, c := testEvaluator(KindWiRef, tc.locale, root)
		if got := ev.text("n", tc.text, nil); got != tc.want || len(c.messages) > 0 {
			t.Errorf("%s (%s) = %q %v, want %q", tc.text, tc.locale, got, c.messages, tc.want)
		}
	}
}

func TestAmountIsBlankForZeroOnlyInTheCashbook(t *testing.T) {
	root := Data{"totals": map[string]any{"in": decimal.Zero}}
	ev, _ := testEvaluator(KindCashbook, "de", root)
	if got := ev.text("n", "{{totals.in | amount}}|{{totals.in | number(2)}}", nil); got != "|0,00" {
		t.Fatalf("cashbook zero = %q", got)
	}
}

func TestInsertedValuesAreNeverEvaluatedAgain(t *testing.T) {
	root := Data{"request": map[string]any{"number": "{{request.approver}}", "approver": "secret"}}
	ev, c := testEvaluator(KindWiRef, "en", root)
	if got := ev.text("n", "{{request.number}}", nil); got != "{{request.approver}}" || len(c.messages) > 0 {
		t.Fatalf("got %q %v", got, c.messages)
	}
}

func TestExpressionProblems(t *testing.T) {
	cases := map[string]string{
		"{{request.nope}}":                  "Unknown variable",
		"{{request.number | shout}}":        "Unknown filter",
		"{{request.number":                  "not closed",
		"text }} more":                      "no matching",
		"{{ request.number | upper( }}":     "not a filter",
		`{{request.number | default}}`:      "takes 1 argument",
		`{{request.number | number(9)}}`:    "decimals",
		`{{request.number | truncate(0)}}`:  "characters",
		`{{request.number | prefix(x)}}`:    "quoted",
		`{{request.number | prefix("a)}}`:   "quote",
		"{{ 1 + 2 }}":                       "not a variable",
		"{{}}":                              "needs a variable",
		`{{items | sum("a b")}}`:            "sum",
		"{{index}}":                         "Unknown variable",
		"{{request.number | upper | lowr}}": "Unknown filter",
		`{{items | sum("price")}}`:          "not a field of items",
	}
	for text, fragment := range cases {
		ev, c := testEvaluator(KindWiRef, "en", SampleData(KindWiRef))
		got := ev.text("n", text, nil)
		if len(c.messages) == 0 || !strings.Contains(strings.Join(c.messages, "|"), fragment) {
			t.Errorf("%q: messages %v, want %q", text, c.messages, fragment)
		}
		if strings.Contains(text, "{{") && !strings.Contains(got, "{{") {
			t.Errorf("%q: a broken token should stay visible, got %q", text, got)
		}
	}
}

func TestLoopAliasesAndLocals(t *testing.T) {
	ev, c := testEvaluator(KindWiRef, "en", SampleData(KindWiRef))
	entries, canonical := ev.list("n", "items", nil)
	if canonical != "items" || len(entries) != 3 {
		t.Fatalf("list = %d %q", len(entries), canonical)
	}
	sc := (*scope)(nil).loop("item", canonical, entries[1], 2)
	if got := ev.text("n", "{{index}}. {{item.description}} {{item.amount | currency}}", sc); got != "2. Laser cutting, 3 mm plywood EUR 60.00" {
		t.Fatalf("got %q", got)
	}
	addressScope := (*scope)(nil).loop("line", "recipient.addressLines", "8010 Graz", 1)
	if got := ev.text("n", "{{line}}", addressScope); got != "8010 Graz" {
		t.Fatalf("text list alias = %q", got)
	}
	if len(c.messages) > 0 {
		t.Fatalf("unexpected problems %v", c.messages)
	}
}

func TestConditions(t *testing.T) {
	root := Data{"amounts": map[string]any{"alreadyPaid": decimal.RequireFromString("20"), "total": decimal.Zero},
		"request":   map[string]any{"number": "W-1", "approver": ""},
		"recipient": map[string]any{"addressLines": []string{}},
		"show":      map[string]any{"approver": true, "contactPerson": false},
	}
	ev, _ := testEvaluator(KindWiRef, "en", root)
	cases := []struct {
		cond Condition
		want bool
	}{
		{Condition{Path: "request.number", Op: OpExists}, true},
		{Condition{Path: "request.approver", Op: OpExists}, false},
		{Condition{Path: "request.approver", Op: OpEmpty}, true},
		{Condition{Path: "recipient.addressLines", Op: OpEmpty}, true},
		{Condition{Path: "amounts.total", Op: OpExists}, true},
		{Condition{Path: "amounts.alreadyPaid", Op: OpGt, Value: "0"}, true},
		{Condition{Path: "amounts.alreadyPaid", Op: OpLt, Value: "10"}, false},
		{Condition{Path: "request.number", Op: OpEq, Value: "W-1"}, true},
		{Condition{Path: "request.number", Op: OpNe, Value: "W-1"}, false},
		{Condition{Path: "show.approver", Op: OpEq, Value: "true"}, true},
		{Condition{Path: "show.contactPerson", Op: OpExists}, false},
	}
	for _, tc := range cases {
		if got := ev.test("n", &tc.cond, nil); got != tc.want {
			t.Errorf("%+v = %v", tc.cond, got)
		}
	}
}

func TestPermissionGatedFieldsAreRedacted(t *testing.T) {
	root := SampleData(KindReceipt)
	ev := newEvaluator(evalConfig{kind: KindReceipt, locale: "en", can: func(string) bool { return false }}, root)
	got := ev.text("n", `{{order.customer.matriculationNumber | default("x")}}|{{order.customer.name}}`, nil)
	if got != "|Marie Hofer" || !ev.redacted["order.customer.matriculationNumber"] {
		t.Fatalf("got %q redacted %v", got, ev.redacted)
	}
	if ev.test("n", &Condition{Path: "order.customer.matriculationNumber", Op: OpEq, Value: "12034567"}, nil) {
		t.Fatal("a condition must not see a redacted value")
	}
	allowed := newEvaluator(evalConfig{kind: KindReceipt, locale: "en", can: func(p string) bool {
		return p == permissionPeopleMatriculation
	}}, root)
	if got := allowed.text("n", "{{order.customer.matriculationNumber}}", nil); got != "12034567" {
		t.Fatalf("with permission = %q", got)
	}
}

func TestSumOfAGatedFieldIsRedacted(t *testing.T) {
	root := Data{"lines": []map[string]any{{"customer": "1"}, {"customer": "2"}}}
	ev := newEvaluator(evalConfig{kind: KindCashbook, locale: "de", can: func(string) bool { return false }}, root)
	if got := ev.text("n", `{{lines | sum("customer")}}`, nil); got != "" || !ev.redacted["lines[].customer"] {
		t.Fatalf("got %q redacted %v", got, ev.redacted)
	}
}
