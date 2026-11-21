package workinggroups

import (
	"context"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/engine"
	"github.com/shopspring/decimal"
)

// requestFileName is the name of the Projektantrag when the template gives none.
const requestFileName = "Projektantrag.pdf"

// PDFRenderer renders the effective template of an export (the published version, or the built-in default). The
// PDF template service implements it; without one the built-in default is used.
type PDFRenderer interface {
	RenderEffective(
		ctx context.Context,
		kind engine.Kind,
		data engine.Data,
		can func(permission string) bool,
	) (pdf []byte, filename string, err error)
}

// WithPDFTemplates makes the Projektantrag follow the published template and show the branding logo.
func (s *Service) WithPDFTemplates(renderer PDFRenderer) *Service {
	if renderer != nil {
		s.pdf = renderer
	}
	return s
}

// renderRequest renders the Projektantrag with its advance request, cost plan and planned purchases as one PDF. It
// is a system rendering: the export has no fields that need a permission.
func (s *Service) renderRequest(ctx context.Context, project Project, f RequestForm, signature []byte) ([]byte, string, error) {
	pdf, name, err := s.pdf.RenderEffective(ctx, engine.KindProjektantrag, projektantragData(project, f, signature), nil)
	if err != nil {
		return nil, "", err
	}
	if name == "" {
		name = requestFileName
	}
	return pdf, name, nil
}

func yesNo(v bool) string {
	if v {
		return "Ja"
	}
	return "Nein"
}

func unitLabel(kind string) string {
	switch kind {
	case UnitStv:
		return "Stv"
	case UnitUV:
		return "UV"
	}
	return "Referat/Studi-Lab"
}

func paidFromLabel(paidFrom *string) string {
	if paidFrom == nil {
		return ""
	}
	switch *paidFrom {
	case PaidFromGroup:
		return "Gruppenbudget"
	case PaidFromExternal:
		return "Externe Quelle"
	}
	return ""
}

var purchaseStatusLabels = map[string]string{
	PurchasePlanned: "Geplant", PurchaseWanted: "Gewünscht", PurchaseApproved: "Genehmigt",
	PurchaseOrdered: "Bestellt", PurchaseReceived: "Erhalten", PurchaseBought: "Gekauft",
	PurchaseRefunded: "Rückerstattet", PurchaseDeclined: "Abgelehnt",
}

func optionalText(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

// projektantragData is the data of the Projektantrag template (engine.Schema(engine.KindProjektantrag)). Amounts are
// the decimal strings of the project; dates are civil "YYYY-MM-DD" dates or empty.
func projektantragData(project Project, f RequestForm, signature []byte) engine.Data {
	advance := project.Totals.Planned
	if project.AdvanceAmount != nil {
		advance = *project.AdvanceAmount
	}
	items := make([]map[string]any, 0, len(project.Items))
	purchases := []map[string]any{}
	for i, item := range project.Items {
		chosen := ""
		offers := make([]map[string]any, 0, len(item.Offers))
		for _, o := range item.Offers {
			isChosen := item.ChosenOfferID != nil && *item.ChosenOfferID == o.ID
			if isChosen {
				chosen = o.Shop
			}
			offers = append(offers, map[string]any{
				"shop": o.Shop, "price": o.Price, "chosen": yesNo(isChosen),
				// The mail carries the offer files of the items that need offers.
				"attached": yesNo(o.HasFile && item.NeedsOffers),
			})
		}
		items = append(items, map[string]any{
			"position": i + 1, "text": item.Text, "link": optionalText(item.Link), "note": optionalText(item.Note),
			"plannedAmount": item.PlannedAmount, "needsOffers": yesNo(item.NeedsOffers), "chosenOffer": chosen,
			"offers": offers,
		})
		for _, pu := range item.Purchases {
			if pu.Status == PurchaseDeclined {
				continue
			}
			total := ""
			if price, err := decimal.NewFromString(pu.UnitPrice); err == nil {
				total = price.Mul(decimal.NewFromInt32(pu.Quantity)).StringFixed(2)
			}
			purchases = append(purchases, map[string]any{
				"item": pu.Item, "costItem": item.Text, "quantity": int(pu.Quantity), "unitPrice": pu.UnitPrice,
				"total": total, "link": optionalText(pu.Link), "status": purchaseStatusLabels[pu.Status],
				"attached": yesNo(pu.HasAttachment),
			})
		}
	}
	data := engine.Data{
		"form": map[string]any{
			"unitKind": unitLabel(f.UnitKind), "unitName": f.UnitName, "number": f.Number,
			"projectName": f.ProjectName, "alcohol": yesNo(f.Alcohol), "startsOn": f.StartsOn, "endsOn": f.EndsOn,
			"people": f.People, "advance": yesNo(f.Advance), "description": f.Description,
			"maxExpenses": f.MaxExpenses, "maxIncome": f.MaxIncome,
			"responsibleFirstName": f.ResponsibleFirstName, "responsibleLastName": f.ResponsibleLastName,
			"responsibleName": strings.TrimSpace(f.ResponsibleFirstName + " " + f.ResponsibleLastName),
			"place":           f.Place, "date": f.Date,
		},
		"project": map[string]any{
			"title": project.Title, "group": project.GroupName, "goal": project.Goal, "benefit": project.Benefit,
			"paidFrom": paidFromLabel(project.PaidFrom), "wirefNumber": project.WiRefNumber,
			"plannedTotal": project.Totals.Planned, "plannedIncome": project.PlannedIncome,
		},
		"advance":   map[string]any{"amount": advance},
		"items":     items,
		"purchases": purchases,
		"signature": engine.Image{Data: signature},
	}
	return data
}
