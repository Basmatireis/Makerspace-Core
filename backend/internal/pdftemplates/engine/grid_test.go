package engine

import (
	"fmt"
	"math"
	"slices"
	"strings"
	"testing"
)

func testGrid(id string) Block {
	return Block{ID: id, Type: BlockGrid, ColWidths: []float64{40, 30}, Rows: []FieldRow{
		{Height: Num(8), Cells: []GridCell{{Text: "Title {{order.number}}", Span: 2, Align: "center", Weight: 600}}},
		{Height: Num(5), Cells: []GridCell{
			{Text: "Customer", VAlign: "top"},
			{Text: "{{order.customer.name}}", Align: "right", Fill: "#eeeeee"},
		}},
		{Height: Num(2), Cells: []GridCell{{Text: "A long text that needs several lines in a narrow cell", VAlign: "bottom"}}},
	}}
}

func TestGridRendersAsOneUnbreakableBox(t *testing.T) {
	doc := testDoc(KindReceipt, testGrid("grid"), Block{ID: "after", Type: BlockText, Text: "After"})
	res := render(t, RenderInput{Doc: doc, Data: SampleData(KindReceipt), Can: allowAll})
	if len(res.Problems) > 0 {
		t.Fatalf("problems %+v", res.Problems)
	}
	boxes := boxesOf(res, "grid")
	if len(boxes) != 1 || boxes[0].X != 20 || boxes[0].Y != 30 || boxes[0].W != 70 {
		t.Fatalf("grid box %+v", boxes)
	}
	// The third row grows from 2 mm to fit three or more lines; a grid abuts the next block.
	if boxes[0].H < 8+5+8 {
		t.Fatalf("rows did not grow with their content: %+v", boxes[0])
	}
	if after := boxesOf(res, "after")[0]; math.Abs(after.Y-(boxes[0].Y+boxes[0].H)) > 0.01 {
		t.Fatalf("after %+v grid %+v", after, boxes[0])
	}
	text := pageTexts(t, res.PDF)[0]
	for _, want := range []string{"TitleO-2026-000311", "Customer", "MarieHofer", "Alongtext"} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in %q", want, text)
		}
	}
}

