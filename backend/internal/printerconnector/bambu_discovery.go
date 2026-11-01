package printerconnector

import (
	"errors"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"golang.org/x/text/unicode/norm"
)

// Artifact discovery. A Bambu printer may hold a print's 3MF in several places
// at once: its internal eMMC cache, which the connector cannot read, and the
// external USB stick or SD card, which it lists over FTPS directly below / and
// /cache. Where the print runs from and whether a readable archive exists are
// independent questions, so the connector always looks on external storage
// and keeps the execution source only as a diagnostic.
//
// Evidence is weighed in a fixed order: the archive path a status of the
// current session named (directory and name), then the archive name the
// printer reported, then the name derived from the print's subtask_name, and
// finally the truncated print name as a prefix. Names are compared after a
// normalisation (Unicode NFC, case, whitespace runs, Bambu's .gcode.3mf/.3mf
// suffixes); there is no fuzzy matching. When the evidence does not single out
// one archive, discovery says so instead of guessing.
const (
	// postRunArtifactWindow is how long after a run ended the connector keeps
	// looking for an archive that external storage does not hold (yet).
	postRunArtifactWindow = 15 * time.Minute
	// maxArtifactCandidates bounds the archives downloaded to tell duplicates
	// apart: the same name can exist once in / and once in /cache.
	maxArtifactCandidates = 2
)

var (
	errArtifactNotAvailable = errors.New("reported artifact is not available over FTPS")
	errArtifactAmbiguous    = errors.New("reported artifact name is ambiguous over FTPS")
)

// Retrieval diagnostics the connector settles a run's archive with. They are
// reported to Core as the detail of the consumption reason.
const (
	diagnosticArtifactNotAvailable = "artifact_not_available"
	diagnosticArtifactAmbiguous    = "artifact_ambiguous"
	diagnosticArtifactNotArchive   = "artifact_candidate_not_archive"
	diagnosticArtifactRetryExpired = "artifact_retry_expired"
	diagnosticNoArchiveReported    = "no_archive_reported"
	diagnosticArtifactNameMismatch = "artifact_name_mismatch"
	diagnosticArtifactInvalid      = "artifact_invalid"
)

// artifactDirectories are the FTPS directories that hold archives, in the
// order duplicates are preferred: the slicer uploads to /cache.
var artifactDirectories = []string{"/cache", "/"}

// artifactEvidence is what the connector knows about where a run's archive is.
type artifactEvidence struct {
	// ExplicitPath is the archive's FTPS path (directory and name) when the
	// current session named it, or a reported path that carries a directory.
	ExplicitPath string
	// Names are archive names to look for, strongest first.
	Names []string
	// PrintName is the printer's subtask_name; a trailing "..." marks a name
	// the printer truncated.
	PrintName string
}

