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

// Token is the text a template author writes, for example {{organisation}}.
func (p Placeholder) Token() string { return "{{" + p.Name + "}}" }

// Placeholders is the closed whitelist of template tokens. Names are German because the accounting office and the
// people who write the templates are; the application UI around them stays English.
var Placeholders = []Placeholder{
	{"organisation", "Name of the invoice recipient (organization or person)."},
	{"kontaktperson", "Contact person of the recipient. Empty when the contact person is switched off or unknown."},
	{"bestellreferenz", "Purchase order reference of the recipient. Empty when switched off or not given."},
	{"anforderungsnummer", "Number of the invoice request in this system, for example W-2026-000001."},
	{"auftragsnummer", "Number of the order the invoice request belongs to."},
	{"summe", "Amount to invoice in EUR: the order total minus cash and card payments already received."},
	{"freigegeben_von", "Name of the person who approved the request. Empty when the approver is switched off."},
	{"datum", "Date of the approval (DD.MM.YYYY)."},
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
