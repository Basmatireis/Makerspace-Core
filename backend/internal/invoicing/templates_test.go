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
		"{{ organisation }}",
		"{{organisation",
		"organisation}}",
		"{{}}",
		"{{.Organisation}}",
		"{{template \"x\"}}",
		"{{organisation}} {{nope}}",
	} {
		if err := ValidateTemplate(text); err == nil {
			t.Errorf("%q accepted", text)
		}
	}
}

func TestSubstituteReplacesOnlyWhitelistedValuesInOnePass(t *testing.T) {
	got := Substitute("A {{organisation}} B {{summe}} {{unknown}}", map[string]string{
		"organisation": "{{summe}}",
		"summe":        "EUR 5.00",
	})
	if want := "A {{summe}} B EUR 5.00 {{unknown}}"; got != want {
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
	for _, name := range []string{"freigegeben_von", "kontaktperson", "bestellreferenz"} {
		if values[name] != "" {
			t.Errorf("%s = %q, want empty", name, values[name])
		}
	}
	if values["organisation"] == "" || values["summe"] != "EUR 81.50" {
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
