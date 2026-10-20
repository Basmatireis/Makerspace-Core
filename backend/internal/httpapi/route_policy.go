package httpapi

import (
	"context"
	"net/http"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/branding"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/events"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printartifacts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/signage"
	"github.com/getkin/kin-openapi/openapi3"
	"github.com/go-chi/chi/v5"
)

const (
	maxJSONRequestBodyBytes             = 64 << 10
	maxPrinterConnectorEventsBodyBytes  = 512 << 10
	maxVisitorEnrollmentSubmissionBytes = 12 << 20
)

// requestBodyLimits overrides maxJSONRequestBodyBytes for the operations that accept larger
// bodies. Binary uploads get one byte above the feature limit so the service can tell an
// oversized upload from one that is exactly at the limit.
var requestBodyLimits = map[string]int64{
	routeKey(
		http.MethodPost,
		"/printer-connector/self/events",
	): maxPrinterConnectorEventsBodyBytes,
	routeKey(
		http.MethodPut,
		"/printer-connector/self/assignments/{assignmentId}/runs/{runId}/artifact",
	): printartifacts.MaxCompressedSize + 1,
	routeKey(
		http.MethodPut,
		"/people/{personId}/profile-image",
	): people.MaxProfileImageBytes + 1,
	routeKey(
		http.MethodPut,
		"/branding/assets/{slot}",
	): branding.MaxAssetBytes + 1,
	routeKey(
		http.MethodPost,
		"/signage/assets",
	): signage.MaxVideoBytes + 1,
	routeKey(
		http.MethodPost,
		"/laborordnung/versions",
	): laborordnung.MaxPDFBytes + 1,
	routeKey(
		http.MethodPost,
		"/visitor-enrollment/submissions",
	): maxVisitorEnrollmentSubmissionBytes,
	routeKey(
		http.MethodPost,
		"/events/{eventId}/files",
	): events.MaxFileBytes + 1,
}

// revalidatedRoutes may be cached by the browser but must be revalidated on every use. Every
// other API response defaults to Cache-Control: no-store unless its handler sets a policy.
var revalidatedRoutes = map[string]bool{
	routeKey(http.MethodGet, "/public/config"):           true,
	routeKey(http.MethodGet, "/public/legal/{document}"): true,
}

// routePolicy holds the per-operation transport rules derived from api/openapi.yaml, so the
// contract stays the only place that declares which operations need a staff session and which
// stream binary bodies.
type routePolicy struct {
	sessionless map[string]bool
	rawBinary   map[string]bool
}

func newRoutePolicy(spec *openapi3.T) routePolicy {
	policy := routePolicy{sessionless: map[string]bool{}, rawBinary: map[string]bool{}}
	for path, item := range spec.Paths.Map() {
		for method, operation := range item.Operations() {
			key := routeKey(method, path)
			requirements := spec.Security
			if operation.Security != nil {
				requirements = *operation.Security
			}
			policy.sessionless[key] = !requiresSession(requirements)
			policy.rawBinary[key] = hasOnlyBinaryBody(operation)
		}
	}
	return policy
}

func requiresSession(requirements openapi3.SecurityRequirements) bool {
	for _, requirement := range requirements {
		if _, ok := requirement["sessionCookie"]; ok {
			return true
		}
	}
	return false
}

func hasOnlyBinaryBody(operation *openapi3.Operation) bool {
	if operation.RequestBody == nil || operation.RequestBody.Value == nil ||
		len(operation.RequestBody.Value.Content) == 0 {
		return false
	}
	for contentType := range operation.RequestBody.Value.Content {
		if contentType == "application/json" || strings.HasSuffix(contentType, "+json") {
			return false
		}
	}
	return true
}

// routeKey identifies an operation by method and OpenAPI path template (without the API base path).
func routeKey(method, pathTemplate string) string {
	return method + " " + pathTemplate
}

// matchedRoute returns the routeKey of the operation the request addresses, or "" when no
// operation matches its method and path.
func matchedRoute(routes chi.Routes, method, path string) string {
	if routes == nil {
		return ""
	}
	routeContext := chi.NewRouteContext()
	if !routes.Match(routeContext, method, path) {
		return ""
	}
	return routeKey(method, strings.TrimPrefix(routeContext.RoutePattern(), apiBasePath))
}

func requestRoute(ctx context.Context) string {
	value, _ := ctx.Value(normalizedRouteContextKey).(string)
	return value
}

func (p routePolicy) isSessionless(ctx context.Context) bool {
	return p.sessionless[requestRoute(ctx)]
}

func (p routePolicy) isRawBinaryUpload(ctx context.Context) bool {
	return p.rawBinary[requestRoute(ctx)]
}

func requestBodyLimit(ctx context.Context) int64 {
	if limit, ok := requestBodyLimits[requestRoute(ctx)]; ok {
		return limit
	}
	return maxJSONRequestBodyBytes
}