// artifactEvidenceFor combines the retrieval's reported path with the run's
// facts. Facts are missing for runs recorded by an older connector or evicted
// from the session history; the reported path alone is then the evidence.
func artifactEvidenceFor(reportedPath string, facts bambuRunFacts, known bool) artifactEvidence {
	var evidence artifactEvidence
	add := func(name string) {
		name = strings.TrimSpace(name)
		if name == "" || !isBambuArchivePath(name) {
			return
		}
		for _, existing := range evidence.Names {
			if normalizeArchiveName(existing) == normalizeArchiveName(name) {
				return
			}
		}
		evidence.Names = append(evidence.Names, name)
	}
	if directory, name, ok := splitArtifactPath(reportedPath); ok {
		evidence.ExplicitPath = path.Join(directory, name)
	}
	if known && evidence.ExplicitPath == "" {
		if directory, name, ok := splitArtifactPath(facts.ArchivePath); ok {
			evidence.ExplicitPath = path.Join(directory, name)
		}
	}
	add(path.Base(strings.ReplaceAll(reportedPath, `\`, "/")))
	if known {
		add(path.Base(facts.ArchivePath))
		add(facts.ArchiveCandidate)
		evidence.PrintName = facts.PrintName
		if evidence.PrintName != "" {
			add(evidence.PrintName + ".gcode.3mf")
		}
	}
	return evidence
}

// splitArtifactPath accepts a path directly below / or /cache that ends in
// .3mf and returns its directory and file name.
func splitArtifactPath(value string) (string, string, bool) {
	value = strings.TrimSpace(strings.ReplaceAll(value, `\`, "/"))
	if !strings.Contains(value, "/") || !isBambuArchivePath(value) {
		return "", "", false
	}
	clean := path.Clean("/" + strings.TrimPrefix(value, "/"))
	directory, name := path.Dir(clean), path.Base(clean)
	if (directory != "/" && directory != "/cache") || name == "." || name == "/" || name == "" {
		return "", "", false
	}
	return directory, name, true
}

// bambuFTPSArchivePath maps a url or path the printer reported for a print onto
// the FTPS path of its archive: /media/usbN/cache/X and /sdcard/cache/X become
// /cache/X, the media roots become /X. A path that is not on external media,
// an ftp url that names only a file, a deeper directory and anything that is
// not an archive give "".
func bambuFTPSArchivePath(raw string) string {
	raw = strings.TrimSpace(raw)
	lower := strings.ToLower(raw)
	var rest string
	switch {
	case strings.HasPrefix(lower, "file://"):
		rest = raw[len("file://"):]
	case strings.HasPrefix(lower, "ftp://"), strings.HasPrefix(lower, "ftps://"):
		rest = raw[strings.Index(raw, "//")+2:]
		if !strings.HasPrefix(rest, "/") {
			slash := strings.Index(rest, "/")
			if slash < 0 {
				// ftp://<file name>: the directory is unknown.
				return ""
			}
			rest = rest[slash:]
		}
	case strings.HasPrefix(raw, "/"):
		rest = raw
	default:
		return ""
	}
	if decoded, err := url.PathUnescape(rest); err == nil {
		rest = decoded
	}
	rest = path.Clean(rest)
	lowerRest := strings.ToLower(rest)
	for _, prefix := range []string{"/media/", "/mnt/sdcard/", "/sdcard/"} {
		if !strings.HasPrefix(lowerRest, prefix) {
			continue
		}
		rest = rest[len(prefix)-1:]
		if prefix == "/media/" {
			// /media/usb0/...: drop the mount point.
			mount := strings.Index(rest[1:], "/")
			if mount < 0 {
				return ""
			}
			rest = rest[mount+1:]
		}
		break
	}
	if strings.HasPrefix(strings.ToLower(rest), "/data/") {
		// The printer's internal storage is not reachable over FTPS.
		return ""
	}
	directory, name, ok := splitArtifactPath(rest)
	if !ok {
		return ""
	}
	return path.Join(directory, name)
}

// normalizeArchiveName makes two spellings of the same archive name compare
// equal: Unicode composition, case, runs of white space and Bambu's archive
// suffixes differ between the printer's status messages and its FTPS listing.
func normalizeArchiveName(name string) string {
	name = norm.NFC.String(strings.TrimSpace(name))
	name = archiveBaseName(name)
	name = strings.ToLower(name)
	return strings.Join(strings.Fields(name), " ")
}

// truncatedPrintName returns the part before a trailing "..." or "…" the
// printer appended when it shortened the print name.
func truncatedPrintName(name string) (string, bool) {
	normalized := normalizeArchiveName(name)
	for _, ellipsis := range []string{"...", "…"} {
		if prefix, ok := strings.CutSuffix(normalized, ellipsis); ok {
			prefix = strings.TrimSpace(prefix)
			return prefix, prefix != ""
		}
	}
	return "", false
}

// discoverArtifacts returns the listed archives the evidence identifies: one
// file, or the same archive name in both directories (which the caller tells
// apart by content). errArtifactNotAvailable means no listed archive matches,
// errArtifactAmbiguous that the evidence fits several different names.
func discoverArtifacts(evidence artifactEvidence, listings map[string][]FTPEntry) ([]ArtifactCandidate, error) {
	if directory, name, ok := splitArtifactPath(evidence.ExplicitPath); ok {
		if matches := matchArchiveName(directory, listings[directory], name); len(matches) == 1 {
			return matches, nil
		}
	}
	for _, name := range evidence.Names {
		var matches []ArtifactCandidate
		for _, directory := range artifactDirectories {
			found := matchArchiveName(directory, listings[directory], name)
			if len(found) > 1 {
				return nil, errArtifactAmbiguous
			}
			matches = append(matches, found...)
		}
		if len(matches) > 0 {
			return matches, nil
		}
	}
	if prefix, ok := truncatedPrintName(evidence.PrintName); ok {
		var matches []ArtifactCandidate
		names := map[string]bool{}
		for _, directory := range artifactDirectories {
			for _, entry := range listings[directory] {
				if entry.IsDir || !isBambuArchivePath(entry.Name) {
					continue
				}
				normalized := normalizeArchiveName(entry.Name)
				if !strings.HasPrefix(normalized, prefix) {
					continue
				}
				names[normalized] = true
				matches = append(matches, candidateFor(directory, entry))
			}
		}
		switch {
		case len(names) > 1:
			return nil, errArtifactAmbiguous
		case len(matches) > 0:
			return matches, nil
		}
	}
	return nil, errArtifactNotAvailable
}

// matchArchiveName returns the archives in one directory that carry the name:
// an exact spelling when the listing has it, otherwise every entry whose
// normalised name equals it (several mean the directory is ambiguous).
func matchArchiveName(directory string, entries []FTPEntry, name string) []ArtifactCandidate {
	for _, entry := range entries {
		if !entry.IsDir && entry.Name == name && isBambuArchivePath(entry.Name) {
			return []ArtifactCandidate{candidateFor(directory, entry)}
		}
	}
	want := normalizeArchiveName(name)
	if want == "" {
		return nil
	}
	var matches []ArtifactCandidate
	for _, entry := range entries {
		if entry.IsDir || !isBambuArchivePath(entry.Name) {
			continue
		}
		if normalizeArchiveName(entry.Name) == want {
			matches = append(matches, candidateFor(directory, entry))
		}
	}
	return matches
}

func candidateFor(directory string, entry FTPEntry) ArtifactCandidate {
	return ArtifactCandidate{RemotePath: path.Join(directory, entry.Name), Name: entry.Name, Size: entry.Size}
}

// archiveNameMatchesPrint applies the rule Core uses for manual uploads: the
// candidate matches the print name case-insensitively without the archive
// suffixes, and a name the printer truncated with "..." matches as a prefix.
func archiveNameMatchesPrint(printName, candidate string) bool {
	want := normalizeArchiveName(printName)
	got := normalizeArchiveName(candidate)
	if want == "" || got == "" {
		return false
	}
	if prefix, truncated := truncatedPrintName(printName); truncated {
		return got == want || strings.HasPrefix(got, prefix)
	}
	return got == want
}

// candidateFingerprint identifies a set of candidates with their sizes, so
// that two listings can be compared for a stable size before downloading.
func candidateFingerprint(candidates []ArtifactCandidate) (string, int64) {
	if len(candidates) == 1 {
		return candidates[0].RemotePath, candidates[0].Size
	}
	parts := make([]string, 0, len(candidates))
	var total int64
	for _, candidate := range candidates {
		parts = append(parts, candidate.RemotePath+"="+strconv.FormatInt(candidate.Size, 10))
		total += candidate.Size
	}
	return strings.Join(parts, "\n"), total
}