func TestGridInALayerTakesItsWidthFromItsColumns(t *testing.T) {
	grid := testGrid("grid")
	grid.X, grid.Y = ptr(15.0), ptr(100.0)
	doc := testDoc(KindReceipt)
	doc.Layers = []Layer{{ID: "layer", Type: "layer", Pages: LayerAllPages, Elements: []Block{grid}}}
	raw, err := Encode(doc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Decode(raw); err != nil {
		t.Fatalf("a grid in a layer needs no w: %v %s", err, violations(err))
	}
	res := render(t, RenderInput{Doc: doc, Data: SampleData(KindReceipt), Can: allowAll})
	if b := boxesOf(res, "grid"); len(b) != 1 || b[0].X != 15 || b[0].Y != 100 || b[0].W != 70 {
		t.Fatalf("boxes %+v", b)
	}
}

func TestGridTextIsPlacedByCapitals(t *testing.T) {
	r := newRenderer(t.Context(), RenderInput{Doc: testDoc(KindReceipt)})
	st := r.defaults(textDefaults{size: 10})
	cell := gridCellLayout{lines: []string{"A"}, st: st, valign: "middle"}
	if got, want := gridTextExtent(cell), st.capHeight(); math.Abs(got-want) > 1e-9 {
		t.Fatalf("extent %v, want %v", got, want)
	}
	cell.lines = []string{"A", "B", "C"}
	if got, want := gridTextExtent(cell), st.capHeight()+2*st.pitch(); math.Abs(got-want) > 1e-9 {
		t.Fatalf("extent of three lines %v, want %v", got, want)
	}
}

func TestDecodeGrid(t *testing.T) {
	grid := func(change func(m map[string]any)) []byte {
		return mutate(t, KindReceipt, func(doc map[string]any) {
			m := map[string]any{
				"id": "g", "type": "grid", "colWidths": []any{10, 20},
				"rows": []any{map[string]any{"height": 5, "cells": []any{
					map[string]any{"text": "a", "span": 1}, map[string]any{"text": "b", "valign": "bottom"},
				}}},
			}
			change(m)
			doc["body"] = append(body(doc), m)
		})
	}
	if _, err := Decode(grid(func(map[string]any) {})); err != nil {
		t.Fatalf("valid grid: %v %s", err, violations(err))
	}
	cells := func(m map[string]any) []any { return m["rows"].([]any)[0].(map[string]any)["cells"].([]any) }
	invalid := map[string]func(m map[string]any){
		"no columns":         func(m map[string]any) { m["colWidths"] = []any{} },
		"zero column":        func(m map[string]any) { m["colWidths"] = []any{0, 10} },
		"too many columns":   func(m map[string]any) { m["colWidths"] = slices.Repeat([]any{1}, maxGridColumns+1) },
		"no rows":            func(m map[string]any) { m["rows"] = []any{} },
		"row without height": func(m map[string]any) { delete(m["rows"].([]any)[0].(map[string]any), "height") },
		"unknown row property": func(m map[string]any) {
			m["rows"].([]any)[0].(map[string]any)["label"] = "x"
		},
		"unknown cell property": func(m map[string]any) { cells(m)[0].(map[string]any)["value"] = "x" },
		"bad valign":            func(m map[string]any) { cells(m)[0].(map[string]any)["valign"] = "baseline" },
		"spans too wide":        func(m map[string]any) { cells(m)[0].(map[string]any)["span"] = 2 },
		"zero span":             func(m map[string]any) { cells(m)[0].(map[string]any)["span"] = 0 },
		"fields property":       func(m map[string]any) { m["labelWidth"] = 10 },
	}
	for name, change := range invalid {
		if _, err := Decode(grid(change)); errorCode(err) != CodeInvalid {
			t.Errorf("%s: %v", name, err)
		}
	}
	rows := make([]any, maxGridRows+1)
	for i := range rows {
		rows[i] = map[string]any{"height": 1}
	}
	if _, err := Decode(grid(func(m map[string]any) { m["rows"] = rows })); errorCode(err) != CodeInvalid {
		t.Errorf("too many rows: %v", err)
	}
}

func TestCheckGridCells(t *testing.T) {
	grid := Block{ID: "g", Type: BlockGrid, ColWidths: []float64{10}, Rows: []FieldRow{{
		Height: SizeRef("nope"),
		Cells:  []GridCell{{Text: "{{order.nothing}}", TextStyle: "missing", Fill: "$c:missing", Size: SizeRef("gone")}},
	}}}
	problems := Check(testDoc(KindReceipt, grid))
	for _, fragment := range []string{"Unknown variable", "Unknown text style", "Unknown colour style", "“nope”", "“gone”"} {
		if !hasProblem(problems, "g", SeverityError, fragment) {
			t.Errorf("missing %q in %+v", fragment, problems)
		}
	}
}

func TestBuiltinArts(t *testing.T) {
	arts := Arts()
	if len(arts) != len(artOrder) {
		t.Fatalf("arts %+v", arts)
	}
	for _, a := range arts {
		if a.Width <= 0 || a.Height <= 0 || a.X < 0 || a.Y < 0 || a.X+a.Width > 210 || a.Y+a.Height > 297 {
			t.Errorf("%+v is outside the page", a)
		}
		if a.ID != ArtLetterhead && a.Width*a.Height > 210*297/4 {
			t.Errorf("%s covers too much of the page: %+v", a.ID, a)
		}
	}
	all, err := builtinArts()
	if err != nil {
		t.Fatal(err)
	}
	parts := 0
	for _, id := range []string{ArtLogo, ArtCornerTop, ArtCornerBottom, ArtFooter} {
		parts += strings.Count(opsString(all[id].ops), "F")
	}
	if whole := strings.Count(opsString(all[ArtLetterhead].ops), "F"); parts != whole || whole == 0 {
		t.Fatalf("the parts have %d shapes, the letterhead %d", parts, whole)
	}
	// Stored templates may still use the whole letterhead; unknown names are refused.
	for art, ok := range map[string]bool{ArtLetterhead: true, ArtFooter: true, "htu-unknown": false} {
		raw, _ := Encode(testDoc(KindCashbook, Block{ID: "a", Type: BlockGraphic, Art: art, W: ptr(10.0), H: ptr(10.0)}))
		if _, err := Decode(raw); (err == nil) != ok {
			t.Errorf("art %s: %v", art, err)
		}
	}
}

func opsString(ops []pathOp) string {
	var b strings.Builder
	for _, o := range ops {
		b.WriteByte(o.op)
	}
	return b.String()
}

// nodes lists every block of a document with whether it can draw (page breaks never do).
func nodes(doc Document) []*Block {
	var out []*Block
	var visit func(blocks []Block)
	visit = func(blocks []Block) {
		for i := range blocks {
			out = append(out, &blocks[i])
			for _, children := range blocks[i].children() {
				visit(children)
			}
		}
	}
	for _, layer := range doc.Layers {
		visit(layer.Elements)
	}
	visit(doc.Header)
	visit(doc.Body)
	visit(doc.Footer)
	return out
}

func TestBuiltinsAreEditable(t *testing.T) {
	inactive := map[Kind]string{
		KindWiRef:    "[]",
		KindCashbook: "[sheets-all-payments]",
		KindReceipt:  "[single-payment single-payment-note]",
	}
	for _, kind := range Kinds {
		doc := Builtin(kind)
		for _, layer := range doc.Layers {
			if layer.Title == "" {
				t.Errorf("%s: layer %s has no title", kind, layer.ID)
			}
		}
		// Without a logo, so the logo block must still have its box.
		res := render(t, RenderInput{Doc: doc, Data: SampleData(kind), Can: allowAll, Branding: SampleBranding()})
		if got := fmt.Sprint(res.Inactive); got != inactive[kind] {
			t.Errorf("%s: inactive %s, want %s", kind, got, inactive[kind])
		}
		size := pageSize(doc.Page)
		bodyW := size.Width - doc.Page.Margins[1] - doc.Page.Margins[3]
		bodyH := size.Height - doc.Page.Margins[0] - doc.Page.Margins[2]
		for _, b := range nodes(doc) {
			if strings.TrimSpace(b.Title) == "" {
				t.Errorf("%s: node %s has no title", kind, b.ID)
			}
			if b.Type == BlockPageBreak || slices.Contains(res.Inactive, b.ID) {
				continue
			}
			if len(boxesOf(res, b.ID)) == 0 {
				t.Errorf("%s: node %s (%s) is drawn without a box", kind, b.ID, b.Type)
			}
		}
		for _, box := range res.Boxes {
			if box.W > bodyW+0.01 || box.H > bodyH+0.01 || box.W <= 0 || box.H <= 0 {
				t.Errorf("%s: box %+v is empty or larger than the page body (%.2f × %.2f)", kind, box, bodyW, bodyH)
			}
		}
		for _, layer := range doc.Layers {
			if len(boxesOf(res, layer.ID)) > 0 {
				t.Errorf("%s: layer %s has a box", kind, layer.ID)
			}
		}
	}
}

func TestWiRefDefaultHasNoSettingsConditions(t *testing.T) {
	raw, err := Encode(Builtin(KindWiRef))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "show.") {
		t.Fatal("the wiRef data already leaves out what the settings switch off")
	}
}
