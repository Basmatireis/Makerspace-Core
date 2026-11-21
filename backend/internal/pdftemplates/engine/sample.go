package engine

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"time"

	"github.com/shopspring/decimal"
)

// The sample data is fictitious: names, numbers and organizations are made up for previews and examples.

var sampleNow = time.Date(2026, 11, 18, 10, 24, 0, 0, time.UTC)

var sampleBranding = Branding{
	Name:        "Studienlabor Makerspace",
	DisplayName: "Makerspace Core",
	Address:     "Samplegasse 25, 8010 Graz",
}

// SampleNow is the fixed time of sample renderings, so a preview of the same template is stable.
func SampleNow() time.Time { return sampleNow }

// SampleBranding is the branding of sample renderings when the caller has none.
func SampleBranding() Branding { return sampleBranding }

func money(value string) decimal.Decimal { return decimal.RequireFromString(value) }

// SampleData is fictitious data of an export for previews and the variable examples.
func SampleData(kind Kind) Data {
	switch kind {
	case KindWiRef:
		return sampleWiRef()
	case KindCashbook:
		return sampleCashbook()
	case KindReceipt:
		return sampleReceipt()
	case KindProjektantrag:
		return sampleProjektantrag()
	}
	return Data{}
}

func sampleWiRef() Data {
	return Data{
		"request": map[string]any{
			"number":             "W-2026-000123",
			"orderNumber":        "O-2026-000456",
			"approvedAt":         sampleNow,
			"approver":           "Sam Approver",
			"servicePeriod":      map[string]any{"from": "2026-10-01", "to": "2026-10-15"},
			"serviceDescription": "Prototype parts for the sample project.",
		},
		"recipient": map[string]any{
			"organization":           "Example University, Institute of Sample Studies",
			"addressLines":           []string{"Samplegasse 1", "8010 Graz", "AT"},
			"contactName":            "Alex Example",
			"contactChannel":         "alex.example@example.org",
			"purchaseOrderReference": "PO-2026-0042",
		},
		"amounts": map[string]any{"total": money("81.50"), "alreadyPaid": money("0"), "toInvoice": money("81.50")},
		"texts": map[string]any{
			"title": "Invoice request W-2026-000123",
			"intro": "Please invoice Example University, Institute of Sample Studies for the services listed below.",
			"closing": "Approved on 18.11.2026. This document was generated automatically and carries no " +
				"signature.",
		},
		"show": map[string]any{
			"contactPerson": "true", "approver": "true", "purchaseOrder": "true", "servicePeriod": "true",
			"serviceDescription": "true",
		},
		"items": []map[string]any{
			sampleItem("3D print, PLA, 120 g", "", "1", "pc", "12.00", "12.00"),
			sampleItem("Laser cutting, 3 mm plywood", "", "2.5", "h", "24.00", "60.00"),
			sampleItem("Material: plywood sheet", "", "1", "pc", "9.50", "9.50"),
		},
		"payments": []map[string]any{
			{"reference": "P-2026-000789", "method": "wiRef invoice", "paidAt": sampleNow, "amount": money("81.50")},
		},
	}
}

func sampleItem(description, detail, quantity, unit, unitPrice, amount string) map[string]any {
	item := map[string]any{
		"description": description,
		"quantity":    money(quantity),
		"unit":        unit,
		"unitPrice":   money(unitPrice),
		"amount":      money(amount),
	}
	if detail != "" {
		item["detail"] = detail
	}
	return item
}

type sampleCashLine struct {
	date, cashier, kind, order, summary, customer string
	in, out                                       string
}

