package integration_test

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/engine"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups"
	pdfread "github.com/ledongthuc/pdf"
)

// pdfPageTexts is the text of every page with all white space removed.
func pdfPageTexts(t *testing.T, data []byte) []string {
	t.Helper()
	reader, err := pdfread.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("read pdf: %v", err)
	}
	var pages []string
	for i := 1; i <= reader.NumPage(); i++ {
		var b strings.Builder
		for _, c := range reader.Page(i).Content().Text {
			b.WriteString(c.S)
		}
		pages = append(pages, strings.Join(strings.Fields(b.String()), ""))
	}
	return pages
}

// realisticProject is a project with dates, an advance, a cost plan item with three offers and a link, a second item
// and a planned purchase.
func (f projectFixture) realisticProject(t *testing.T) workinggroups.Project {
	t.Helper()
	ctx := testContext(t)
	starts, ends := time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC), time.Date(2027, 2, 28, 0, 0, 0, 0, time.UTC)
	advance := "400"
	p, err := f.service.CreateProject(ctx, f.lead, workinggroups.CreateProjectInput{
		GroupID: f.group.ID, ProjectFields: workinggroups.ProjectFields{
			Title: "Printer enclosure", Goal: "An enclosure for the resin printers", Benefit: "Cleaner air in the lab",
			StartsOn: &starts, EndsOn: &ends, People: 5, PlannedIncome: "0", AdvanceRequested: true, AdvanceAmount: &advance,
		},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	link := "https://shop.example/panels"
	if p, err = f.service.CreateProjectItem(ctx, f.lead, p.ID, workinggroups.ProjectItemInput{Text: "Acrylic panels", PlannedAmount: "620", Link: &link}, nil); err != nil {
		t.Fatal(err)
	}
	for i, shop := range []string{"Plastics A", "Plastics B", "Plastics C"} {
		price := []string{"620", "655.50", "640"}[i]
		if p, err = f.service.CreateProjectOffer(ctx, f.lead, p.ID, p.Items[0].ID, workinggroups.ProjectOfferInput{Shop: shop, Price: price}, nil); err != nil {
			t.Fatal(err)
		}
	}
	if p, err = f.service.CreateProjectItem(ctx, f.lead, p.ID, workinggroups.ProjectItemInput{Text: "Extraction fan", PlannedAmount: "180"}, nil); err != nil {
		t.Fatal(err)
	}
	f.planned(t, p, "45")
	return f.get(t, p.ID)
}

func TestWorkingGroupProjektantragRendersTheDefaultTemplateWithTheProject(t *testing.T) {
	f := newProjectFixture(t, "wgp-pdf")
	ctx := testContext(t)
	p := f.realisticProject(t)
	place, first, last := "Graz", "Alex", "Example"
	date := time.Date(2026, 11, 21, 0, 0, 0, 0, time.UTC)
	form := workinggroups.RequestFormInput{
		Signature: f.signature, Place: &place, ResponsibleFirstName: &first, ResponsibleLastName: &last, Date: &date,
	}
	pdf, err := f.service.PreviewProjectRequest(ctx, f.finance, p.ID, form)
	if err != nil {
		t.Fatal(err)
	}
	pages := pdfPageTexts(t, pdf)
	if len(pages) != 4 {
		t.Fatalf("pages %q", pages)
	}
	for i, wants := range [][]string{
		{"Projektantrag", "Organisationseinheit", "PrinterenclosureAlkoholNein", "01.12.2026-28.02.2027", "GeplantePersonenanzahl5",
			"VorschussJa", "Anenclosurefortheresinprinters", "Cleanerairinthelab", "800,00", "AlexExample", "21.11.2026,Graz", "Unterschrift"},
		{"Vorschussantrag", "Printerenclosure", "Vorschussbetrag(EUR)400,00"},
		{"Kostenplan:Printerenclosure", "Acrylicpanels", "https://shop.example/panels", "620,00", "Extractionfan", "180,00",
			"Summe(EUR)800,00", "Vergleichsangebote:Acrylicpanels", "PlasticsB", "655,50"},
		{"GeplanteEinkäufe:Printerenclosure", "Part(Acrylicpanels)x1", "https://shop.example/part", "45,00"},
	} {
		for _, want := range wants {
			if !strings.Contains(pages[i], want) {
				t.Errorf("page %d lacks %q: %q", i+1, want, pages[i])
			}
		}
	}
	if !bytes.Contains(pdf, []byte("/Subtype /Image")) {
		t.Fatal("the signature is not placed")
	}
	// Without a signature the form has none; without an advance the Vorschussantrag is left out.
	no := false
	pdf, err = f.service.PreviewProjectRequest(ctx, f.finance, p.ID, workinggroups.RequestFormInput{Advance: &no})
	if err != nil {
		t.Fatal(err)
	}
	if pages = pdfPageTexts(t, pdf); len(pages) != 3 || strings.Contains(strings.Join(pages, ""), "Vorschussantrag") ||
		bytes.Contains(pdf, []byte("/Subtype /Image")) {
		t.Fatalf("without signature and advance: %q", pages)
	}
	// Only finance managers preview the form.
	if _, err := f.service.PreviewProjectRequest(ctx, f.lead, p.ID, form); err == nil {
		t.Fatal("the lead previewed the Projektantrag")
	}
}

func TestWorkingGroupProjektantragFollowsThePublishedTemplate(t *testing.T) {
	f := newProjectFixture(t, "wgp-tpl")
	ctx := testContext(t)
	editor, _ := groupPrincipal(t, f.pool, "wgp-tpl-editor", "pdf_templates.manage")
	templates := pdftemplates.NewService(f.pool, nil, pdftemplates.Records{})
	f.service.WithPDFTemplates(templates)
	t.Cleanup(func() {
		if _, err := f.pool.Exec(ctx, `DELETE FROM pdf_template_versions WHERE export_kind = 'projektantrag'`); err != nil {
			t.Error(err)
		}
	})
	doc := engine.Builtin(engine.KindProjektantrag)
	doc.Body[0].Text = "Projektantrag der Arbeitsgruppe {{project.group}}"
	doc.Page.Filename = "Projektantrag-{{project.title}}.pdf"
	raw, err := engine.Encode(doc)
	if err != nil {
		t.Fatal(err)
	}
	draft, err := templates.SaveDraft(ctx, editor, engine.KindProjektantrag, raw, nil, nil)
	if err != nil || len(draft.Problems) != 0 {
		t.Fatalf("draft: %+v %v", draft.Problems, err)
	}
	if _, err := templates.Publish(ctx, editor, engine.KindProjektantrag, draft.Version.Revision, nil); err != nil {
		t.Fatal(err)
	}
	// Paid from an external source, so the wiRef decides and the request is mailed on approval.
	p := f.project(t, "Published look", "60")
	f.planned(t, p, "60")
	p = f.approve(t, f.submit(t, f.get(t, p.ID)), workinggroups.PaidFromExternal)
	if !p.HasRequestPDF || f.mail.count() != 1 {
		t.Fatalf("project = %+v mails %d", p, f.mail.count())
	}
	mail := f.mail.sent[0]
	if names := mail.names(); len(names) != 1 || names[0] != "Projektantrag-Published-look.pdf" {
		t.Fatalf("attachments %q", names)
	}
	want := "ProjektantragderArbeitsgruppe" + strings.Join(strings.Fields(f.group.Name), "")
	if pages := pdfPageTexts(t, mail.attachments[0].Data); !strings.Contains(pages[0], want) {
		t.Fatalf("mailed page %q lacks %q", pages[0], want)
	}
	// The stored request is the mailed PDF.
	file, reader, err := f.service.OpenProjectRequestPDF(ctx, f.finance, p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored := readAll(t, reader); stored != string(mail.attachments[0].Data) || file.OriginalFilename != "Projektantrag-Published-look.pdf" {
		t.Fatalf("stored %s (%d bytes)", file.OriginalFilename, len(stored))
	}
}
