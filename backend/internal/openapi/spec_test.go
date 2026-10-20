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
	if operationCount != 383 {
		t.Fatalf("operation count = %d, want 383", operationCount)
	}
}

// Request validation checks every allOf member against the whole body, so a
// closed member (additionalProperties: false) rejects the properties that the
// other members add. Request schemas must spell such objects out instead.
func TestRequestBodiesHaveNoClosedAllOfMembers(t *testing.T) {
	spec, err := GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	seen := map[*openapi3.Schema]bool{}
	var walk func(where string, ref *openapi3.SchemaRef)
	walk = func(where string, ref *openapi3.SchemaRef) {
		if ref == nil || ref.Value == nil || seen[ref.Value] {
			return
		}
		schema := ref.Value
		seen[schema] = true
		for i, member := range schema.AllOf {
			closed := member.Value.AdditionalProperties.Has
			if closed == nil || *closed {
				continue
			}
			for j, other := range schema.AllOf {
				for name := range other.Value.Properties {
					if _, declared := member.Value.Properties[name]; i != j && !declared {
						t.Errorf("%s: closed allOf member %d rejects property %q of member %d", where, i, name, j)
					}
				}
			}
		}
		for _, list := range [][]*openapi3.SchemaRef{schema.AllOf, schema.OneOf, schema.AnyOf} {
			for _, child := range list {
				walk(where, child)
			}
		}
		for name, child := range schema.Properties {
			walk(where+"."+name, child)
		}
		walk(where+"[]", schema.Items)
		walk(where+"{}", schema.AdditionalProperties.Schema)
	}
	for path, item := range spec.Paths.Map() {
		for method, operation := range item.Operations() {
			if operation.RequestBody == nil || operation.RequestBody.Value == nil {
				continue
			}
			for _, media := range operation.RequestBody.Value.Content {
				walk(method+" "+path, media.Schema)
			}
		}
	}
}
