package integration_test

import (
	"sort"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/staginganonymizer"
)

// TestStagingAnonymizerCoversEverySchemaColumn keeps staginganonymizer.Tables in step with the schema: a new
// table, or a new column that can hold text in a kept table, fails here until it is classified, so personal
// data cannot reach staging unnoticed.
func TestStagingAnonymizerCoversEverySchemaColumn(t *testing.T) {
	pool := migratedPool(t)
	rows, err := pool.Query(testContext(t), `
		SELECT t.table_name::text, c.column_name::text,
		       c.data_type IN ('text', 'character varying', 'character', 'bytea', 'jsonb', 'json', 'xml', 'inet', 'cidr',
		                       'ARRAY', 'USER-DEFINED')
		FROM information_schema.tables t
		JOIN information_schema.columns c ON c.table_schema = t.table_schema AND c.table_name = t.table_name
		WHERE t.table_schema = current_schema() AND t.table_type = 'BASE TABLE' AND t.table_name <> 'goose_db_version'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	tablesInDatabase := map[string]bool{}
	textColumnsInDatabase := map[string]bool{}
	for rows.Next() {
		var table, column string
		var holdsText bool
		if err := rows.Scan(&table, &column, &holdsText); err != nil {
			t.Fatal(err)
		}
		tablesInDatabase[table] = true
		if holdsText {
			textColumnsInDatabase[table+"."+column] = true
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}

	declared := map[string]staginganonymizer.Table{}
	var problems []string
	for _, table := range staginganonymizer.Tables {
		if _, duplicate := declared[table.Name]; duplicate {
			problems = append(problems, "declared twice: "+table.Name)
		}
		declared[table.Name] = table
		if table.Emptied != "" && len(table.Columns) > 0 {
			problems = append(problems, "emptied table lists columns: "+table.Name)
		}
		if !tablesInDatabase[table.Name] {
			problems = append(problems, "declared table no longer exists: "+table.Name)
		}
		for column := range table.Columns {
			if !textColumnsInDatabase[table.Name+"."+column] {
				problems = append(problems, "declared column is not a text column of the schema: "+table.Name+"."+column)
			}
		}
	}
	for table := range tablesInDatabase {
		if _, ok := declared[table]; !ok {
			problems = append(problems, "table not classified in staginganonymizer.Tables: "+table)
		}
	}
	for key := range textColumnsInDatabase {
		table, column, _ := strings.Cut(key, ".")
		declaration, ok := declared[table]
		if !ok || declaration.Emptied != "" {
			continue
		}
		if _, ok := declaration.Columns[column]; !ok {
			problems = append(problems, "text column not classified in staginganonymizer.Tables: "+key)
		}
	}
	sort.Strings(problems)
	for _, problem := range problems {
		t.Error(problem)
	}
}
