package invoicing

import (
	"strings"
	"testing"
)

func TestValidateTemplateAcceptsWhitelistedPlaceholders(t *testing.T) {
	for _, p := range Placeholders {
		if err := ValidateTemplate("Hello " + p.Token() + "!"); err != nil {
			t.Errorf("%s rejected: %v", p.Name, err)
		}
	}
	if err := ValidateTemplate("Plain text, a single { brace and 100% done"); err != nil {
		t.Errorf("plain text rejected: %v", err)
	}
}

func TestValidateTemplateRejectsUnknownAndMalformedPlaceholders(t *testing.T) {
	for _, text := range []string{
		"{{unknown}}",
		"{{ organization }}",
		"{{organization",
		"organization}}",
		"{{}}",
		"{{.Organisation}}",
		"{{template \"x\"}}",
		"{{organization}} {{nope}}",
		// The German names before migration 00065 are not aliases.
		"{{organisation}}",
		"{{anforderungsnummer}}",
		"{{datum}}",
	} {
		if err := ValidateTemplate(text); err == nil {
			t.Errorf("%q accepted", text)
		}
	}
}

func TestSubstituteReplacesOnlyWhitelistedValuesInOnePass(t *testing.T) {
	got := Substitute("A {{organization}} B {{amount_to_invoice}} {{unknown}}", map[string]string{
		"organization":      "{{amount_to_invoice}}",
		"amount_to_invoice": "EUR 5.00",
	})
	if want := "A {{amount_to_invoice}} B EUR 5.00 {{unknown}}"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestSubstitutedHeaderValuesLoseLineBreaks(t *testing.T) {
	d := SampleDocument(sampleTime())
	d.Organisation = "Evil\r\nBcc: x@example.org"
	settings := defaultSettings()
	subject, _ := settings.MailContent(d)
	if strings.ContainsAny(subject, "\r\n") {
		t.Fatalf("subject contains a line break: %q", subject)
	}
}

func TestSwitchedOffFieldsYieldEmptyPlaceholders(t *testing.T) {
	settings := defaultSettings()
	settings.ShowApprover, settings.ShowContactPerson, settings.ShowPurchaseOrder = false, false, false
	values := SampleDocument(sampleTime()).values(settings)
	for _, name := range []string{"approved_by", "contact_person", "purchase_order_reference"} {
		if values[name] != "" {
			t.Errorf("%s = %q, want empty", name, values[name])
		}
	}
	if values["organization"] == "" || values["amount_to_invoice"] != "EUR 81.50" {
		t.Errorf("unexpected values %v", values)
	}
}

func TestFormatAmountGroupsThousands(t *testing.T) {
	for in, want := range map[string]string{"1234.5": "EUR 1,234.50", "0": "EUR 0.00", "-12.345": "-EUR 12.35", "1000000": "EUR 1,000,000.00"} {
		if got := formatAmount(in); got != want {
			t.Errorf("formatAmount(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRenameLegacyPlaceholdersOnlyTouchesTheGermanNames(t *testing.T) {
	got := RenameLegacyPlaceholders("{{anforderungsnummer}} {{organisation}} {{summe}} {{datum}} {{organization}} {{nope}} summe")
	if want := "{{request_number}} {{organization}} {{amount_to_invoice}} {{approved_on}} {{organization}} {{nope}} summe"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	for old := range legacyPlaceholders {
		if err := ValidateTemplate(RenameLegacyPlaceholders("{{" + old + "}}")); err != nil {
			t.Errorf("%s: %v", old, err)
		}
	}
}