func sampleCashbook() Data {
	rows := []sampleCashLine{
		{"2026-10-01", "Lena Huber", "receipt", "O-2026-000301", "FDM 3D printing und Material", "Ada Brandl", "12.40", "0"},
		{"2026-10-01", "Lena Huber", "receipt", "O-2026-000302", "Laser cutting und Material", "Jonas Pichler", "18.00", "0"},
		{"2026-10-02", "Max Steiner", "withdrawal", "", "Entnahme · Tresor", "", "0", "50.00"},
		{"2026-10-03", "Max Steiner", "receipt", "O-2026-000305", "Filament", "Sophie Wagner", "22.50", "0"},
		{"2026-10-06", "Lena Huber", "receipt", "O-2026-000309", "Resin 3D printing", "Lukas Gruber", "9.80", "0"},
		{"2026-10-07", "Jürgen Weiß", "refund", "O-2026-000302", "Laser cutting und Material", "Jonas Pichler", "0", "6.00"},
		{
			"2026-10-08", "Jürgen Weiß", "receipt", "O-2026-000311", "FDM 3D printing, Laser cutting und Material",
			"Marie Hofer", "31.20", "0",
		},
		{"2026-10-09", "Lena Huber", "deposit", "", "Einlage · Wechselgeld", "", "100.00", "0"},
		{"2026-10-10", "Max Steiner", "receipt", "O-2026-000314", "Parts", "Felix Bauer", "4.50", "0"},
		{"2026-10-13", "Lena Huber", "receipt", "O-2026-000318", "FDM 3D printing und Material", "Anna Moser", "7.90", "0"},
		{"2026-10-14", "Jürgen Weiß", "receipt", "O-2026-000320", "CNC milling und Material", "David Leitner", "26.00", "0"},
		{"2026-10-15", "Max Steiner", "correction", "", "Korrektur · Kassendifferenz Z-2026-0012", "", "0", "0.40"},
		{"2026-10-16", "Lena Huber", "receipt", "O-2026-000322", "Filament", "Clara Eder", "15.00", "0"},
		{"2026-10-17", "Lena Huber", "receipt", "O-2026-000325", "Laser cutting und Material", "Paul Schwarz", "11.25", "0"},
		{"2026-10-20", "Max Steiner", "receipt", "O-2026-000327", "FDM 3D printing und Material", "Lea Fuchs", "6.30", "0"},
		{"2026-10-21", "Jürgen Weiß", "receipt", "O-2026-000330", "Embroidery", "Simon Wolf", "8.00", "0"},
		{"2026-10-22", "Lena Huber", "withdrawal", "", "Entnahme · Einkauf Schleifpapier", "", "0", "23.90"},
		{"2026-10-23", "Max Steiner", "receipt", "O-2026-000333", "Resin 3D printing und Material", "Julia Berger", "19.60", "0"},
		{"2026-10-27", "Lena Huber", "receipt", "O-2026-000336", "FDM 3D printing und Material", "Tobias Haas", "5.20", "0"},
		{"2026-10-28", "Jürgen Weiß", "receipt", "O-2026-000339", "Parts", "Nina Reiter", "3.00", "0"},
		{"2026-10-29", "Lena Huber", "receipt", "O-2026-000341", "Laser cutting und Material", "Elias Mayer", "14.70", "0"},
		{"2026-10-30", "Max Steiner", "receipt", "O-2026-000344", "FDM 3D printing und Material", "Hannah Koller", "10.10", "0"},
	}
	kinds := map[string]string{
		"receipt": "Einnahme", "refund": "Rückzahlung", "withdrawal": "Entnahme", "deposit": "Einlage",
		"correction": "Korrektur",
	}
	opening := money("182.35")
	balance, totalIn, totalOut := opening, decimal.Zero, decimal.Zero
	lines := make([]map[string]any, 0, len(rows))
	for i, row := range rows {
		in, out := money(row.in), money(row.out)
		balance = balance.Add(in).Sub(out)
		totalIn, totalOut = totalIn.Add(in), totalOut.Add(out)
		text, summary := row.summary, ""
		if row.order != "" {
			text, summary = kinds[row.kind]+" "+row.order, row.summary
		}
		lines = append(lines, map[string]any{
			"no":             i + 1,
			"date":           row.date,
			"cashier":        row.cashier,
			"kind":           kinds[row.kind],
			"text":           text,
			"orderReference": row.order,
			"orderSummary":   summary,
			"customer":       row.customer,
			"method":         "Bar",
			"receiptNumber":  fmt.Sprintf("P-2026-%06d", 812+i),
			"in":             in,
			"out":            out,
			"balance":        balance,
		})
	}
	return Data{
		"period": map[string]any{"from": "2026-10-01", "to": "2026-10-31", "businessYear": "2026", "contents": "", "kind": "cash-register"},
		"organization": map[string]any{
			"name":       "HTU Graz",
			"unit":       "Makerspace (Studienlabor)",
			"department": "Referat für Bildung und Politik",
		},
		"totals": map[string]any{
			"opening": opening, "in": totalIn, "out": totalOut, "closing": opening.Add(totalIn).Sub(totalOut),
		},
		"lines": lines,
	}
}

