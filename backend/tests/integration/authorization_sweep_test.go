package integration_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/getkin/kin-openapi/openapi3"
)

// selfServiceOperations lists the session-protected operations that legitimately answer any signed-in
// person, whatever permissions their role holds. Adding an operation here is an authorization decision:
// the reason must say why no permission is needed.
var selfServiceOperations = map[string]string{
	"AnswerOwnNotificationConsents":     "records the caller's own notification consent answers",
	"ChangeOwnPassword":                 "changes the caller's own password after checking the current one",
	"CompletePasskeyReauthentication":   "re-authenticates the caller's own session with a passkey",
	"ConfirmOwnLaborordnung":            "confirms the lab rules for the caller only",
	"ConfirmTotpEnrollment":             "finishes the caller's own TOTP enrolment",
	"CreateMyCalendarFeed":              "creates the caller's own calendar feed link",
	"CreateOwnNotificationSubscription": "subscribes the caller to their own notifications",
	"GetCurrentUser":                    "returns the caller's own account and permissions",
	"GetMyCalendarFeed":                 "returns the caller's own calendar feed link",
	"GetNotificationCatalog":            "any staff session; entries needing a permission the caller lacks are left out",
	"GetNotificationUnreadCount":        "counts the caller's own notifications",
	"GetOwnLaborordnungStatus":          "returns the caller's own lab rules status",
	"GetOwnNotificationSettings":        "returns the caller's own notification settings",
	"GetOwnSecondFactors":               "lists the caller's own second factors",
	"GetPersonalDashboard":              "returns the caller's own dashboard",
	"ListMyGuideProgress":               "returns the caller's own guide progress",
	"ListMyAccountPreferences":          "returns the caller's own interface preferences",
	"ListNotifications":                 "lists the caller's own notifications",
	"ListOwnNotificationSubscriptions":  "lists the caller's own notification subscriptions",
	"ListOwnPublicEventAssignments":     "lists the caller's own assignments to an event",
	"Logout":                            "ends the caller's own session",
	"MarkAllNotificationsRead":          "marks the caller's own notifications read",
	"Reauthenticate":                    "re-authenticates the caller's own session with their password",
	"RecordSessionActivity":             "keeps the caller's own session alive",
	"RegisterPasskey":                   "finishes registering a passkey for the caller's own account",
	"RequestOwnEmailVerification":       "sends a verification mail to the caller's own address",
	"ResetMyGuideProgress":              "clears the caller's own guide progress",
	"RevokeMyCalendarFeed":              "revokes the caller's own calendar feed link",
	"StartPasskeyReauthentication":      "starts re-authentication of the caller's own session",
	"StartPasskeyRegistration":          "starts registering a passkey for the caller's own account",
	"StartTotpEnrollment":               "starts TOTP enrolment for the caller's own account",
	"UpdateMyGuideProgress":             "records the caller's own guide progress",
	"UpdateMyAccountPreference":         "stores one of the caller's own interface preferences",
}

// unprobedOperations lists the session-protected operations the sweep cannot exercise because the request
// it generates fails contract or handler validation before authorization runs, with the reason. An entry
// is a gap in the proof, not an exemption: fix the generator or the operation's test instead of adding one.
var unprobedOperations = map[string]string{}

// refusalCodes are the error codes that prove a request was refused for lack of authority, as opposed to
// being turned away earlier for an unrelated reason such as a missing CSRF token or a dead session.
var refusalCodes = map[int]string{
	http.StatusForbidden: "permission_denied",
	http.StatusNotFound:  "not_found",
}

