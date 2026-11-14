package signage

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

const (
	// Text colours an announcement colour may be paired with.
	textColorLight = "#ffffff"
	textColorDark  = "#161616"
	// minTextContrast is the WCAG 2 contrast ratio for normal text.
	minTextContrast = 4.5
)

var anyCaseColorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// NormalizeColor returns a `#rrggbb` colour in lower case; ok is false for any other text.
func NormalizeColor(value string) (string, bool) {
	if !anyCaseColorPattern.MatchString(value) {
		return "", false
	}
	return strings.ToLower(value), true
}

func linearChannel(value int64) float64 {
	channel := float64(value) / 255
	if channel <= 0.04045 {
		return channel / 12.92
	}
	return math.Pow((channel+0.055)/1.055, 2.4)
}

// relativeLuminance is the WCAG 2 relative luminance of a lower-case `#rrggbb` colour.
func relativeLuminance(color string) float64 {
	channel := func(from int) float64 {
		value, _ := strconv.ParseInt(color[from:from+2], 16, 32)
		return linearChannel(value)
	}
	return 0.2126*channel(1) + 0.7152*channel(3) + 0.0722*channel(5)
}

func contrastRatio(a, b string) float64 {
	high, low := relativeLuminance(a), relativeLuminance(b)
	if low > high {
		high, low = low, high
	}
	return (high + 0.05) / (low + 0.05)
}

// AnnouncementTextColor derives the text colour for an announcement background: #ffffff or #161616, whichever has
// the higher contrast (white on a tie). ok is false when neither reaches 4.5:1. The TypeScript copy in the admin UI
// runs the same vectors (api/testdata/signage-announcement-contrast.json). color must be lower-case `#rrggbb`.
func AnnouncementTextColor(color string) (string, bool) {
	light, dark := contrastRatio(color, textColorLight), contrastRatio(color, textColorDark)
	best, ratio := textColorLight, light
	if dark > light {
		best, ratio = textColorDark, dark
	}
	return best, ratio >= minTextContrast
}
