package notifyrules

import (
	"net/url"
	"strings"
	"unicode"
)

// LinkPlaceholder stands for the trigger's own link in a button.
const LinkPlaceholder = "{link}"

// validLink accepts the trigger's link placeholder, an application-relative path that starts with a single "/", or
// an https URL with a host. A path may not contain a backslash, whitespace or control characters (browsers treat
// "/\" like "//"); other schemes are refused so a notification never points at an insecure or non-web target.
func validLink(link string) bool {
	if link == LinkPlaceholder {
		return true
	}
	if link == "" || len(link) > MaxLinkLength {
		return false
	}
	for _, r := range link {
		if r == '\\' || unicode.IsSpace(r) || unicode.IsControl(r) {
			return false
		}
	}
	if strings.HasPrefix(link, "/") {
		if strings.HasPrefix(link, "//") {
			return false
		}
		parsed, err := url.Parse(link)
		return err == nil && parsed.Scheme == "" && parsed.Host == "" && parsed.User == nil
	}
	parsed, err := url.Parse(link)
	return err == nil && parsed.Scheme == "https" && parsed.User == nil && strings.Contains(parsed.Hostname(), ".") &&
		!strings.Contains(link, "@")
}
