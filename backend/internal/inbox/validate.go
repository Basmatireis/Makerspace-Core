package inbox

import (
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

// cleanTitle trims a title and rejects empty, overlong or multi-line ones.
func cleanTitle(value string) (string, error) {
	value = strings.TrimSpace(value)
	length := utf8.RuneCountInString(value)
	if length == 0 || length > MaxTitleLength {
		return "", apperror.Invalid("The title must have 1 to 120 characters.")
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return "", apperror.Invalid("The title must be a single line of plain text.")
		}
	}
	return value, nil
}

// cleanBody trims a plain-text body, normalizes line breaks and rejects control characters other
// than line breaks and tabs.
func cleanBody(value string) (string, error) {
	value = strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n")
	value = strings.TrimSpace(value)
	length := utf8.RuneCountInString(value)
	if length == 0 || length > MaxBodyLength {
		return "", apperror.Invalid("The text must have 1 to 2000 characters.")
	}
	for _, r := range value {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return "", apperror.Invalid("The text must be plain text.")
		}
	}
	return value, nil
}

// cleanLink accepts only an application-relative path, so a notification can never send a reader to
// another site: it must start with a single "/" and may not contain a backslash, whitespace or
// control characters (browsers treat "/\" like "//").
func cleanLink(value *string) (*string, error) {
	if value == nil {
		return nil, nil
	}
	link := strings.TrimSpace(*value)
	if link == "" {
		return nil, nil
	}
	invalid := apperror.Invalid("The link must be a path inside the application that starts with a single \"/\".")
	if len(link) > MaxLinkLength || !strings.HasPrefix(link, "/") || strings.HasPrefix(link, "//") {
		return nil, invalid
	}
	for _, r := range link {
		if r == '\\' || unicode.IsSpace(r) || unicode.IsControl(r) {
			return nil, invalid
		}
	}
	parsed, err := url.Parse(link)
	if err != nil || parsed.Scheme != "" || parsed.Host != "" || parsed.User != nil {
		return nil, invalid
	}
	return &link, nil
}

// clip shortens text to at most limit characters for generated notifications, marking the cut.
func clip(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return strings.TrimSpace(string(runes[:limit-1])) + "…"
}

// uuidTexts converts identifiers for the text-array parameters of the queries (pgx cannot encode a
// slice of uuid.UUID directly).
func uuidTexts(values []uuid.UUID) []string {
	texts := make([]string, 0, len(values))
	for _, value := range values {
		texts = append(texts, value.String())
	}
	return texts
}
