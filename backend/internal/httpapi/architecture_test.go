package httpapi

import (
	"go/parser"
	"go/token"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// repositoryImport matches the sqlc packages that every feature generates under internal/<feature>/db.
var repositoryImport = regexp.MustCompile(`^github\.com/Basmatireis/Makerspace-Core/backend/internal/[^/]+/db$`)

// Handlers translate transport concerns and call services; sqlc rows stay behind the service.
func TestHandlersDoNotImportRepositories(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	fileSet := token.NewFileSet()
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fileSet, name, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, spec := range file.Imports {
			path, err := strconv.Unquote(spec.Path.Value)
			if err != nil {
				t.Fatal(err)
			}
			if repositoryImport.MatchString(path) {
				t.Errorf("%s imports repository package %s; call the feature service instead", name, path)
			}
		}
	}
}
