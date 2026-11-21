package engine

import (
	"strings"
	"testing"
)

func TestImageBlockWithASourceDrawsTheImageOfTheData(t *testing.T) {
	doc := testDoc(KindProjektantrag,
		Block{ID: "signature", Type: BlockImage, Source: "signature", Height: Num(20)},
		Block{ID: "wide", Type: BlockImage, Source: "signature", Height: Num(200)},
		Block{ID: "after", Type: BlockText, Text: "{{signature}}After"},
	)
	data := SampleData(KindProjektantrag)
	res := render(t, RenderInput{Doc: doc, Data: data, Can: allowAll})
	boxes := boxesOf(res, "signature")
	if len(boxes) != 1 || boxes[0].H < 19.9 || boxes[0].H > 20.1 || boxes[0].W <= boxes[0].H {
		t.Fatalf("signature boxes %+v problems %+v", boxes, res.Problems)
	}
	// An image never wider than the column: it shrinks with its aspect ratio.
	size := pageSize(doc.Page)
	if wide := boxesOf(res, "wide"); len(wide) != 1 || wide[0].W > size.Width-doc.Page.Margins[1]-doc.Page.Margins[3]+0.01 {
		t.Fatalf("wide boxes %+v", wide)
	}
	if got := pageTexts(t, res.PDF)[0]; got != "After" {
		t.Fatalf("an image in text must be empty: %q", got)
	}

	// Without the image, or with data that is not PNG or JPEG, the block draws nothing.
	for _, value := range []any{nil, Image{}, Image{Data: []byte("GIF89a not an image")}, "text"} {
		data["signature"] = value
		res = render(t, RenderInput{Doc: doc, Data: data, Can: allowAll})
		if len(boxesOf(res, "signature")) != 0 {
			t.Fatalf("%T: drawn without an image", value)
		}
	}
}

func TestImageSourceMustBeAnImageVariable(t *testing.T) {
	doc := testDoc(KindProjektantrag,
		Block{ID: "text-source", Type: BlockImage, Source: "form.projectName", Height: Num(10)},
		Block{ID: "logo-source", Type: BlockImage, Source: "makerspace.logo", Height: Num(10)},
		Block{ID: "unknown", Type: BlockImage, Source: "nothing", Height: Num(10)},
		Block{ID: "fine", Type: BlockImage, Source: "signature", Height: Num(10)},
		Block{ID: "logo", Type: BlockImage, Height: Num(10)},
	)
	problems := Check(doc)
	for _, id := range []string{"text-source", "logo-source", "unknown"} {
		if !hasProblem(problems, id, SeverityError, "") {
			t.Errorf("%s: no error in %+v", id, problems)
		}
	}
	for _, id := range []string{"fine", "logo"} {
		for _, p := range problems {
			if p.NodeID == id {
				t.Errorf("%s: unexpected problem %+v", id, p)
			}
		}
	}
	// Another export has no signature.
	if problems := Check(testDoc(KindReceipt, Block{ID: "s", Type: BlockImage, Source: "signature"})); !hasProblem(problems, "s", SeverityError, "") {
		t.Fatalf("receipt signature: %+v", problems)
	}
}

func TestProjektantragDefaultRendersEveryPart(t *testing.T) {
	data := SampleData(KindProjektantrag)
	res := render(t, RenderInput{Doc: Builtin(KindProjektantrag), Data: data, Can: allowAll, Branding: SampleBranding()})
	pages := pageTexts(t, res.PDF)
	if len(pages) != 4 || res.Filename != "Projektantrag.pdf" {
		t.Fatalf("pages %d filename %q", len(pages), res.Filename)
	}
	for i, want := range []string{"Projektantrag", "Vorschussantrag", "Kostenplan", "GeplanteEinkäufe"} {
		if !strings.Contains(pages[i], want) {
			t.Errorf("page %d lacks %q: %q", i+1, want, pages[i])
		}
	}
	for _, want := range []string{"1.240,00", "Unterschrift", "01.12.2026-28.02.2027"} {
		if !strings.Contains(pages[0], want) {
			t.Errorf("form lacks %q: %q", want, pages[0])
		}
	}
	if len(boxesOf(res, "form-signature")) != 1 {
		t.Fatal("the signature is not drawn")
	}
	// Without an advance the Vorschussantrag is left out.
	data["form"].(map[string]any)["advance"] = "Nein"
	res = render(t, RenderInput{Doc: Builtin(KindProjektantrag), Data: data, Can: allowAll})
	if pages = pageTexts(t, res.PDF); len(pages) != 3 || strings.Contains(pages[1], "Vorschussantrag") {
		t.Fatalf("without an advance: %d pages", len(pages))
	}
}
