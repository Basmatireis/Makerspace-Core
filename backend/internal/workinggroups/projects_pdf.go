package workinggroups

import (
	"bytes"
	"fmt"
	"image/png"
	"strings"

	"github.com/go-pdf/fpdf"
)

// TODO(pdf-templates): the Projektantrag and its attachments are drawn directly with fpdf because the template
// engine (backend/internal/pdftemplates) only knows its closed set of export kinds (wiref, cashbook, receipt); a
// "projektantrag" kind needs a schema, a built-in document and an editor entry. Move these renderers there.

type pdfPage struct {
	pdf *fpdf.Fpdf
	tr  func(string) string
}

func newPDFPage(title string) *pdfPage {
	pdf := fpdf.New("P", "mm", "A4", "")
	pdf.SetMargins(20, 20, 20)
	pdf.SetAutoPageBreak(true, 20)
	pdf.SetTitle(title, true)
	pdf.AddPage()
	page := &pdfPage{pdf: pdf, tr: pdf.UnicodeTranslatorFromDescriptor("")}
	pdf.SetFont("Helvetica", "B", 16)
	pdf.CellFormat(0, 10, page.tr(title), "", 1, "L", false, 0, "")
	pdf.Ln(4)
	return page
}

func (p *pdfPage) field(label, value string) {
	p.pdf.SetFont("Helvetica", "B", 9)
	p.pdf.SetTextColor(90, 90, 90)
	p.pdf.CellFormat(0, 5, p.tr(label), "", 1, "L", false, 0, "")
	p.pdf.SetFont("Helvetica", "", 11)
	p.pdf.SetTextColor(0, 0, 0)
	if strings.TrimSpace(value) == "" {
		value = "-"
	}
	p.pdf.MultiCell(0, 6, p.tr(value), "", "L", false)
	p.pdf.Ln(2)
}

func (p *pdfPage) row(left, right string, bold bool) {
	style := ""
	if bold {
		style = "B"
	}
	p.pdf.SetFont("Helvetica", style, 10)
	x, y := p.pdf.GetX(), p.pdf.GetY()
	p.pdf.MultiCell(125, 6, p.tr(left), "B", "L", false)
	endY := p.pdf.GetY()
	p.pdf.SetXY(x+125, y)
	p.pdf.CellFormat(25, endY-y, p.tr(right), "B", 1, "R", false, 0, "")
	p.pdf.SetY(endY)
}

func (p *pdfPage) bytes() ([]byte, error) {
	var out bytes.Buffer
	if err := p.pdf.Output(&out); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
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

func germanDate(iso string) string {
	if len(iso) == 10 {
		return iso[8:10] + "." + iso[5:7] + "." + iso[0:4]
	}
	return iso
}

func (p *pdfPage) signature(data []byte) {
	if len(data) == 0 {
		return
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width == 0 {
		return
	}
	width := 60.0
	height := width * float64(cfg.Height) / float64(cfg.Width)
	if height > 30 {
		height = 30
		width = height * float64(cfg.Width) / float64(cfg.Height)
	}
	if p.pdf.GetY()+height > 270 {
		p.pdf.AddPage()
	}
	opts := fpdf.ImageOptions{ImageType: "PNG", ReadDpi: false}
	p.pdf.RegisterImageOptionsReader("signature", opts, bytes.NewReader(data))
	p.pdf.ImageOptions("signature", p.pdf.GetX(), p.pdf.GetY(), width, height, false, opts, 0, "")
	p.pdf.SetY(p.pdf.GetY() + height + 2)
}

// renderProjektantrag draws the form of the HTU Projektantrag.
func renderProjektantrag(f RequestForm, signature []byte) ([]byte, error) {
	page := newPDFPage("Projektantrag")
	page.field("Organisationseinheit", unitLabel(f.UnitKind)+": "+f.UnitName)
	page.field("PA-Nummer (wird von der WiRef ausgefuellt)", f.Number)
	page.field("Projektname", f.ProjectName)
	page.field("Alkohol", yesNo(f.Alcohol))
	page.field("Zeitraum", strings.TrimSpace(germanDate(f.StartsOn)+" - "+germanDate(f.EndsOn)))
	page.field("Geplante Personenanzahl", fmt.Sprint(f.People))
	page.field("Vorschuss", yesNo(f.Advance))
	page.field("Beschreibung", f.Description)
	page.field("Geplante maximale Ausgaben (EUR)", f.MaxExpenses)
	page.field("Geplante maximale Einnahmen (EUR)", f.MaxIncome)
	page.field("Kostenstellenverantwortliche Person", strings.TrimSpace(f.ResponsibleFirstName+" "+f.ResponsibleLastName))
	page.field("Datum, Ort", strings.TrimSpace(germanDate(f.Date)+", "+f.Place))
	page.field("Unterschrift", "")
	page.signature(signature)
	return page.bytes()
}

// renderAdvanceRequest is the one-page request for an advance.
func renderAdvanceRequest(project Project, f RequestForm, amount string) ([]byte, error) {
	page := newPDFPage("Vorschussantrag")
	page.field("Projekt", f.ProjectName)
	page.field("Gruppe", project.GroupName)
	page.field("Organisationseinheit", unitLabel(f.UnitKind)+": "+f.UnitName)
	page.field("Vorschussbetrag (EUR)", amount)
	page.field("Kostenstellenverantwortliche Person", strings.TrimSpace(f.ResponsibleFirstName+" "+f.ResponsibleLastName))
	page.field("Datum, Ort", strings.TrimSpace(germanDate(f.Date)+", "+f.Place))
	return page.bytes()
}

// renderCostPlan lists the items with their planned amounts.
func renderCostPlan(project Project) ([]byte, error) {
	page := newPDFPage("Cost plan: " + project.Title)
	for _, item := range project.Items {
		text := item.Text
		if item.Link != nil {
			text += "\n" + *item.Link
		}
		page.row(text, item.PlannedAmount, false)
	}
	page.row("Total (EUR)", project.Totals.Planned, true)
	return page.bytes()
}

// renderPurchases lists the planned purchases of a project with their links.
func renderPurchases(project Project) ([]byte, error) {
	page := newPDFPage("Purchases: " + project.Title)
	for _, item := range project.Items {
		for _, pu := range item.Purchases {
			if pu.Status == PurchaseDeclined {
				continue
			}
			text := fmt.Sprintf("%s (%s) x %d", pu.Item, item.Text, pu.Quantity)
			if pu.Link != nil {
				text += "\n" + *pu.Link
			}
			if pu.HasAttachment {
				text += "\n(offer or cart attached)"
			}
			page.row(text, pu.UnitPrice, false)
		}
	}
	return page.bytes()
}
