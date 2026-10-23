package configtransfer

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

const (
	// FormatName identifies a configuration file.
	FormatName = "makerspace-core-config"
	// FormatVersion is the only file format version this release reads and writes.
	FormatVersion = 1
	// MaxFileBytes bounds an import file and an export. It leaves room for custom branding assets and a Lab Rules PDF
	// encoded as base64.
	MaxFileBytes = 64 << 20
	// maxEntriesPerSection bounds every list in a section so a file cannot make the import loop unboundedly.
	maxEntriesPerSection = 5000
)

// SectionKey names one transferable part of the configuration.
type SectionKey string

const (
	SectionDeviceTypes         SectionKey = "deviceTypes"
	SectionSessionPolicies     SectionKey = "sessionPolicies"
	SectionRoles               SectionKey = "roles"
	SectionMachineTypes        SectionKey = "machineTypes"
	SectionCompetencies        SectionKey = "competencies"
	SectionTrainings           SectionKey = "trainings"
	SectionMaterialTypes       SectionKey = "materialTypes"
	SectionMachines            SectionKey = "machines"
	SectionInventoryArticles   SectionKey = "inventoryArticles"
	SectionPricing             SectionKey = "pricing"
	SectionOpenDayRequirements SectionKey = "openDayRequirements"
	SectionVisitorEnrollment   SectionKey = "visitorEnrollment"
	SectionBranding            SectionKey = "branding"
	SectionLabRules            SectionKey = "labRules"
	SectionSurveys             SectionKey = "surveys"
	SectionMail                SectionKey = "mail"
	SectionInvoicing           SectionKey = "invoicing"
)

// Mode is how an import treats entries that already exist.
type Mode string

const (
	// ModeOverwrite makes every chosen section equal the file: matching entries are updated, new ones created and
	// entries missing from the file deleted, or deactivated or kept when they are still in use.
	ModeOverwrite Mode = "overwrite"
	// ModeInsert only creates entries whose natural key does not exist yet.
	ModeInsert Mode = "insert"
)

// Valid reports whether m is a known mode.
func (m Mode) Valid() bool { return m == ModeOverwrite || m == ModeInsert }

// file is the envelope of a configuration file. Sections stay raw until a chosen section is decoded strictly.
type file struct {
	Format     string                         `json:"format"`
	Version    int                            `json:"version"`
	AppVersion string                         `json:"appVersion"`
	ExportedAt time.Time                      `json:"exportedAt"`
	Sections   map[SectionKey]json.RawMessage `json:"sections"`
}

func invalidFile(reason string) *apperror.Error {
	err := apperror.New(http.StatusUnprocessableEntity, "configuration_file_invalid", "The configuration file is invalid")
	err.Details["reason"] = reason
	return err
}

func invalidSection(key SectionKey, reason string) *apperror.Error {
	err := invalidFile(reason)
	err.Details["section"] = string(key)
	return err
}

// readFile reads and checks the envelope. Unknown sections are reported as warnings so a file written by a newer
// release can still be imported section by section.
func readFile(body io.Reader) (file, []string, error) {
	if body == nil {
		return file{}, nil, invalidFile("the request has no file")
	}
	raw, err := io.ReadAll(io.LimitReader(body, MaxFileBytes+1))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return file{}, nil, fileTooLarge()
		}
		return file{}, nil, err
	}
	if len(raw) > MaxFileBytes {
		return file{}, nil, fileTooLarge()
	}
	var parsed file
	if err := decodeStrict(raw, &parsed); err != nil {
		return file{}, nil, invalidFile("the file is not a configuration file: " + jsonReason(err))
	}
	if parsed.Format != FormatName {
		return file{}, nil, invalidFile("the file is not a Makerspace Core configuration file")
	}
	if parsed.Version != FormatVersion {
		e := apperror.New(
			http.StatusUnprocessableEntity,
			"configuration_version_unsupported",
			"This configuration file version is not supported",
		)
		e.Details["version"] = parsed.Version
		return file{}, nil, e
	}
	if utf8.RuneCountInString(parsed.AppVersion) > 64 {
		return file{}, nil, invalidFile("appVersion is too long")
	}
	if parsed.Sections == nil {
		return file{}, nil, invalidFile("the file has no sections")
	}
	var warnings []string
	for key := range parsed.Sections {
		if _, ok := sectionByKey(key); !ok {
			warnings = append(warnings, fmt.Sprintf("The file section %q is not known to this release and was ignored.", key))
		}
	}
	sortStrings(warnings)
	return parsed, warnings, nil
}

func fileTooLarge() *apperror.Error {
	return apperror.New(
		http.StatusRequestEntityTooLarge,
		"configuration_file_too_large",
		"The configuration file exceeds 64 MiB",
	)
}

// decodeStrict decodes exactly one JSON value and refuses unknown fields.
func decodeStrict(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if decoder.More() {
		return errors.New("unexpected data after the JSON value")
	}
	return nil
}

// jsonReason turns a decoding error into a short reason that names the field but never echoes file content.
func jsonReason(err error) string {
	var syntax *json.SyntaxError
	var typeErr *json.UnmarshalTypeError
	switch {
	case errors.As(err, &syntax):
		return fmt.Sprintf("malformed JSON at byte %d", syntax.Offset)
	case errors.As(err, &typeErr):
		return fmt.Sprintf("field %q has the wrong type", typeErr.Field)
	case strings.HasPrefix(err.Error(), "json: unknown field "):
		return "unknown field " + strings.TrimPrefix(err.Error(), "json: unknown field ")
	case errors.Is(err, io.EOF):
		return "the file is empty"
	default:
		return "the JSON value is invalid"
	}
}