// TestEverySessionProtectedOperationRefusesACallerWithoutPermissions calls every operation the contract
// protects with a session, as a person whose role grants nothing, and requires each to refuse unless it is
// declared as self-service. A new endpoint that forgets its authorization check fails here.
func TestEverySessionProtectedOperationRefusesACallerWithoutPermissions(t *testing.T) {
	pool := migratedPool(t)
	spec, err := openapi.GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	const origin = "http://makerspace.example.test"
	server := newManagedDeviceHTTPServer(t, pool, origin)
	defer server.Close()
	client := &http.Client{
		Timeout:       10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}

	roleID := ids.New()
	if _, err := pool.Exec(
		testContext(t), `INSERT INTO roles(id,name) VALUES($1,'Sweep role without grants')`, roleID,
	); err != nil {
		t.Fatal(err)
	}
	// Every new person becomes a Visitor by trigger, so the Visitor role must grant nothing in this schema
	// for the sweep person to hold no permissions at all.
	if _, err := pool.Exec(testContext(t), `
		DELETE FROM role_permission_grants
		WHERE role_id IN (SELECT id FROM roles WHERE system_key = 'visitor')`); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `
		SELECT count(*) FROM role_permission_grants g JOIN roles r ON r.id = g.role_id
		WHERE r.system_key = 'visitor' OR r.id = $1`, 0, roleID)

	type probe struct {
		method, path string
		operation    *openapi3.Operation
		params       openapi3.Parameters
	}
	var probes []probe
	for path, item := range spec.Paths.Map() {
		for method, operation := range item.Operations() {
			if sweepRequiresSession(spec, operation) {
				params := append(openapi3.Parameters{}, item.Parameters...)
				probes = append(probes, probe{method, path, operation, append(params, operation.Parameters...)})
			}
		}
	}
	sort.Slice(probes, func(i, j int) bool { return probes[i].operation.OperationID < probes[j].operation.OperationID })
	known := map[string]bool{}
	for _, p := range probes {
		known[p.operation.OperationID] = true
	}
	for operationID := range selfServiceOperations {
		if !known[operationID] {
			t.Errorf("selfServiceOperations names %s, which is not a session-protected operation", operationID)
		}
		if _, both := unprobedOperations[operationID]; both {
			t.Errorf("%s is listed as both self-service and unprobed", operationID)
		}
	}
	for operationID := range unprobedOperations {
		if !known[operationID] {
			t.Errorf("unprobedOperations names %s, which is not a session-protected operation", operationID)
		}
	}

	var refused, allowlisted, unprobed int
	var refusedByNotFound []string
	statuses := map[string]int{}
	for index, p := range probes {
		operationID := p.operation.OperationID
		// Every request gets its own person and session, so no operation depends on what an earlier one
		// changed (a logout or password change would otherwise turn later requests into plain 401s).
		account := seedAccount(t, pool, fmt.Sprintf("sweep-%d", index), false)
		if _, err := pool.Exec(
			testContext(t), `INSERT INTO person_roles(person_id,role_id) VALUES($1,$2)`, account.personID, roleID,
		); err != nil {
			t.Fatal(err)
		}
		sessionToken, csrfToken := insertTestSession(t, pool, account)
		request := sweepRequest(t, p.method, p.path, p.operation, p.params, server.URL, origin, sessionToken, csrfToken)
		response, err := client.Do(request)
		if err != nil {
			t.Errorf("%s: %v", operationID, err)
			continue
		}
		// Only the error code is read, never the body of a successful response.
		var payload struct {
			Code string `json:"code"`
		}
		if response.StatusCode >= http.StatusBadRequest {
			_ = json.NewDecoder(io.LimitReader(response.Body, 1<<16)).Decode(&payload)
		}
		response.Body.Close()
		status, code := response.StatusCode, payload.Code
		statuses[operationID] = status

		_, selfService := selfServiceOperations[operationID]
		_, declaredUnprobed := unprobedOperations[operationID]
		wantedCode, refusalStatus := refusalCodes[status]
		isRefusal := refusalStatus && (wantedCode == code || (status == http.StatusForbidden && code == "reauthentication_required"))
		isUnprobed := status == http.StatusBadRequest || status == http.StatusRequestEntityTooLarge ||
			status == http.StatusUnsupportedMediaType || (status == http.StatusUnprocessableEntity && code == "validation_failed")
		switch {
		case selfService:
			allowlisted++
		case isRefusal:
			refused++
			if status == http.StatusNotFound {
				refusedByNotFound = append(refusedByNotFound, operationID)
			}
			if declaredUnprobed {
				t.Errorf("%s is listed in unprobedOperations but the sweep now probes it; remove the entry", operationID)
			}
		case isUnprobed:
			unprobed++
			if !declaredUnprobed {
				t.Errorf("%s answered %d %s: the generated request is invalid, so the sweep proves nothing; "+
					"fix the generator or list it in unprobedOperations", operationID, status, code)
			} else {
				t.Logf("unprobed: %s (%s)", operationID, unprobedOperations[operationID])
			}
		default:
			t.Errorf("%s %s answered %d %s to a caller with no permissions; enforce a permission in the service "+
				"or, if every signed-in person may call it, add it to selfServiceOperations", operationID, p.method+" "+p.path, status, code)
		}
	}
	if statuses["GetCurrentUser"] != http.StatusOK {
		t.Fatalf("the sweep session is not authenticated (GetCurrentUser answered %d); refusals prove nothing", statuses["GetCurrentUser"])
	}
	sort.Strings(refusedByNotFound)
	t.Logf("operations=%d refused=%d allowlisted=%d unprobed=%d", len(probes), refused, allowlisted, unprobed)
	t.Logf("refused only by a 404 for a random id (the permission check is not proven): %s", strings.Join(refusedByNotFound, " "))
}

