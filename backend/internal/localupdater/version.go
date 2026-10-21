// Package localupdater is the optional updater sidecar of the local-service Compose bundles and the
// file exchange through which the printer connector and the streaming gateway hand it the update
// requests they receive from Core. The sidecar is the only container of a bundle with the Docker
// socket; it installs nothing but a newer release of the bundle's own images.
package localupdater

import (
	"regexp"
	"strconv"
	"strings"
)

// versionPattern is a release version without a "v" prefix, pre-release or build suffix. Each number
// is limited to nine digits so that it fits an int.
var versionPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$`)

// ValidVersion reports whether v is a release version such as 0.8.3. Development builds ("dev") and
// anything else are not.
func ValidVersion(v string) bool { return versionPattern.MatchString(v) }

// CompareVersions compares two release versions. ok is false when either is not a release version.
func CompareVersions(a, b string) (result int, ok bool) {
	if !ValidVersion(a) || !ValidVersion(b) {
		return 0, false
	}
	left, right := strings.Split(a, "."), strings.Split(b, ".")
	for i := range 3 {
		l, _ := strconv.Atoi(left[i])
		r, _ := strconv.Atoi(right[i])
		switch {
		case l < r:
			return -1, true
		case l > r:
			return 1, true
		}
	}
	return 0, true
}

// Newer reports whether candidate is a release version newer than the release version current.
func Newer(candidate, current string) bool {
	result, ok := CompareVersions(candidate, current)
	return ok && result > 0
}
