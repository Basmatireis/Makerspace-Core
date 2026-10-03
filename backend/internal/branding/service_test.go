package branding

import (
	"bytes"
	"image"
	"image/jpeg"
	"image/png"
	"strings"
	"testing"
)

func validInput() ConfigurationInput {
	return ConfigurationInput{
		Identity:        Identity{LegalOrganizationName: " HTU Graz ", DisplayName: " Makerspace ", ApplicationName: " HTU Graz Makerspace "},
		Colors:          Colors{Primary: "#AABBCC", Secondary: "#ffbf3d", Accent: "#e76f12", Background: "#111621"},
		Imprint:         Legal{Mode: "internal", Markdown: "# Imprint", ExternalURL: "https://example.test/imprint-draft"},
		Privacy:         Legal{Mode: "external", Markdown: "# retained draft", ExternalURL: "https://example.test/privacy"},
		ExpectedVersion: 1,
	}
}

func TestValidateConfigurationNormalizesIdentityAndColors(t *testing.T) {
	input := validInput()
	if err := validateConfiguration(&input); err != nil {
		t.Fatalf("validateConfiguration: %v", err)
	}
	if input.Identity.LegalOrganizationName != "HTU Graz" || input.Identity.DisplayName != "Makerspace" {
		t.Fatalf("identity was not trimmed: %#v", input.Identity)
	}
	if input.Colors.Primary != "#aabbcc" {
		t.Fatalf("primary color = %q, want lowercase", input.Colors.Primary)
	}
	if input.Imprint.ExternalURL == "" || input.Privacy.Markdown == "" {
		t.Fatal("inactive legal drafts must be retained")
	}
}

func TestValidateConfigurationRejectsInvalidIdentityAndColors(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*ConfigurationInput)
	}{
		{name: "empty required name", mutate: func(value *ConfigurationInput) { value.Identity.DisplayName = "  " }},
		{name: "long tagline", mutate: func(value *ConfigurationInput) {
			tagline := strings.Repeat("x", 241)
			value.Identity.Tagline = &tagline
		}},
		{name: "short hex", mutate: func(value *ConfigurationInput) { value.Colors.Accent = "#fff" }},
		{name: "missing version", mutate: func(value *ConfigurationInput) { value.ExpectedVersion = 0 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := validInput()
			test.mutate(&input)
			if err := validateConfiguration(&input); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestValidateLegalModesAndURLs(t *testing.T) {
	valid := []Legal{
		{Mode: "internal", Markdown: ""},
		{Mode: "internal", Markdown: "draft", ExternalURL: "https://example.test/draft"},
		{Mode: "external", Markdown: "retained", ExternalURL: "http://example.test/legal?q=1"},
	}
	for _, value := range valid {
		if err := validateLegal(value); err != nil {
			t.Fatalf("validateLegal(%#v): %v", value, err)
		}
	}
	invalid := []Legal{
		{Mode: "unknown"},
		{Mode: "external"},
		{Mode: "external", ExternalURL: "/relative"},
		{Mode: "external", ExternalURL: "ftp://example.test/legal"},
		{Mode: "external", ExternalURL: "https://user:secret@example.test/legal"},
		{Mode: "external", ExternalURL: "https://example.test/\u0001legal"},
		{Mode: "internal", Markdown: strings.Repeat("x", 102401)},
	}
	for _, value := range invalid {
		if err := validateLegal(value); err == nil {
			t.Fatalf("validateLegal(%#v) unexpectedly succeeded", value)
		}
	}
}

func TestValidateAssetRasterFormatsDimensionsAndLimits(t *testing.T) {
	pngBytes := encodePNG(t, image.NewRGBA(image.Rect(0, 0, 32, 24)))
	if _, contentType, err := validateAsset(Logo, bytes.NewReader(pngBytes)); err != nil || contentType != "image/png" {
		t.Fatalf("valid PNG: contentType=%q err=%v", contentType, err)
	}

	var jpegBytes bytes.Buffer
	if err := jpeg.Encode(&jpegBytes, image.NewRGBA(image.Rect(0, 0, 32, 24)), nil); err != nil {
		t.Fatal(err)
	}
	if _, _, err := validateAsset(Logo, bytes.NewReader(jpegBytes.Bytes())); err == nil {
		t.Fatal("logo JPEG unexpectedly accepted")
	}
	if _, contentType, err := validateAsset(ApplicationBackground, bytes.NewReader(jpegBytes.Bytes())); err != nil || contentType != "image/jpeg" {
		t.Fatalf("background JPEG: contentType=%q err=%v", contentType, err)
	}

	tooWide := encodePNG(t, image.NewRGBA(image.Rect(0, 0, 4097, 1)))
	if _, _, err := validateAsset(Logo, bytes.NewReader(tooWide)); err == nil {
		t.Fatal("oversized dimensions unexpectedly accepted")
	}
	if _, _, err := validateAsset(Logo, bytes.NewReader(bytes.Repeat([]byte{'x'}, (2<<20)+1))); err == nil {
		t.Fatal("oversized logo unexpectedly accepted")
	}
}

func TestSanitizeSVGAcceptsSafeSubsetAndRemovesMetadata(t *testing.T) {
	raw := []byte(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><!--private--><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>`)
	result, contentType, err := validateAsset(Favicon, bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("validateAsset: %v", err)
	}
	if contentType != "image/svg+xml" || bytes.Contains(result, []byte("private")) || !bytes.Contains(result, []byte("xmlns=")) {
		t.Fatalf("unexpected sanitized SVG: %s", result)
	}
}

func TestSanitizeSVGRejectsActiveAndExternalContent(t *testing.T) {
	unsafe := []string{
		`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
		`<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>`,
		`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>`,
		`<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.test/image.svg#x"/></svg>`,
		`<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(data:image/svg+xml,x)"/></svg>`,
		`<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="x"/></svg>`,
		`<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>`,
	}
	for _, raw := range unsafe {
		if _, err := sanitizeSVG([]byte(raw)); err == nil {
			t.Fatalf("unsafe SVG unexpectedly accepted: %s", raw)
		}
	}
}

func encodePNG(t *testing.T, value image.Image) []byte {
	t.Helper()
	var result bytes.Buffer
	encoder := png.Encoder{CompressionLevel: png.BestSpeed}
	if err := encoder.Encode(&result, value); err != nil {
		t.Fatal(err)
	}
	return result.Bytes()
}
