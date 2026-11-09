package staginganonymizer

import (
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacycatalog"
)

// keptPersonalFields are fields of the privacy registry that staging keeps on purpose, with the reason.
var keptPersonalFields = map[string]string{
	"order_items.machine_job_snapshot": "machine, material and price snapshot; it names no person",
	"cash_movements.reason":            "a fixed reason code, not free text",
	"organizations.postal_code":        "an organization's address, not a person's",
	"organizations.locality":           "an organization's address, not a person's",
	"machine_runs.vendor_job_id":       "the number the printer assigned to the job",
}

// TestPrivacyRegistryFieldsAreNotKeptUnnoticed cross-checks the privacy registry: a column that a data
// category declares as personal must be emptied or rewritten, or be listed in keptPersonalFields.
func TestPrivacyRegistryFieldsAreNotKeptUnnoticed(t *testing.T) {
	catalog, err := privacycatalog.Catalog()
	if err != nil {
		t.Fatal(err)
	}
	tables := map[string]Table{}
	for _, table := range Tables {
		tables[table.Name] = table
	}
	for _, definition := range catalog.Definitions() {
		for _, field := range definition.Fields {
			tableName, column, _ := strings.Cut(field, ".")
			table, ok := tables[tableName]
			if !ok {
				t.Errorf("%s (category %s) names a table missing from Tables", field, definition.ID)
				continue
			}
			if table.Emptied != "" {
				continue
			}
			treatment, ok := table.Columns[column]
			if !ok {
				continue // UUID references and timestamps stay and point at anonymized rows.
			}
			if (treatment == System || treatment == Catalog) && keptPersonalFields[field] == "" {
				t.Errorf("%s (category %s) is personal data but kept as %q", field, definition.ID, treatment)
			}
		}
	}
}
