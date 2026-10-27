package surveys

import "strings"

// csvSafe neutralizes spreadsheet formula injection: a cell that starts with a formula trigger is prefixed with a
// single quote, which spreadsheets display as literal text. Free-text answers are untrusted input.
func csvSafe(cell string) string {
	if cell != "" && strings.ContainsRune("=+-@\t\r", rune(cell[0])) {
		return "'" + cell
	}
	return cell
}
