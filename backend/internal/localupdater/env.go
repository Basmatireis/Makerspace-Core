package localupdater

import (
	"errors"
	"regexp"
	"strings"
)

// VersionVariable is the .env variable that selects the release of a bundle's images.
const VersionVariable = "MAKERSPACE_VERSION"

// DigestVariables pin an image to the digest of one release. A digest of the previous release would
// keep the old image (or fail) after the version changed, so the updater comments them out.
var DigestVariables = []string{"PRINTER_CONNECTOR_DIGEST", "LOCAL_UPDATER_DIGEST"}

var assignmentPattern = regexp.MustCompile(`^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$`)

func splitLines(content string) []string {
	return strings.SplitAfter(content, "\n")
}

func parseAssignment(line string) (name, value string, ok bool) {
	match := assignmentPattern.FindStringSubmatch(strings.TrimRight(line, "\r\n"))
	if match == nil {
		return "", "", false
	}
	value = strings.TrimSpace(match[2])
	if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
		value = value[1 : len(value)-1]
	}
	return match[1], value, true
}

// EnvVersion returns the release version set in a .env file. The variable must be set exactly once to
// a release version.
func EnvVersion(content string) (string, error) {
	found := ""
	count := 0
	for _, line := range splitLines(content) {
		if name, value, ok := parseAssignment(line); ok && name == VersionVariable {
			found = value
			count++
		}
	}
	if count != 1 {
		return "", errors.New(VersionVariable + " must be set exactly once")
	}
	if !ValidVersion(found) {
		return "", errors.New(VersionVariable + " is not a release version")
	}
	return found, nil
}

// RewriteEnv sets MAKERSPACE_VERSION to version and comments out non-empty digest pins. All other
// lines, comments and line endings stay as they are.
func RewriteEnv(content, version string) (string, error) {
	if !ValidVersion(version) {
		return "", errors.New("invalid version")
	}
	if _, err := EnvVersion(content); err != nil {
		return "", err
	}
	lines := splitLines(content)
	var out strings.Builder
	for _, line := range lines {
		name, value, ok := parseAssignment(line)
		ending := line[len(strings.TrimRight(line, "\r\n")):]
		switch {
		case ok && name == VersionVariable:
			out.WriteString(VersionVariable + "=" + version + ending)
		case ok && value != "" && isDigestVariable(name):
			out.WriteString("#" + strings.TrimRight(line, "\r\n") +
				" # pinned the previous release; cleared by the local updater for " + version + ending)
		default:
			out.WriteString(line)
		}
	}
	return out.String(), nil
}

func isDigestVariable(name string) bool {
	for _, candidate := range DigestVariables {
		if name == candidate {
			return true
		}
	}
	return false
}
