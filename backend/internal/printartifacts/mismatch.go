package printartifacts

import "strings"

// NameMismatch reports whether neither the uploaded file name nor the 3MF's project name matches the print
// name the printer reported for a run. Names compare case-insensitively without .gcode.3mf or .3mf. The
// printer truncates long names with a trailing "...", which then matches as a prefix. Without a print name
// there is nothing to compare, so nothing mismatches.
func NameMismatch(printName *string, uploadedFileName, projectName string) bool {
	if printName == nil {
		return false
	}
	want := normalizePrintName(*printName)
	if want == "" {
		return false
	}
	prefix, truncated := strings.CutSuffix(want, "...")
	prefix = strings.TrimSpace(prefix)
	matches := func(candidate string) bool {
		candidate = normalizePrintName(candidate)
		if candidate == "" {
			return false
		}
		if truncated {
			return prefix == "" || strings.HasPrefix(candidate, prefix)
		}
		return candidate == want
	}
	return !matches(uploadedFileName) && !matches(projectName)
}

func normalizePrintName(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	for _, suffix := range []string{".gcode.3mf", ".3mf"} {
		value = strings.TrimSuffix(value, suffix)
	}
	return strings.TrimSpace(value)
}
