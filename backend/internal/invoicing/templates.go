package invoicing

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

// Placeholder is one token that mail and PDF templates may contain.
type Placeholder struct {
	Name        string
	Description string
}

// Token is the text a template author writes, for example {{organization}}.
func (p Placeholder) Token() string { return "{{" + p.Name + "}}" }

// Placeholders is the closed whitelist of template tokens. Migration 00066 renamed the earlier German names; old
// names are not accepted as aliases, so a stored template only ever uses this list.
var Placeholders = []Placeholder{
	{"organization", "Name of the invoice recipient (organization or person)."},
	{"contact_person", "Contact person of the recipient. Empty when the contact person is switched off or unknown."},
	{"purchase_order_reference", "Purchase order reference of the recipient. Empty when switched off or not given."},
	{"request_number", "Number of the invoice request in this system, for example W-2026-000001."},
	{"order_number", "Number of the order the invoice request belongs to."},
	{"amount_to_invoice", "Amount to invoice in EUR: the order total minus cash and card payments already received."},
	{"approved_by", "Name of the person who approved the request. Empty when the approver is switched off."},
	{"approved_on", "Date of the approval (DD.MM.YYYY)."},
}

var (
	placeholderPattern = regexp.MustCompile(`\{\{([^{}]*)\}\}`)
	whitelist          = func() map[string]struct{} {
		names := make(map[string]struct{}, len(Placeholders))
		for _, p := range Placeholders {
			names[p.Name] = struct{}{}
		}
		return names
	}()
)

// legacyPlaceholders are the German names of releases 0.8.3 and 0.8.4 with their English successors. Migration 00066
// rewrote stored templates; only configuration files exported by those releases still contain the old names.
var legacyPlaceholders = map[string]string{
	"organisation":       "organization",
	"kontaktperson":      "contact_person",
	"bestellreferenz":    "purchase_order_reference",
	"anforderungsnummer": "request_number",
	"auftragsnummer":     "order_number",
	"summe":              "amount_to_invoice",
	"freigegeben_von":    "approved_by",
	"datum":              "approved_on",
}

// RenameLegacyPlaceholders rewrites the German placeholder names of an imported template to their English names and
// leaves every other token alone, so an older configuration file imports like a current one.
func RenameLegacyPlaceholders(text string) string {
	return placeholderPattern.ReplaceAllStringFunc(text, func(token string) string {
		if name, ok := legacyPlaceholders[token[2:len(token)-2]]; ok {
			return "{{" + name + "}}"
		}
		return token
	})
}

// ValidateTemplate rejects text that contains an unknown placeholder or a brace pair that is not a placeholder.
// Rejecting on save means a typo can never reach an outgoing mail.
func ValidateTemplate(text string) error {
	for _, match := range placeholderPattern.FindAllStringSubmatch(text, -1) {
		if _, ok := whitelist[match[1]]; !ok {
			return invalidTemplate("Unknown placeholder {{" + truncate(match[1], 40) + "}}")
		}
	}
	// What is left after removing complete tokens must not contain a lone brace pair.
	if rest := placeholderPattern.ReplaceAllString(text, ""); strings.Contains(rest, "{{") || strings.Contains(rest, "}}") {
		return invalidTemplate("Placeholders are written {{name}}; found an unmatched brace pair")
	}
	return nil
}

// Substitute replaces every whitelisted token by its value in one pass, so a value that itself looks like a token is
// never expanded again. It is plain string replacement: no template engine ever sees the user's text. Unknown tokens
// stay as they are; ValidateTemplate keeps them out of stored templates.
func Substitute(text string, values map[string]string) string {
	return placeholderPattern.ReplaceAllStringFunc(text, func(token string) string {
		name := token[2 : len(token)-2]
		if value, ok := values[name]; ok {
			return value
		}
		return token
	})
}

// singleLine makes a substituted value safe for a mail header or a title.
func singleLine(text string) string {
	return strings.Join(strings.Fields(strings.NewReplacer("\r", " ", "\n", " ").Replace(text)), " ")
}

func invalidTemplate(message string) error {
	return apperror.New(http.StatusUnprocessableEntity, "wiref_template_invalid", message)
}

func truncate(text string, limit int) string {
	if runes := []rune(text); len(runes) > limit {
		return string(runes[:limit]) + "..."
	}
	return text
}
