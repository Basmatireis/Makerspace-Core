package openapi

import (
	"path/filepath"
	"regexp"
	"runtime"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
)

func TestEmbeddedSpecificationIsValidAndOperationIDsAreStableStyle(t *testing.T) {
	spec, err := GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	if err := spec.Validate(t.Context()); err != nil {
		t.Fatalf("OpenAPI validation failed: %v", err)
	}
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate OpenAPI test source")
	}
	sourcePath := filepath.Join(filepath.Dir(filename), "..", "..", "..", "api", "openapi.yaml")
	source, err := openapi3.NewLoader().LoadFromFile(sourcePath)
	if err != nil {
		t.Fatalf("load source OpenAPI document: %v", err)
	}
	if err := source.Validate(t.Context()); err != nil {
		t.Fatalf("source OpenAPI validation failed: %v", err)
	}
	if len(source.Servers) != 1 || source.Servers[0].URL != "/api/v1" {
		t.Fatalf("unexpected server base: %#v", source.Servers)
	}

	lowerCamel := regexp.MustCompile(`^[a-z][A-Za-z0-9]*$`)
	seen := map[string]string{}
	operationCount := 0
	for path, item := range source.Paths.Map() {
		for method, operation := range item.Operations() {
			operationCount++
			if !lowerCamel.MatchString(operation.OperationID) {
				t.Errorf("%s %s has non-lower-camel operationId %q", method, path, operation.OperationID)
			}
			if previous, duplicate := seen[operation.OperationID]; duplicate {
				t.Errorf("duplicate operationId %q on %s %s and %s", operation.OperationID, method, path, previous)
			}
			seen[operation.OperationID] = method + " " + path
		}
	}
	if operationCount != 57 {
		t.Fatalf("operation count = %d, want 57", operationCount)
	}
}
