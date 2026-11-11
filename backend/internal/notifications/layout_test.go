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

func TestRenderBrandedLinksNotificationSettingsInTheFooter(t *testing.T) {
	brand := Branding{ApplicationName: "App", NotificationSettingsURL: "https://portal.example.test/notification-settings"}
	text, html := RenderBranded(brand, Content{Heading: "H", Paragraphs: []string{"Body"}})
	if !strings.Contains(html, `<a href="https://portal.example.test/notification-settings" style="color:#6f6f6f;">Notification settings</a>`) {
		t.Fatalf("HTML footer lacks the notification settings link: %s", html)
	}
	if !strings.Contains(text, "\nNotification settings: https://portal.example.test/notification-settings\n") {
		t.Fatalf("text footer lacks the notification settings link: %s", text)
	}

	text, html = RenderBranded(brand, Content{Heading: "H", OmitNotificationSettingsLink: true})
	for _, part := range []string{text, html} {
		if strings.Contains(part, "notification-settings") {
			t.Fatalf("opted-out mail still links the notification settings: %s", part)
		}
	}

	_, html = RenderBranded(
		Branding{ApplicationName: "App", NotificationSettingsURL: "javascript:alert(1)"}, Content{Heading: "H"},
	)
	if strings.Contains(html, "javascript:") || strings.Contains(html, "Notification settings") {
		t.Fatalf("unsafe notification settings link reached HTML: %s", html)
	}
}

func TestRenderBrandedKeepsLineBreaksOfAParagraph(t *testing.T) {
	text, html := RenderBranded(Branding{}, Content{Paragraphs: []string{"First <b>\nSecond"}})
	if !strings.Contains(html, ">First &lt;b&gt;<br>Second</p>") {
		t.Fatalf("line break not kept in HTML: %s", html)
	}
	if !strings.Contains(text, "First <b>\nSecond\n\n") {
		t.Fatalf("line break not kept in text: %q", text)
	}
}
