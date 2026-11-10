package notifyrules

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

var placeholderPattern = regexp.MustCompile(`\{([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\}`)

// PlaceholderKeys returns the distinct {key} placeholders a template contains, in order of appearance.
func PlaceholderKeys(template string) []string {
	var keys []string
	seen := map[string]bool{}
	for _, match := range placeholderPattern.FindAllStringSubmatch(template, -1) {
		if !seen[match[1]] {
			seen[match[1]] = true
			keys = append(keys, match[1])
		}
	}
	return keys
}

// Fill replaces every known {key} with its value. Unknown placeholders stay visible, so a mistake shows up in the
// text instead of vanishing; they are returned so callers can count them.
func Fill(template string, values map[string]string) (string, []string) {
	var unknown []string
	filled := placeholderPattern.ReplaceAllStringFunc(template, func(match string) string {
		key := match[1 : len(match)-1]
		if value, ok := values[key]; ok {
			return value
		}
		unknown = append(unknown, key)
		return match
	})
	return filled, unknown
}

// Clip shortens text to at most limit characters, marking the cut with an ellipsis.
func Clip(text string, limit int) string {
	if utf8.RuneCountInString(text) <= limit {
		return text
	}
	runes := []rune(text)
	return strings.TrimSpace(string(runes[:limit-1])) + "…"
}

// printPageTail finds print page addresses of any base address, so a cut never lands inside one.
var printPageTail = regexp.MustCompile(`\S*` + regexp.QuoteMeta(PrintPageLinkPrefix) +
	`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)

// clipText is Clip that never cuts inside a print page address: the mail variant for people without a password
// recognises a whole address only, so a cut one is dropped with the rest of the text instead.
func clipText(text string, limit int) string {
	if utf8.RuneCountInString(text) <= limit {
		return text
	}
	cut := len(string([]rune(text)[:limit-1]))
	for _, m := range printPageTail.FindAllStringIndex(text, -1) {
		if m[0] < cut && cut < m[1] {
			return strings.TrimSpace(text[:m[0]]) + "…"
		}
	}
	return Clip(text, limit)
}
