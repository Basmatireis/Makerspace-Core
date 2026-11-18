package orders

import (
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/engine"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/pdftest"
	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

func sampleReceiptOrder() (Order, []receiptPayment) {
	name := "Marie Hofer"
	removed := time.Now()
	order := Order{
		Reference:         "O-2026-000311",
		CustomerKind:      CustomerPerson,
		CustomerName:      &name,
		CreatedAt:         time.Date(2026, 10, 8, 14, 2, 0, 0, time.UTC),
		OutstandingAmount: "0.00",
		Items: []OrderItem{
			{
				Description: "FDM 3D printing", Quantity: "2.23", Unit: "h", UnitPrice: "4.00", Amount: "8.92",
				Snapshot: &JobChargeSnapshot{MachineName: "Sample printer", DurationNanoseconds: "8040000000000"},
			},
			{Description: "Plywood", Quantity: "1", Unit: "piece", UnitPrice: "3.88", Amount: "3.88"},
			{Description: "Removed", Quantity: "1", Unit: "pc", UnitPrice: "99", Amount: "99", RemovedAt: &removed},
		},
	}
	payments := []receiptPayment{
		{
			id: uuid.New(), reference: "P-2026-000818", method: "cash", amount: decimal.RequireFromString("10"),
			occurredAt: time.Date(2026, 10, 8, 14, 10, 0, 0, time.UTC),
		},
		{
			id: uuid.New(), reference: "P-2026-000819", method: "card", amount: decimal.RequireFromString("2.80"),
			occurredAt: time.Date(2026, 10, 9, 9, 0, 0, 0, time.UTC),
		},
	}
	return order, payments
}

func TestReceiptDataMatchesTheSchema(t *testing.T) {
	order, payments := sampleReceiptOrder()
	pdftest.AssertData(t, engine.KindReceipt, receiptData(order, payments, nil, "12034567"))
	pdftest.AssertData(t, engine.KindReceipt, receiptData(order, payments, &payments[1], "12034567"))
}

func TestReceiptDataSumsTheItemsThatCountAndThePaymentsShown(t *testing.T) {
	order, payments := sampleReceiptOrder()
	data := receiptData(order, payments, nil, "")
	summary := data["order"].(map[string]any)
	if !summary["total"].(decimal.Decimal).Equal(decimal.RequireFromString("12.80")) ||
		!summary["paid"].(decimal.Decimal).Equal(decimal.RequireFromString("12.80")) {
		t.Fatalf("order %+v", summary)
	}
	items := data["items"].([]map[string]any)
	if len(items) != 2 || items[0]["detail"] != "Sample printer · 2 h 14 min" || items[1]["unit"] != "pcs" {
		t.Fatalf("items %+v", items)
	}
	if data["payment"].(map[string]any)["reference"] != "" || len(data["payments"].([]map[string]any)) != 2 {
		t.Fatalf("payments %+v / %+v", data["payment"], data["payments"])
	}
	single := receiptData(order, payments, &payments[1], "")
	if single["payment"].(map[string]any)["reference"] != "P-2026-000819" ||
		single["payment"].(map[string]any)["method"] != "Card" ||
		!single["order"].(map[string]any)["paid"].(decimal.Decimal).Equal(decimal.RequireFromString("2.80")) {
		t.Fatalf("single %+v", single)
	}
}

func receiptPages(t *testing.T, data engine.Data, can func(string) bool) string {
	t.Helper()
	pdf, _, err := pdftemplates.BuiltinRenderer{}.RenderEffective(t.Context(), engine.KindReceipt, data, can)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Join(strings.Fields(strings.Join(pdfPages(t, pdf), "")), "")
}

func TestReceiptPDFShowsTheMatriculationNumberOnlyWithItsPermission(t *testing.T) {
	order, payments := sampleReceiptOrder()
	data := receiptData(order, payments, nil, "12034567")
	// The built-in receipt does not print the number, so a template that does is simulated through the schema:
	// the renderer must redact it for a reader without the permission.
	doc := engine.Builtin(engine.KindReceipt)
	doc.Body = append(doc.Body, engine.Block{
		ID: "matriculation", Type: engine.BlockText, Text: "Number {{order.customer.matriculationNumber}}",
	})
	for _, c := range []struct {
		can     bool
		want    string
		redacts bool
	}{{true, "Number12034567", false}, {false, "Number", true}} {
		result, err := engine.Render(t.Context(), engine.RenderInput{
			Doc: doc, Data: data, Branding: engine.SampleBranding(), Now: engine.SampleNow(),
			Can: func(permission string) bool {
				return c.can || permission != string(authorization.PeopleReadMatriculation)
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		text := strings.Join(pdfPages(t, result.PDF), "")
		text = strings.Join(strings.Fields(text), "")
		if !strings.Contains(text, c.want) || (!c.can && strings.Contains(text, "12034567")) ||
			(len(result.Redacted) > 0) != c.redacts {
			t.Errorf("can=%v: %q redacted=%v", c.can, text, result.Redacted)
		}
	}
	if text := receiptPages(t, data, func(string) bool { return true }); !strings.Contains(text, "MarieHofer") ||
		!strings.Contains(text, "P-2026-000818") || !strings.Contains(text, "O-2026-000311") {
		t.Errorf("receipt text %q", text)
	}
}