func sweepRequiresSession(spec *openapi3.T, operation *openapi3.Operation) bool {
	requirements := spec.Security
	if operation.Security != nil {
		requirements = *operation.Security
	}
	for _, requirement := range requirements {
		if _, ok := requirement["sessionCookie"]; ok {
			return true
		}
	}
	return false
}

func sweepRequest(
	t *testing.T,
	method, path string,
	operation *openapi3.Operation,
	params openapi3.Parameters,
	serverURL, origin, sessionToken, csrfToken string,
) *http.Request {
	t.Helper()
	query := url.Values{}
	headers := http.Header{}
	for _, ref := range params {
		param := ref.Value
		generated := sweepValue(param.Schema, 0)
		values := []string{fmt.Sprint(generated)}
		if items, isArray := generated.([]any); isArray {
			values = values[:0]
			for _, item := range items {
				values = append(values, fmt.Sprint(item))
			}
		}
		value := strings.Join(values, ",")
		switch param.In {
		case "path":
			path = strings.ReplaceAll(path, "{"+param.Name+"}", url.PathEscape(value))
		case "query":
			if param.Required {
				for _, item := range values {
					query.Add(param.Name, item)
				}
			}
		case "header":
			if param.Required {
				headers.Set(param.Name, value)
			}
		}
	}
	var body io.Reader
	contentType := ""
	if operation.RequestBody != nil && operation.RequestBody.Value != nil {
		content := operation.RequestBody.Value.Content
		if media := content.Get("application/json"); media != nil {
			generated := sweepValue(media.Schema, 0)
			encoded, err := json.Marshal(generated)
			if err != nil {
				t.Fatal(err)
			}
			body, contentType = bytes.NewReader(encoded), "application/json"
		} else {
			names := make([]string, 0, len(content))
			for name := range content {
				names = append(names, name)
			}
			sort.Strings(names)
			body, contentType = bytes.NewReader([]byte("sweep")), names[0]
		}
	}
	target := serverURL + "/api/v1" + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	request, err := http.NewRequestWithContext(testContext(t), method, target, body)
	if err != nil {
		t.Fatal(err)
	}
	for name, values := range headers {
		request.Header[name] = values
	}
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	request.Header.Set("Origin", origin)
	request.Header.Set("X-CSRF-Token", csrfToken)
	request.AddCookie(&http.Cookie{Name: "makerspace_session", Value: sessionToken})
	request.AddCookie(&http.Cookie{Name: "makerspace_csrf", Value: csrfToken})
	return request
}

