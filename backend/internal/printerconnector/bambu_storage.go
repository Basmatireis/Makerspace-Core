package printerconnector

import (
	"context"
	"net/url"
	"strings"

	"github.com/google/uuid"
)

// bambuPrintSource says where the 3MF of a print lives, as far as the
// connector can tell. The connector reads only external storage (USB or SD
// card) over FTPS; a print started from the printer's internal storage has no
// archive it can reach.
type bambuPrintSource string

const (
	bambuSourceExternal bambuPrintSource = "external_storage"
	bambuSourceInternal bambuPrintSource = "internal_storage"
)

// externalMediaPrefixes are the mount points of external storage in the `url`
// the printer reports for a print started from it.
var externalMediaPrefixes = []string{"/media/usb", "/mnt/sdcard", "/sdcard"}

// classifyBambuPrintSource decides from the `url` a status message reported
// during the current session (empty when none did) and the print's
// subtask_name whether the archive is on external storage.
//
// The merged status document keeps `url` from the previous print, so only a
// url that names external media and whose file name matches the print counts.
// Without a url, or with a stale or mismatching one, the print is taken to
// come from internal storage. A print without a subtask_name cannot be matched,
// so a url on external media is trusted.
func classifyBambuPrintSource(sessionURL, subtaskName string) bambuPrintSource {
	mediaPath, ok := externalMediaPath(sessionURL)
	if !ok {
		return bambuSourceInternal
	}
	printName := archiveBaseName(subtaskName)
	if printName == "" {
		return bambuSourceExternal
	}
	slash := strings.LastIndex(mediaPath, "/")
	if strings.EqualFold(archiveBaseName(mediaPath[slash+1:]), printName) {
		return bambuSourceExternal
	}
	return bambuSourceInternal
}

// externalMediaPath returns the decoded path of a file:// or ftp(s):// url when
// it points into external media.
func externalMediaPath(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	lower := strings.ToLower(raw)
	var rest string
	switch {
	case strings.HasPrefix(lower, "file://"):
		rest = raw[len("file://"):]
	case strings.HasPrefix(lower, "ftp://"):
		rest = raw[len("ftp://"):]
	case strings.HasPrefix(lower, "ftps://"):
		rest = raw[len("ftps://"):]
	default:
		return "", false
	}
	if !strings.HasPrefix(rest, "/") {
		// ftp://host/path: drop the host.
		slash := strings.Index(rest, "/")
		if slash < 0 {
			return "", false
		}
		rest = rest[slash:]
	}
	if decoded, err := url.PathUnescape(rest); err == nil {
		rest = decoded
	}
	path := strings.ToLower(rest)
	for _, prefix := range externalMediaPrefixes {
		if strings.HasPrefix(path, prefix) {
			return rest, true
		}
	}
	return "", false
}

// archiveBaseName strips the archive extensions Bambu appends to a print name.
func archiveBaseName(name string) string {
	name = strings.TrimSpace(name)
	lower := strings.ToLower(name)
	for _, suffix := range []string{".gcode.3mf", ".3mf"} {
		if strings.HasSuffix(lower, suffix) {
			return name[:len(name)-len(suffix)]
		}
	}
	return name
}

// bambuInternalPath is the path inside the printer's internal storage that the
// status document reports for the print (for example /data/Metadata/plate_1.gcode),
// as the snake_case code a run report detail allows (data_metadata_plate_1_gcode).
func bambuInternalPath(state map[string]any) string {
	for _, key := range []string{"gcode_file", "file", "filename"} {
		value := strings.ToLower(strings.TrimSpace(scalarString(state[key])))
		if value == "" {
			continue
		}
		var code strings.Builder
		for _, character := range value {
			switch {
			case character >= 'a' && character <= 'z', character >= '0' && character <= '9':
				code.WriteRune(character)
			case code.Len() > 0 && !strings.HasSuffix(code.String(), "_"):
				code.WriteByte('_')
			}
		}
		result := strings.Trim(code.String(), "_")
		if result == "" || result[0] < 'a' || result[0] > 'z' {
			return ""
		}
		if len(result) > 80 {
			result = result[:80]
		}
		return result
	}
	return ""
}

// InternalStorageRunFacts returns the run's facts when the connector classified
// its print as coming from internal storage.
func (s *Store) InternalStorageRunFacts(
	ctx context.Context,
	assignmentID, runID uuid.UUID,
	kind AdapterKind,
) (bambuRunFacts, bool, error) {
	if kind == "" {
		kind = AdapterBambuH2D
	}
	if !isBambuAdapterKind(kind) {
		return bambuRunFacts{}, false, nil
	}
	state, found, err := s.BambuStateFor(ctx, assignmentID, kind)
	if err != nil || !found {
		return bambuRunFacts{}, false, err
	}
	facts, ok := state.RunFacts[runID.String()]
	return facts, ok && facts.Source == bambuSourceInternal, nil
}
