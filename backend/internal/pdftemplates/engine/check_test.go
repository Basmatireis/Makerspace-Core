package engine

import "testing"

func TestBuiltinsHaveNoProblems(t *testing.T) {
	for _, kind := range Kinds {
		if problems := Check(Builtin(kind)); len(problems) > 0 {
			t.Fatalf("%s: %+v", kind, problems)
		}
	}
}

func TestCheckFindsProblems(t *testing.T) {
	doc := testDoc(KindWiRef,
		Block{ID: "unknown-var", Type: BlockText, Text: "{{request.nothing}}"},
		Block{ID: "unknown-filter", Type: BlockText, Text: "{{request.number | sparkle}}"},
		Block{ID: "malformed", Type: BlockText, Text: "{{request.number"},
		Block{ID: "unknown-list", Type: BlockRepeat, Source: "request.number", As: "x"},
		Block{ID: "missing-list", Type: BlockTable, Source: "lines", As: "line",
			Columns: []Column{{Header: "A", Value: "{{line.no}}", Width: ptr(1.0)}}},
		Block{ID: "style", Type: BlockText, Text: "x", TextStyle: "nope"},
		Block{ID: "colour", Type: BlockText, Text: "x", Color: "$c:nope"},
		Block{ID: "size", Type: BlockSpacer, Height: SizeRef("nope")},
		Block{ID: "picture", Type: BlockPicture, Asset: "not-a-uuid", W: ptr(10.0), H: ptr(10.0)},
		Block{ID: "graphic", Type: BlockGraphic, Art: "asset:nope", W: ptr(10.0), H: ptr(10.0)},
		Block{ID: "index-outside", Type: BlockText, Text: "{{index}}"},
		Block{ID: "page-in-body", Type: BlockText, Text: "{{page}}"},
		Block{ID: "compare", Type: BlockIf, When: &Condition{Path: "amounts.total", Op: OpGt, Value: "lots"}},
		Block{ID: "box", Type: BlockBox, Blocks: []Block{{ID: "nested-break", Type: BlockPageBreak}}},
		Block{ID: "loop", Type: BlockRepeat, Source: "items", As: "item", Blocks: []Block{
			{ID: "loop-text", Type: BlockText, Text: "{{index}} {{item.description}} {{item.nope}}"},
			{ID: "loop-break", Type: BlockPageBreak},
		}},
	)
	doc.Footer = []Block{{ID: "footer-sheet", Type: BlockSheet, Source: "items", As: "item"}}
	problems := Check(doc)
	expect := []struct{ id, severity, fragment string }{
		{"unknown-var", SeverityError, "Unknown variable"},
		{"unknown-filter", SeverityError, "Unknown filter"},
		{"malformed", SeverityError, "not closed"},
		{"unknown-list", SeverityError, "not a list"},
		{"missing-list", SeverityError, "Unknown variable “lines”"},
		{"style", SeverityError, "Unknown text style"},
		{"colour", SeverityError, "Unknown colour style"},
		{"size", SeverityError, "Unknown size style"},
		{"picture", SeverityError, "uploaded image"},
		{"graphic", SeverityError, "uploaded SVG"},
		{"index-outside", SeverityError, "Unknown variable"},
		{"page-in-body", SeverityWarning, "page number"},
		{"compare", SeverityError, "needs a number"},
		{"nested-break", SeverityWarning, "only works in the body"},
		{"loop-text", SeverityError, "item.nope"},
		{"footer-sheet", SeverityWarning, "only works in the body"},
	}
	for _, e := range expect {
		if !hasProblem(problems, e.id, e.severity, e.fragment) {
			t.Errorf("missing %s %s %q in %+v", e.id, e.severity, e.fragment, problems)
		}
	}
	if hasProblem(problems, "loop-text", SeverityError, "index") || hasProblem(problems, "loop-break", SeverityWarning, "") {
		t.Errorf("a loop in the body knows index and takes page breaks: %+v", problems)
	}
	if !HasErrors(problems) {
		t.Fatal("HasErrors")
	}
}

func TestSchemaListsFieldsWithExamplesAndPermissions(t *testing.T) {
	info := Schema(KindCashbook)
	if len(info.Filters) != len(filterArity) {
		t.Fatalf("filters %d, arity %d", len(info.Filters), len(filterArity))
	}
	for _, f := range info.Filters {
		if _, ok := filterArity[f.Name]; !ok || f.Description == "" {
			t.Fatalf("filter %+v", f)
		}
	}
	fields := map[string]Field{}
	for _, g := range info.Groups {
		for _, f := range g.Fields {
			if f.Description == "" {
				t.Errorf("%s has no description", f.Path)
			}
			fields[f.Path] = f
		}
	}
	if f := fields["lines[].customer"]; f.Permission != permissionOrdersRead || f.Example != "Ada Brandl" {
		t.Fatalf("customer %+v", f)
	}
	if f := fields["totals.opening"]; f.Example != "182,35 €" || f.Type != FieldMoney {
		t.Fatalf("opening %+v", f)
	}
	if f := fields["period.from"]; f.Example != "01.10.2026" {
		t.Fatalf("period.from %+v", f)
	}
	receipt := map[string]Field{}
	for _, g := range Schema(KindReceipt).Groups {
		for _, f := range g.Fields {
			receipt[f.Path] = f
		}
	}
	if receipt["order.customer.matriculationNumber"].Permission != permissionPeopleMatriculation {
		t.Fatal("matriculation numbers need their permission")
	}
	wiref := Schema(KindWiRef)
	if len(wiref.Groups) == 0 || wiref.Groups[len(wiref.Groups)-1].Name != commonGroup.name {
		t.Fatal("the always-available group comes last")
	}
}

func TestParseKind(t *testing.T) {
	for _, kind := range Kinds {
		if got, ok := ParseKind(string(kind)); !ok || got != kind {
			t.Fatalf("%s", kind)
		}
	}
	if _, ok := ParseKind("invoice"); ok {
		t.Fatal("unknown kind accepted")
	}
}