func sweepValue(ref *openapi3.SchemaRef, depth int) any {
	if ref == nil || ref.Value == nil || depth > 8 {
		return nil
	}
	schema := ref.Value
	switch {
	case len(schema.AllOf) > 0:
		merged := map[string]any{}
		var scalar any
		for _, member := range schema.AllOf {
			value := sweepValue(member, depth+1)
			if object, ok := value.(map[string]any); ok {
				for key, v := range object {
					merged[key] = v
				}
			} else if value != nil {
				scalar = value
			}
		}
		if len(merged) == 0 && scalar != nil {
			return scalar
		}
		for name, property := range schema.Properties {
			if sweepRequired(schema, name) {
				merged[name] = sweepValue(property, depth+1)
			}
		}
		return merged
	case len(schema.OneOf) > 0:
		return sweepValue(schema.OneOf[0], depth+1)
	case len(schema.AnyOf) > 0:
		return sweepValue(schema.AnyOf[0], depth+1)
	}
	if schema.Nullable {
		return nil
	}
	if len(schema.Enum) > 0 {
		return schema.Enum[0]
	}
	switch {
	case schema.Type.Is("string"):
		return sweepString(schema)
	case schema.Type.Is("integer"):
		return int64(sweepNumber(schema))
	case schema.Type.Is("number"):
		return sweepNumber(schema)
	case schema.Type.Is("boolean"):
		return false
	case schema.Type.Is("array"):
		items := make([]any, 0, schema.MinItems)
		for range schema.MinItems {
			items = append(items, sweepValue(schema.Items, depth+1))
		}
		return items
	default:
		object := map[string]any{}
		names := make([]string, 0, len(schema.Properties))
		for name := range schema.Properties {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			if sweepRequired(schema, name) {
				object[name] = sweepValue(schema.Properties[name], depth+1)
			}
		}
		if len(names) == 0 && sweepOpenObject(schema) {
			object["sweep"] = "sweep"
		}
		for _, name := range names {
			if uint64(len(object)) >= schema.MinProps {
				break
			}
			if _, present := object[name]; !present {
				object[name] = sweepValue(schema.Properties[name], depth+1)
			}
		}
		return object
	}
}

// sweepOpenObject reports whether the schema is a free-form object, which the handlers reject when empty.
func sweepOpenObject(schema *openapi3.Schema) bool {
	extra := schema.AdditionalProperties
	return extra.Has != nil && *extra.Has
}

func sweepRequired(schema *openapi3.Schema, name string) bool {
	for _, required := range schema.Required {
		if required == name {
			return true
		}
	}
	return false
}

func sweepNumber(schema *openapi3.Schema) float64 {
	value := 1.0
	if schema.Min != nil {
		value = *schema.Min
		if schema.ExclusiveMin.Bool != nil && *schema.ExclusiveMin.Bool {
			value++
		}
	}
	if schema.Max != nil && value > *schema.Max {
		value = *schema.Max
	}
	return value
}

func sweepString(schema *openapi3.Schema) string {
	switch schema.Format {
	case "uuid":
		return ids.New().String()
	case "date":
		return "2030-01-02"
	case "date-time":
		return "2030-01-02T03:04:05Z"
	case "email":
		return "sweep@example.test"
	case "uri", "url":
		return "https://example.test/sweep"
	}
	// Patterns are not interpreted; the first of a few shapes the contract uses that satisfies the schema wins.
	candidates := []string{
		"sweep", "1", "000000", "1.0.0", "sweep.example", strings.Repeat("a", 43), strings.Repeat("a", 64),
		"#000000", "00:00", "https://example.test/sweep", "https://example.test",
	}
	for _, candidate := range candidates {
		candidate = sweepFitLength(schema, candidate)
		if schema.VisitJSON(candidate) == nil {
			return candidate
		}
	}
	return sweepFitLength(schema, candidates[0])
}

func sweepFitLength(schema *openapi3.Schema, value string) string {
	for uint64(len(value)) < schema.MinLength {
		value += "a"
	}
	if schema.MaxLength != nil && uint64(len(value)) > *schema.MaxLength {
		value = value[:*schema.MaxLength]
	}
	return value
}
