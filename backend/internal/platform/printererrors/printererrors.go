// Package printererrors knows the shape of Bambu printer error codes: the level an HMS code carries and the wiki
// page that describes it. It is a leaf package so every feature can use it.
package printererrors

import (
	"strconv"
	"strings"
)

// Severity reads the level a Bambu HMS code carries in its third group (AAAA-BBBB-CCCC-DDDD):
// 1 fatal, 2 serious, 3 common, 4 info. Print errors and codes in another form have no level.
func Severity(sourceFamily, code string) *string {
	if sourceFamily != "hms" {
		return nil
	}
	groups := strings.Split(strings.TrimSpace(code), "-")
	if len(groups) != 4 {
		return nil
	}
	level, err := strconv.ParseUint(groups[2], 16, 16)
	if err != nil {
		return nil
	}
	var value string
	switch level {
	case 1:
		value = "fatal"
	case 2:
		value = "serious"
	case 3:
		value = "common"
	case 4:
		value = "info"
	default:
		return nil
	}
	return &value
}

// SeverityRank orders severities for comparisons: fatal is the highest, an unknown level ranks above all so it is
// never filtered away.
func SeverityRank(severity *string) int {
	if severity == nil {
		return 5
	}
	switch *severity {
	case "fatal":
		return 4
	case "serious":
		return 3
	case "common":
		return 2
	case "info":
		return 1
	}
	return 5
}

// WikiLink is the Bambu wiki page of an HMS code; nil for other families and forms.
func WikiLink(sourceFamily, code string) *string {
	if sourceFamily != "hms" || len(strings.Split(code, "-")) != 4 {
		return nil
	}
	link := "https://wiki.bambulab.com/en/x1/troubleshooting/hmscode/" + strings.ReplaceAll(strings.TrimSpace(code), "-", "_")
	return &link
}
