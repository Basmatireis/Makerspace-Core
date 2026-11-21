package engine

import (
	"embed"
	"fmt"
)

// The built-in templates are in effect while an export has no published version. The wiRef and cashbook defaults
// reproduce the documents of release 0.19 (invoicing/pdf.go and the HTU Kassabuch form of orders/cashbook_pdf.go,
// with its geometry); the receipt is new; the Projektantrag reproduces the form, advance request, cost plan and
// planned purchases that workinggroups drew directly before, as one document.
//
//go:embed builtin/*.json
var builtinFiles embed.FS

// Builtin returns a fresh copy of the built-in template of an export, so callers may change it.
func Builtin(kind Kind) Document {
	raw, err := builtinFiles.ReadFile("builtin/" + string(kind) + ".json")
	if err != nil {
		panic(fmt.Sprintf("engine: no built-in template for %q", kind))
	}
	doc, err := Decode(raw)
	if err != nil {
		// The files are tested to decode; a failure here is a defect of this package.
		panic(fmt.Sprintf("engine: built-in template %q does not decode: %v", kind, err))
	}
	return doc
}
