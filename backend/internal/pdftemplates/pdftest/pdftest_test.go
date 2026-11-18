package pdftest

import (
	"fmt"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/engine"
)

type recorder struct{ messages []string }

func (r *recorder) Helper() {}
func (r *recorder) Errorf(f string, args ...any) {
	r.messages = append(r.messages, fmt.Sprintf(f, args...))
}

func TestSampleDataMatchesItsSchema(t *testing.T) {
	for _, kind := range engine.Kinds {
		AssertData(t, kind, engine.SampleData(kind))
	}
}

func TestAssertDataReportsMissingAndUnknownKeys(t *testing.T) {
	data := engine.SampleData(engine.KindReceipt)
	delete(data["order"].(map[string]any), "total")
	data["extra"] = map[string]any{"value": "x"}
	data["items"].([]map[string]any)[0]["surprise"] = "y"
	var r recorder
	AssertData(&r, engine.KindReceipt, data)
	want := map[string]bool{
		`schema path "order.total" does not resolve in the receipt data`:                  true,
		`the receipt data has the key "extra.value", which the schema does not know`:      true,
		`the receipt data has the key "items[].surprise", which the schema does not know`: true,
	}
	if len(r.messages) != len(want) {
		t.Fatalf("messages %q", r.messages)
	}
	for _, m := range r.messages {
		if !want[m] {
			t.Errorf("unexpected message %q", m)
		}
	}
}
