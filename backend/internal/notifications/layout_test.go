package notifications

import (
	"strings"
	"testing"
)

func TestRenderBrandedEscapesEveryDynamicValue(t *testing.T) {
	evil := `<script>alert(1)</script>"'&`
	text, html := RenderBranded(
		Branding{ApplicationName: evil, OrganizationName: evil, PrimaryColor: "#112233"},
		Content{
			Heading: evil, Paragraphs: []string{evil}, Code: evil, Footnote: evil,
			Rows:   []Row{{Label: evil, Value: evil}},
			Action: &Action{Label: evil, URL: `https://example.test/a?x="><script>`},
		},
	)
	if strings.Contains(html, "<script") {
		t.Fatalf("unescaped markup in HTML: %s", html)
	}
	if !strings.Contains(text, evil) {
		t.Fatal("plain text part must carry values verbatim")
	}
	if strings.Contains(html, "http://") || strings.Contains(html, "<link") || strings.Contains(html, "<img") {
		t.Fatalf("unexpected external resources: %s", html)
	}
}

func TestRenderBrandedWithoutBrandingOmitsOptionalParts(t *testing.T) {
	text, html := RenderBranded(Branding{}, Content{Heading: "Hello", Paragraphs: []string{"Body"}})
	for _, unexpected := range []string{"<img", "Imprint", "Privacy policy", "<a "} {
		if strings.Contains(html, unexpected) {
			t.Fatalf("HTML unexpectedly contains %q: %s", unexpected, html)
		}
	}
	if !strings.Contains(html, defaultBrandColor) || !strings.Contains(html, "Makerspace") {
		t.Fatal("defaults missing")
	}
	if !strings.HasPrefix(text, "Hello\n\nBody\n\n") {
		t.Fatalf("unexpected text: %q", text)
	}
}

func TestRenderBrandedRejectsUnsafeValues(t *testing.T) {
	_, html := RenderBranded(
		Branding{
			ApplicationName: "App", PrimaryColor: "red;background:url(x)",
			LogoURL: "javascript:alert(1)", ImprintURL: "ftp://example.test",
		},
		Content{Heading: "H", Action: &Action{Label: "Go", URL: "javascript:alert(1)"}},
	)
	for _, unexpected := range []string{"javascript:", "ftp:", "url(x)", "<img"} {
		if strings.Contains(html, unexpected) {
			t.Fatalf("unsafe value %q reached HTML: %s", unexpected, html)
		}
	}
}

func TestRenderBrandedActionCodeAndContrast(t *testing.T) {
	text, html := RenderBranded(
		Branding{ApplicationName: "App", PrimaryColor: "#ffff00"},
		Content{Heading: "H", Code: "ABC23456", Action: &Action{Label: "Go", URL: "https://example.test/x#code=ABC23456"}},
	)
	for _, expected := range []string{"monospace", "ABC23456", `href="https://example.test/x#code=ABC23456"`, "color:#161616;text-decoration:none"} {
		if !strings.Contains(html, expected) {
			t.Fatalf("HTML missing %q: %s", expected, html)
		}
	}
	if !strings.Contains(text, "Go: https://example.test/x#code=ABC23456") || !strings.Contains(text, "Your code: ABC23456") {
		t.Fatalf("text missing action or code: %s", text)
	}
	if readableTextColor("#0f62fe") != "#ffffff" {
		t.Fatal("white text expected on blue")
	}
}
