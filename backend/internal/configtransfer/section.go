package configtransfer

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	configtransferdb "github.com/Basmatireis/Makerspace-Core/backend/internal/configtransfer/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
)

// section is one transferable part of the configuration. Adding a section means writing its exporter, validator and
// importer and listing it in registry; the engine, the HTTP layer and the fingerprint need no change.
type section struct {
	key SectionKey
	// read is required to export the section, read and manage to import it.
	read, manage []authorization.Permission
	// export reads the canonical value of the section; stored files are represented by their SHA-256 only.
	export func(context.Context, *configtransferdb.Queries) (any, error)
	// attach adds the content of stored files to an exported value after the read transaction closed.
	attach func(context.Context, *files.Service, any) (any, error)
	// decode parses and validates the section strictly.
	decode func(json.RawMessage) (any, error)
	// apply creates and updates entries and returns the step that handles entries missing from the file, which the
	// engine runs in overwrite mode only.
	apply func(*run, any) (func() error, error)
}

// registry lists the sections in import order: a section only references sections before it.
var registry = []section{
	deviceTypesSection(),
	sessionPoliciesSection(),
	rolesSection(),
	machineTypesSection(),
	competenciesSection(),
	trainingsSection(),
	materialTypesSection(),
	machinesSection(),
	inventoryArticlesSection(),
	pricingSection(),
	openDayRequirementsSection(),
	visitorEnrollmentSection(),
	brandingSection(),
	labRulesSection(),
	surveysSection(),
	mailSection(),
	invoicingSection(),
}

func sectionByKey(key SectionKey) (section, bool) {
	for _, definition := range registry {
		if definition.key == key {
			return definition, true
		}
	}
	return section{}, false
}

// define builds a section from typed functions.
func define[T any](
	key SectionKey,
	read, manage []authorization.Permission,
	export func(context.Context, *configtransferdb.Queries) (T, error),
	validate func(*T) error,
	apply func(*run, *T) (func() error, error),
) section {
	return section{
		key:    key,
		read:   read,
		manage: manage,
		export: func(ctx context.Context, q *configtransferdb.Queries) (any, error) { return export(ctx, q) },
		decode: func(raw json.RawMessage) (any, error) {
			var value T
			if err := decodeStrict(raw, &value); err != nil {
				return nil, invalidSection(key, jsonReason(err))
			}
			if err := validate(&value); err != nil {
				return nil, invalidSection(key, err.Error())
			}
			return &value, nil
		},
		apply: func(r *run, value any) (func() error, error) {
			typed, ok := value.(*T)
			if !ok {
				return nil, fmt.Errorf("section %s decoded to %T", key, value)
			}
			return apply(r, typed)
		},
	}
}

func permissions(values ...authorization.Permission) []authorization.Permission { return values }

// nameKey is the case-insensitive natural key of a named entry.
func nameKey(name string) string { return strings.ToLower(strings.TrimSpace(name)) }

// checkNames trims names in place and refuses empty, overlong and duplicate (ignoring case) names.
func checkNames(what string, names []*string, maxLength int) error {
	if len(names) > maxEntriesPerSection {
		return fmt.Errorf("too many %s entries", what)
	}
	seen := map[string]bool{}
	for _, name := range names {
		*name = strings.TrimSpace(*name)
		if *name == "" || len([]rune(*name)) > maxLength {
			return fmt.Errorf("%s names must be between 1 and %d characters", what, maxLength)
		}
		key := nameKey(*name)
		if seen[key] {
			return fmt.Errorf("%s %q appears twice", what, *name)
		}
		seen[key] = true
	}
	return nil
}

// trimmed normalizes an optional text like the services do: surrounding space is removed and empty means absent.
func trimmed(value *string) *string {
	if value == nil {
		return nil
	}
	v := strings.TrimSpace(*value)
	if v == "" {
		return nil
	}
	return &v
}

func sameText(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func ptr[T any](value T) *T { return &value }
