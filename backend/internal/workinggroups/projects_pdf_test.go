package workinggroups

import (
	"bytes"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/engine"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/pdftest"
	"github.com/google/uuid"
)

func sampleProject() (Project, RequestForm) {
	link, note, chosen := "https://shop.example/panels", "Cut to size", uuid.New()
	paid, advance := PaidFromGroup, "400.00"
	project := Project{
		Title: "Printer enclosure", GroupName: "Resin", Goal: "An enclosure", Benefit: "Cleaner air",
		PlannedIncome: "0.00", AdvanceRequested: true, AdvanceAmount: &advance, PaidFrom: &paid, WiRefNumber: "PA-1",
		Totals: ProjectTotals{Planned: "800.00"},
		Items: []ProjectItem{
			{
				Text: "Acrylic panels", PlannedAmount: "620.00", Link: &link, Note: &note, NeedsOffers: true, ChosenOfferID: &chosen,
				Offers: []ProjectOffer{{ID: chosen, Shop: "Plastics A", Price: "620.00", HasFile: true}},
				Purchases: []ProjectPurchase{
					{Item: "Panel", Link: &link, Quantity: 3, UnitPrice: "15.50", Status: PurchasePlanned, HasAttachment: true},
					{Item: "Declined", Quantity: 1, UnitPrice: "1.00", Status: PurchaseDeclined},
				},
			},
			{Text: "Fan", PlannedAmount: "180.00"},
		},
	}
	form := RequestForm{
		UnitKind: UnitReferat, UnitName: "Studienlabor Resin", ProjectName: "Printer enclosure", StartsOn: "2026-12-01",
		EndsOn: "2027-02-28", People: 5, Advance: true, Description: "An enclosure", MaxExpenses: "800.00",
		MaxIncome: "0.00", ResponsibleFirstName: "Alex", ResponsibleLastName: "Example", Place: "Graz", Date: "2026-11-21",
	}
	return project, form
}

func TestProjektantragDataMatchesTheTemplateSchema(t *testing.T) {
	project, form := sampleProject()
	data := projektantragData(project, form, []byte{0x89, 'P', 'N', 'G'})
	pdftest.AssertData(t, engine.KindProjektantrag, data)
	purchases := data["purchases"].([]map[string]any)
	if len(purchases) != 1 || purchases[0]["total"] != "46.50" || purchases[0]["costItem"] != "Acrylic panels" ||
		purchases[0]["status"] != "Geplant" || purchases[0]["attached"] != "Ja" {
		t.Fatalf("purchases %+v", purchases)
	}
	items := data["items"].([]map[string]any)
	if items[0]["chosenOffer"] != "Plastics A" || items[1]["position"] != 2 || items[1]["link"] != "" {
		t.Fatalf("items %+v", items)
	}
	f := data["form"].(map[string]any)
	if f["unitKind"] != "Referat/Studi-Lab" || f["responsibleName"] != "Alex Example" || f["alcohol"] != "Nein" ||
		data["project"].(map[string]any)["paidFrom"] != "Gruppenbudget" || data["advance"].(map[string]any)["amount"] != "400.00" {
		t.Fatalf("data %+v", data)
	}
}

func TestRenderRequestUsesTheBuiltinTemplateByDefault(t *testing.T) {
	project, form := sampleProject()
	s := NewService(nil)
	pdf, name, err := s.renderRequest(t.Context(), project, form, nil)
	if err != nil || name != "Projektantrag.pdf" || !bytes.HasPrefix(pdf, []byte("%PDF")) {
		t.Fatalf("render: %q %v", name, err)
	}
	// A nil renderer keeps the built-in one.
	if s.WithPDFTemplates(nil).pdf != (pdftemplates.BuiltinRenderer{}) {
		t.Fatal("renderer replaced by nil")
	}
}