func sampleReceipt() Data {
	paidAt := time.Date(2026, 10, 8, 14, 10, 0, 0, time.UTC)
	return Data{
		"order": map[string]any{
			"number":    "O-2026-000311",
			"createdAt": time.Date(2026, 10, 8, 14, 2, 0, 0, time.UTC),
			"customer":  map[string]any{"name": "Marie Hofer", "matriculationNumber": "12034567"},
			"total":     money("31.20"),
			"paid":      money("31.20"),
			"open":      money("0"),
		},
		"items": []map[string]any{
			sampleItem("FDM 3D printing", "Sample printer · 2 h 14 min", "2.23", "h", "4.00", "8.92"),
			sampleItem("Material: PLA Galaxy Black", "Spool S-0142", "112", "g", "0.04", "4.48"),
			sampleItem("Laser cutting", "Sample laser · 35 min", "0.58", "h", "24.00", "13.92"),
			sampleItem("Material: plywood 3 mm", "1 sheet 600 × 300", "1", "pc", "3.88", "3.88"),
		},
		"payments": []map[string]any{
			{"reference": "P-2026-000818", "method": "Cash", "paidAt": paidAt, "amount": money("31.20")},
		},
	}
}

func sampleProjektantrag() Data {
	offer := func(shop, price, chosen, attached string) map[string]any {
		return map[string]any{"shop": shop, "price": money(price), "chosen": chosen, "attached": attached}
	}
	return Data{
		"form": map[string]any{
			"unitKind": "Referat/Studi-Lab", "unitName": "Studienlabor Makerspace Robotics", "number": "",
			"projectName": "Robot arm for the open lab", "alcohol": "Nein", "startsOn": "2026-12-01",
			"endsOn": "2027-02-28", "people": 6, "advance": "Ja",
			"description": "A six-axis robot arm that visitors can program on open days.\n" +
				"Members learn kinematics and control; the arm stays in the lab for workshops.",
			"maxExpenses": money("1240.00"), "maxIncome": money("0.00"), "responsibleFirstName": "Alex",
			"responsibleLastName": "Example", "responsibleName": "Alex Example", "place": "Graz",
			"date": "2026-11-18",
		},
		"signature": Image{Data: sampleSignature()},
		"project": map[string]any{
			"title": "Robot arm for the open lab", "group": "Robotics", "goal": "A six-axis robot arm that visitors can program on open days.",
			"benefit":  "Members learn kinematics and control; the arm stays in the lab for workshops.",
			"paidFrom": "Gruppenbudget", "wirefNumber": "", "plannedTotal": money("1240.00"),
			"plannedIncome": money("0.00"),
		},
		"advance": map[string]any{"amount": money("600.00")},
		"items": []map[string]any{
			{
				"position": 1, "text": "Servo motors (6 pcs)", "link": "https://shop.example/servo",
				"note": "", "plannedAmount": money("780.00"), "needsOffers": "Ja", "chosenOffer": "",
				"offers": []map[string]any{
					offer("Sample Robotics", "780.00", "Nein", "Ja"),
					offer("Example Motion", "812.50", "Nein", "Ja"),
					offer("Demo Parts", "799.00", "Nein", "Nein"),
				},
			},
			{
				"position": 2, "text": "Aluminium profiles and fasteners", "link": "", "note": "Cut to length",
				"plannedAmount": money("310.00"), "needsOffers": "Nein", "chosenOffer": "",
				"offers": []map[string]any{},
			},
			{
				"position": 3, "text": "Controller board", "link": "https://shop.example/controller", "note": "",
				"plannedAmount": money("150.00"), "needsOffers": "Nein", "chosenOffer": "",
				"offers": []map[string]any{},
			},
		},
		"purchases": []map[string]any{
			{
				"item": "Controller board", "costItem": "Controller board", "quantity": 1,
				"unitPrice": money("149.90"), "total": money("149.90"), "link": "https://shop.example/controller",
				"status": "Geplant", "attached": "Ja",
			},
		},
	}
}

// sampleSignature draws a fictitious signature stroke as a PNG with a transparent background.
func sampleSignature() []byte {
	const w, h = 240, 80
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	ink := color.NRGBA{R: 22, G: 40, B: 110, A: 255}
	for i := 0; i <= 2000; i++ {
		t := float64(i) / 2000
		x := 12 + t*(w-24)
		y := h/2 + 18*math.Sin(t*5*math.Pi)*math.Exp(-t*1.2) + 6*math.Sin(t*23*math.Pi)
		for dx := -1; dx <= 1; dx++ {
			for dy := -1; dy <= 1; dy++ {
				img.SetNRGBA(int(x)+dx, int(y)+dy, ink)
			}
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		return nil
	}
	return out.Bytes()
}

// sampleSheet are the form table locals the variable examples show.
func sampleSheet(Kind) map[string]any {
	return map[string]any{
		"number":  1,
		"carry":   money("182.35"),
		"sumIn":   money("213.75"),
		"sumOut":  money("50.00"),
		"balance": money("346.10"),
	}
}
