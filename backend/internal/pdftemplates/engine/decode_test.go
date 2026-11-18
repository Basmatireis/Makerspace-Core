package engine

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

// mutate decodes a built-in template as generic JSON, applies change and encodes it again.
func mutate(t *testing.T, kind Kind, change func(doc map[string]any)) []byte {
	t.Helper()
	raw, err := Encode(Builtin(kind))
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	change(doc)
	out, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func body(doc map[string]any) []any { return doc["body"].([]any) }

func violations(err error) string {
	var appErr *apperror.Error
	if !errors.As(err, &appErr) {
		return ""
	}
	raw, _ := json.Marshal(appErr.Details["violations"])
	return string(raw)
}

func TestBuiltinsDecodeAndRoundTrip(t *testing.T) {
	for _, kind := range Kinds {
		doc := Builtin(kind)
		if doc.Export != kind || doc.SchemaVersion != SchemaVersion {
			t.Fatalf("%s: export %q version %d", kind, doc.Export, doc.SchemaVersion)
		}
		raw, err := Encode(doc)
		if err != nil {
			t.Fatal(err)
		}
		again, err := Decode(raw)
		if err != nil {
			t.Fatalf("%s: %v %s", kind, err, violations(err))
		}
		// Empty optional lists are left out when encoding, so the encodings are compared.
		if second, _ := Encode(again); !reflect.DeepEqual(raw, second) {
			t.Fatalf("%s: round trip changed the document", kind)
		}
	}
}

func TestDecodeRejectsStructuralErrors(t *testing.T) {
	cases := map[string]func(doc map[string]any){
		"unknown top-level property": func(doc map[string]any) { doc["extra"] = 1 },
		"unknown page property":      func(doc map[string]any) { doc["page"].(map[string]any)["zoom"] = 2 },
		"unknown block property": func(doc map[string]any) {
			body(doc)[0].(map[string]any)["rows"] = []any{}
		},
		"unknown column property": func(doc map[string]any) {
			findBlock(doc, "items")["columns"].([]any)[0].(map[string]any)["x"] = 1
		},
		"unknown block type":  func(doc map[string]any) { body(doc)[0].(map[string]any)["type"] = "marquee" },
		"duplicate id":        func(doc map[string]any) { body(doc)[1].(map[string]any)["id"] = "title" },
		"malformed id":        func(doc map[string]any) { body(doc)[0].(map[string]any)["id"] = "a b" },
		"wrong schemaVersion": func(doc map[string]any) { doc["schemaVersion"] = 2 },
		"unknown export":      func(doc map[string]any) { doc["export"] = "invoice" },
		"bad colour":          func(doc map[string]any) { doc["page"].(map[string]any)["accent"] = "red" },
		"bad length":          func(doc map[string]any) { body(doc)[2].(map[string]any)["height"] = "$x:gap" },
		"weight out of set":   func(doc map[string]any) { body(doc)[0].(map[string]any)["weight"] = 700 },
		"margin out of range": func(doc map[string]any) { doc["page"].(map[string]any)["margins"] = []any{0, 0, 0, 500} },
		"three margins":       func(doc map[string]any) { doc["page"].(map[string]any)["margins"] = []any{0, 0, 0} },
		"custom without size": func(doc map[string]any) { doc["page"].(map[string]any)["size"] = "custom" },
		"width without custom": func(doc map[string]any) {
			doc["page"].(map[string]any)["width"] = 100
		},
		"missing table source": func(doc map[string]any) { delete(findBlock(doc, "items"), "source") },
		"bad loop name":        func(doc map[string]any) { findBlock(doc, "items")["as"] = "page" },
		"zero width share": func(doc map[string]any) {
			findBlock(doc, "items")["columns"].([]any)[0].(map[string]any)["width"] = 0
		},
		"bad condition op": func(doc map[string]any) {
			findBlock(doc, "contact-shown")["when"] = map[string]any{"path": "show.approver", "op": "like"}
		},
		"layer element without position": func(doc map[string]any) {
			doc["layers"] = []any{map[string]any{"id": "l", "type": "layer", "pages": "all", "elements": []any{
				map[string]any{"id": "p", "type": "ptext", "text": "x", "w": 10},
			}}}
		},
		"sized block without height": func(doc map[string]any) {
			doc["body"] = append(body(doc), map[string]any{"id": "q", "type": "qr", "value": "x", "w": 10})
		},
		"too many flow columns": func(doc map[string]any) {
			col := map[string]any{"width": 1, "blocks": []any{}}
			doc["body"] = append(body(doc), map[string]any{"id": "c", "type": "columns", "columns": []any{col, col, col, col, col}})
		},
		"not json": nil,
	}
	for name, change := range cases {
		raw := []byte("{")
		if change != nil {
			raw = mutate(t, KindWiRef, change)
		}
		_, err := Decode(raw)
		if errorCode(err) != CodeInvalid {
			t.Errorf("%s: err %v (%s), want %s", name, err, errorCode(err), CodeInvalid)
		}
	}
}

func findBlock(doc map[string]any, id string) map[string]any {
	var found map[string]any
	var visit func(v any)
	visit = func(v any) {
		switch x := v.(type) {
		case map[string]any:
			if x["id"] == id && found == nil {
				found = x
			}
			for _, child := range x {
				visit(child)
			}
		case []any:
			for _, child := range x {
				visit(child)
			}
		}
	}
	visit(doc)
	return found
}

func TestDecodeReportsViolationPaths(t *testing.T) {
	raw := mutate(t, KindWiRef, func(doc map[string]any) { body(doc)[0].(map[string]any)["bogus"] = true })
	_, err := Decode(raw)
	if !strings.Contains(violations(err), "body[0].bogus") {
		t.Fatalf("violations %s", violations(err))
	}
}

func TestDecodeLimits(t *testing.T) {
	spacer := func(i int) any { return map[string]any{"id": fmt.Sprintf("s%d", i), "type": "spacer", "height": 1} }
	nest := func(depth int) any {
		var inner any = map[string]any{"id": "leaf", "type": "spacer"}
		for i := range depth {
			inner = map[string]any{"id": fmt.Sprintf("box%d", i), "type": "box", "blocks": []any{inner}}
		}
		return inner
	}
	cases := map[string]func(doc map[string]any){
		"too many nodes": func(doc map[string]any) {
			list := []any{}
			for i := range MaxNodes + 1 {
				list = append(list, spacer(i))
			}
			doc["body"] = list
		},
		"too deep": func(doc map[string]any) { doc["body"] = []any{nest(MaxDepth + 1)} },
		"long text": func(doc map[string]any) {
			body(doc)[1].(map[string]any)["text"] = strings.Repeat("ä", MaxTextLength+1)
		},
		"long name": func(doc map[string]any) { doc["name"] = strings.Repeat("n", MaxNameLength+1) },
		"many colours": func(doc map[string]any) {
			list := []any{}
			for i := range MaxStyles + 1 {
				list = append(list, map[string]any{"id": fmt.Sprintf("c%d", i), "name": "c", "value": "#000000"})
			}
			doc["styles"].(map[string]any)["colors"] = list
		},
		"long filename": func(doc map[string]any) {
			doc["page"].(map[string]any)["filename"] = strings.Repeat("f", MaxFilenameLength+1)
		},
	}
	for name, change := range cases {
		_, err := Decode(mutate(t, KindWiRef, change))
		if errorCode(err) != CodeTooLarge {
			t.Errorf("%s: err %v (%s), want %s", name, err, errorCode(err), CodeTooLarge)
		}
	}
	big := append([]byte(`{"name":"`), []byte(strings.Repeat("x", MaxDocumentBytes))...)
	if _, err := Decode(big); errorCode(err) != CodeTooLarge {
		t.Fatalf("oversized document: %v", err)
	}
	// Exactly at the limits is fine.
	ok := mutate(t, KindWiRef, func(doc map[string]any) {
		doc["body"] = []any{nest(MaxDepth - 1)}
		doc["name"] = strings.Repeat("n", MaxNameLength)
	})
	if _, err := Decode(ok); err != nil {
		t.Fatalf("at the limits: %v %s", err, violations(err))
	}
}
