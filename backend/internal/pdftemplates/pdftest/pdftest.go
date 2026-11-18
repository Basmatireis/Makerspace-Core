// Package pdftest holds test helpers for the packages that build template data.
package pdftest

import (
	"sort"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/engine"
)

// commonRoots are the always-available values the renderer adds itself; builders do not supply them.
var commonRoots = map[string]bool{"makerspace": true, "generatedAt": true, "page": true, "pages": true, "sheet": true}

// optionalRoots are variables that exist only for some renderings: the receipt of one payment sets payment.*, the
// receipt of a whole order leaves it out.
var optionalRoots = map[engine.Kind]map[string]bool{engine.KindReceipt: {"payment": true}}

// Reporter is the part of testing.T the helper uses, so the helper itself can be tested.
type Reporter interface {
	Helper()
	Errorf(format string, args ...any)
}

// AssertData fails when data does not match the schema of the export exactly: every variable of the schema must
// resolve in data (a list through its first entry, so lists must not be empty) and data must not contain keys the
// schema does not know.
func AssertData(t Reporter, kind engine.Kind, data engine.Data) {
	t.Helper()
	known := map[string]bool{}
	for _, group := range engine.Schema(kind).Groups {
		for _, field := range group.Fields {
			known[field.Path] = true
			root := strings.SplitN(strings.SplitN(field.Path, ".", 2)[0], "[", 2)[0]
			if commonRoots[root] || optionalRoots[kind][root] {
				continue
			}
			if !resolves(data, strings.Split(field.Path, ".")) {
				t.Errorf("schema path %q does not resolve in the %s data", field.Path, kind)
			}
		}
	}
	var unknown []string
	walk(data, "", func(path string) {
		if !known[path] {
			unknown = append(unknown, path)
		}
	})
	sort.Strings(unknown)
	for _, path := range unknown {
		t.Errorf("the %s data has the key %q, which the schema does not know", kind, path)
	}
}

// resolves follows the segments of a schema path; "x[]" steps into the first entry of the list x.
func resolves(value any, segments []string) bool {
	if len(segments) == 0 {
		return true
	}
	name, isList := strings.CutSuffix(segments[0], "[]")
	object, ok := value.(map[string]any)
	if !ok {
		return false
	}
	next, present := object[name]
	if !present {
		return false
	}
	if !isList {
		return resolves(next, segments[1:])
	}
	switch list := next.(type) {
	case []map[string]any:
		return len(list) > 0 && resolves(list[0], segments[1:])
	case []any:
		return len(list) > 0 && resolves(list[0], segments[1:])
	}
	return false
}

// walk reports the path of every leaf of data; lists of objects add "[]" to the path of their entries, other
// values (including lists of text) are leaves.
func walk(value any, prefix string, report func(path string)) {
	switch object := value.(type) {
	case map[string]any:
		for key, child := range object {
			path := key
			if prefix != "" {
				path = prefix + "." + key
			}
			walk(child, path, report)
		}
	case []map[string]any:
		if len(object) == 0 {
			report(prefix)
		}
		for _, entry := range object {
			walk(entry, prefix+"[]", report)
		}
	default:
		report(prefix)
	}
}
