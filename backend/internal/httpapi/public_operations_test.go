package httpapi

import (
	"flag"
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
)

var updatePublicOperations = flag.Bool(
	"update", false, "rewrite testdata/public_operations.txt from the contract",
)

const publicOperationsGolden = "testdata/public_operations.txt"

// publicOperations lists the operations the contract lets through without a staff session, one
// "METHOD path operationId" line each, using the same route policy the middleware chain enforces.
func publicOperations(t *testing.T) []string {
	t.Helper()
	spec, err := openapi.GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	policy := newRoutePolicy(spec)
	var lines []string
	for path, item := range spec.Paths.Map() {
		for method, operation := range item.Operations() {
			if policy.sessionless[routeKey(method, path)] {
				lines = append(lines, method+" "+path+" "+operation.OperationID)
			}
		}
	}
	sort.Strings(lines)
	return lines
}

// TestPublicOperations pins the set of operations reachable without a session. An operation that
// becomes public, or a new public operation, must be a deliberate, reviewed decision.
func TestPublicOperations(t *testing.T) {
	actual := strings.Join(publicOperations(t), "\n") + "\n"
	if *updatePublicOperations {
		if err := os.WriteFile(publicOperationsGolden, []byte(actual), 0o600); err != nil {
			t.Fatal(err)
		}
		return
	}
	expected, err := os.ReadFile(publicOperationsGolden)
	if err != nil {
		t.Fatal(err)
	}
	if string(expected) == actual {
		return
	}
	known := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSpace(string(expected)), "\n") {
		known[line] = true
	}
	current := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSpace(actual), "\n") {
		current[line] = true
		if !known[line] {
			t.Errorf("operation is public but not in %s: %s", publicOperationsGolden, line)
		}
	}
	for line := range known {
		if !current[line] {
			t.Errorf("operation in %s is no longer public: %s", publicOperationsGolden, line)
		}
	}
	t.Error("the public (sessionless) surface changed: review every added operation for abuse, rate " +
		"limiting and data exposure, then run `go test ./internal/httpapi -run TestPublicOperations -update`")
}
