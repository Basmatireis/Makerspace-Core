package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/visitor"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	nethttpmiddleware "github.com/oapi-codegen/nethttp-middleware"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
)

const (
	maxJSONRequestBodyBytes  = 64 << 10
	maxImageRequestBodyBytes = 9 << 20
	maxPDFRequestBodyBytes   = 26 << 20
	maxLogPathBytes          = 1024
	maxUserAgentBytes        = 512
	csrfHeaderName           = "X-CSRF-Token"
	requestIDHeaderName      = "X-Request-ID"
	forwardedForHeader       = "X-Forwarded-For"
)

type contextKey uint8

const (
	requestIDContextKey contextKey = iota
	authenticatedContextKey
	sourceAddressContextKey
	operationStateContextKey
	normalizedRouteContextKey
	oidcFlowTokenContextKey
	scimConnectorContextKey
	visitorDeviceContextKey
	visitorEnrollmentContextKey
)

type operationState struct{ name string }

func NewHandler(pool *pgxpool.Pool, cfg config.Config, logger *slog.Logger) (http.Handler, error) {
	server, err := NewServer(pool, cfg)
	if err != nil {
		return nil, err
	}
	if logger == nil {
		logger = slog.Default()
	}

	strict := openapi.NewStrictHandlerWithOptions(server, []openapi.StrictMiddlewareFunc{captureOperation}, openapi.StrictHTTPServerOptions{
		RequestErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			writeAPIError(w, r, invalidRequest("request could not be decoded"), logger)
		},
		ResponseErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			writeAPIError(w, r, err, logger)
		},
	})

	router := chi.NewRouter()
	router.NotFound(func(w http.ResponseWriter, r *http.Request) {
		writeAPIError(w, r, apperror.NotFound, logger)
	})
	router.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		writeAPIError(w, r, apperror.New(http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed"), logger)
	})
	generated := openapi.HandlerWithOptions(strict, openapi.ChiServerOptions{
		BaseURL:    apiBasePath,
		BaseRouter: router,
		ErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			writeAPIError(w, r, invalidRequest("request parameters are invalid"), logger)
		},
	})

	spec, err := openapi.GetSwagger()
	if err != nil {
		return nil, fmt.Errorf("load embedded OpenAPI specification: %w", err)
	}
	validator := nethttpmiddleware.OapiRequestValidatorWithOptions(spec, &nethttpmiddleware.Options{
		DoNotValidateServers: true,
		Prefix:               apiBasePath,
		Options: openapi3filter.Options{
			AuthenticationFunc: func(context.Context, *openapi3filter.AuthenticationInput) error {
				// Authentication and CSRF are deliberately enforced below using the
				// runtime-configured cookie names and current PostgreSQL state.
				return nil
			},
		},
		ErrorHandlerWithOpts: func(_ context.Context, _ error, w http.ResponseWriter, r *http.Request, opts nethttpmiddleware.ErrorHandlerOpts) {
			if opts.StatusCode == http.StatusNotFound {
				writeAPIError(w, r, apperror.NotFound, logger)
				return
			}
			if opts.StatusCode >= http.StatusInternalServerError {
				writeAPIError(w, r, errors.New("OpenAPI request validation failed internally"), logger)
				return
			}
			writeAPIError(w, r, invalidRequest("request does not match the API contract"), logger)
		},
	})

	var handler http.Handler = generated
	handler = server.authenticationMiddleware(handler, logger)
	handler = server.originMiddleware(handler, logger)
	handler = validator(handler)
	handler = maxBodyMiddleware(handler)
	handler = noStoreMiddleware(handler)
	handler = recoveryMiddleware(handler, logger)
	handler = traceMiddleware(handler)
	handler = accessLogMiddleware(handler, logger, cfg.HTTPTrustedProxies)
	handler = requestMetadataMiddleware(handler, router)
	return handler, nil
}

func (s *Server) authenticationMiddleware(next http.Handler, logger *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if cookie, err := r.Cookie(s.config.OIDCFlowCookieName); err == nil {
			r = r.WithContext(context.WithValue(r.Context(), oidcFlowTokenContextKey, cookie.Value))
		}
		if isSCIMPath(r.URL.Path) {
			scheme, token, found := strings.Cut(strings.TrimSpace(r.Header.Get("Authorization")), " ")
			if !found || !strings.EqualFold(scheme, "Bearer") || strings.TrimSpace(token) == "" {
				writeSCIMAuthenticationError(w, r, logger)
				return
			}
			connector, err := s.scim.Authenticate(r.Context(), strings.TrimSpace(token))
			if err != nil {
				writeSCIMServiceError(w, r, err, logger)
				return
			}
			ctx := context.WithValue(r.Context(), scimConnectorContextKey, connector)
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}
		if isVisitorEnrollmentPublicPath(r.URL.Path) {
			headerToken := r.Header.Get("X-Managed-Device-Token")
			browserToken := ""
			if cookie, err := r.Cookie(s.config.ManagedDeviceCookieName); err == nil {
				browserToken = cookie.Value
			}
			if headerToken != "" && browserToken != "" {
				writeAPIError(w, r, apperror.New(http.StatusBadRequest, "managed_device_credentials_conflict", "Use either native or browser managed-device credentials, not both"), logger)
				return
			}
			token := headerToken
			if token == "" {
				token = browserToken
			}
			device, err := s.managedDevices.Authenticate(r.Context(), token)
			if err != nil {
				writeAPIError(w, r, err, logger)
				return
			}
			if device == nil {
				writeAPIError(w, r, apperror.NotFound, logger)
				return
			}
			ctx := context.WithValue(r.Context(), visitorDeviceContextKey, *device)
			if r.URL.Path != apiBasePath+"/visitor-enrollment/context" {
				cookie, err := r.Cookie(s.config.EnrollmentCookieName)
				if err != nil {
					writeAPIError(w, r, apperror.Unauthenticated, logger)
					return
				}
				enrollment, err := s.visitor.AuthenticateContext(ctx, cookie.Value)
				if err != nil || enrollment.ManagedDeviceID != device.ID {
					if err == nil {
						err = apperror.Unauthenticated
					}
					writeAPIError(w, r, err, logger)
					return
				}
				if isUnsafeMethod(r.Method) {
					csrfCookie, cookieErr := r.Cookie(s.config.EnrollmentCSRFName)
					if cookieErr != nil || visitor.ValidateCSRF(enrollment, cookieValue(csrfCookie), r.Header.Get("X-Enrollment-CSRF-Token")) != nil {
						writeAPIError(w, r, apperror.New(http.StatusForbidden, "csrf_invalid", "CSRF validation failed"), logger)
						return
					}
				}
				ctx = context.WithValue(ctx, visitorEnrollmentContextKey, enrollment)
			}
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}
		if isPublicPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		cookie, err := r.Cookie(s.config.SessionCookieName)
		if err != nil {
			writeAPIError(w, r, apperror.Unauthenticated, logger)
			return
		}
		authenticated, err := s.auth.Authenticate(r.Context(), cookie.Value)
		if err != nil {
			writeAPIError(w, r, err, logger)
			return
		}
		headerDeviceToken := r.Header.Get("X-Managed-Device-Token")
		browserDeviceCookie, browserCookieErr := r.Cookie(s.config.ManagedDeviceCookieName)
		browserDeviceToken := ""
		if browserCookieErr == nil {
			browserDeviceToken = browserDeviceCookie.Value
		}
		if headerDeviceToken != "" && browserDeviceToken != "" {
			writeAPIError(w, r, apperror.New(http.StatusBadRequest, "managed_device_credentials_conflict", "Use either native or browser managed-device credentials, not both"), logger)
			return
		}
		deviceToken := headerDeviceToken
		if deviceToken == "" {
			deviceToken = browserDeviceToken
		}
		device, err := s.managedDevices.Authenticate(r.Context(), deviceToken)
		if err != nil {
			writeAPIError(w, r, err, logger)
			return
		}
		var deviceContext *authorization.ManagedDevice
		if device != nil {
			deviceContext = &authorization.ManagedDevice{ID: device.ID, Name: device.Name, DeviceTypeID: device.DeviceTypeID, DeviceTypeName: device.DeviceTypeName, ExpiresAt: device.ExpiresAt}
		}
		if deviceContext != nil {
			authenticated, err = s.auth.WithDevice(r.Context(), authenticated, deviceContext)
			if err != nil {
				writeAPIError(w, r, err, logger)
				return
			}
		}
		if isUnsafeMethod(r.Method) {
			csrfCookie, err := r.Cookie(s.config.CSRFCookieName)
			if err != nil {
				writeAPIError(w, r, apperror.New(http.StatusForbidden, "csrf_invalid", "CSRF validation failed"), logger)
				return
			}
			if err := auth.ValidateCSRF(authenticated, csrfCookie.Value, r.Header.Get(csrfHeaderName)); err != nil {
				writeAPIError(w, r, err, logger)
				return
			}
		}
		ctx := context.WithValue(r.Context(), authenticatedContextKey, authenticated)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (s *Server) originMiddleware(next http.Handler, logger *slog.Logger) http.Handler {
	expectedOrigin := s.config.PublicBaseURL.Scheme + "://" + s.config.PublicBaseURL.Host
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isSCIMPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		if isUnsafeMethod(r.Method) && r.Header.Get("Origin") != expectedOrigin {
			writeAPIError(w, r, apperror.New(http.StatusForbidden, "origin_invalid", "Request origin is not allowed"), logger)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func requestMetadataMiddleware(next http.Handler, routes chi.Routes) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := uuid.Must(uuid.NewV7())
		w.Header().Set(requestIDHeaderName, requestID.String())
		ctx := context.WithValue(r.Context(), requestIDContextKey, requestID)
		ctx = context.WithValue(ctx, sourceAddressContextKey, remoteHost(r.RemoteAddr))
		ctx = context.WithValue(ctx, operationStateContextKey, &operationState{})
		ctx = context.WithValue(ctx, normalizedRouteContextKey, matchedRoutePattern(routes, r.Method, r.URL.Path))
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func maxBodyMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil {
			limit := int64(maxJSONRequestBodyBytes)
			if strings.HasSuffix(r.URL.Path, "/profile-image") {
				limit = maxImageRequestBodyBytes
			} else if r.URL.Path == apiBasePath+"/laborordnung/versions" {
				limit = maxPDFRequestBodyBytes
			} else if r.URL.Path == apiBasePath+"/visitor-enrollment/submissions" {
				limit = 12 << 20
			}
			r.Body = http.MaxBytesReader(w, r.Body, limit)
		}
		next.ServeHTTP(w, r)
	})
}

func noStoreMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, apiBasePath+"/auth/") || strings.HasSuffix(r.URL.Path, "/password-reset") ||
			strings.HasPrefix(r.URL.Path, apiBasePath+"/visitor-enrollment/") ||
			strings.HasSuffix(r.URL.Path, "/invitations") || strings.HasSuffix(r.URL.Path, "/pin-enrollment") ||
			(r.Method == http.MethodPost && (r.URL.Path == apiBasePath+"/managed-devices" || r.URL.Path == apiBasePath+"/scim/connectors")) || strings.HasSuffix(r.URL.Path, "/token") {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

func recoveryMiddleware(next http.Handler, logger *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recover() != nil {
				logger.ErrorContext(r.Context(), "recovered request panic", "request_id", requestIDString(r.Context()))
				writeAPIError(w, r, errors.New("request panic"), logger)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

type responseRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (r *responseRecorder) WriteHeader(status int) {
	if r.status != 0 {
		return
	}
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *responseRecorder) Write(body []byte) (int, error) {
	if r.status == 0 {
		r.WriteHeader(http.StatusOK)
	}
	written, err := r.ResponseWriter.Write(body)
	r.bytes += written
	return written, err
}

func (r *responseRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func accessLogMiddleware(next http.Handler, logger *slog.Logger, trustedProxies []netip.Prefix) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		recorder := &responseRecorder{ResponseWriter: w}
		next.ServeHTTP(recorder, r)
		status := recorder.status
		if status == 0 {
			status = http.StatusOK
		}
		route := operationName(r.Context())
		if route == "" {
			route = normalizedRoute(r.Context())
		}
		if route == "" {
			route = "unmatched"
		}
		attributes := []any{
			"request_id", requestIDString(r.Context()),
			"method", r.Method,
			"route", route,
		}
		if route == "unmatched" {
			attributes = append(attributes, "path", boundedLogValue(r.URL.Path, maxLogPathBytes))
		}
		attributes = append(attributes,
			"client_ip", requestClientIP(r, trustedProxies),
			"user_agent", boundedLogValue(r.UserAgent(), maxUserAgentBytes),
			"status", status,
			"response_bytes", recorder.bytes,
			"duration_ms", time.Since(started).Milliseconds(),
		)
		logger.InfoContext(r.Context(), "http request", attributes...)
	})
}

func traceMiddleware(next http.Handler) http.Handler {
	tracer := otel.Tracer("github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parent := otel.GetTextMapPropagator().Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		ctx, span := tracer.Start(parent, "HTTP "+r.Method)
		defer span.End()

		recorder := &responseRecorder{ResponseWriter: w}
		next.ServeHTTP(recorder, r.WithContext(ctx))
		status := recorder.status
		if status == 0 {
			status = http.StatusOK
		}
		route := operationName(r.Context())
		if route == "" {
			route = "unmatched"
		}
		span.SetName(r.Method + " " + route)
		span.SetAttributes(
			attribute.String("http.request.method", r.Method),
			attribute.String("http.route", route),
			attribute.Int("http.response.status_code", status),
			attribute.String("makerspace.request.id", requestIDString(r.Context())),
		)
		if status >= http.StatusInternalServerError {
			span.SetStatus(codes.Error, http.StatusText(status))
		}
	})
}

func captureOperation(next openapi.StrictHandlerFunc, operationID string) openapi.StrictHandlerFunc {
	return func(ctx context.Context, w http.ResponseWriter, r *http.Request, request interface{}) (interface{}, error) {
		if state, ok := ctx.Value(operationStateContextKey).(*operationState); ok {
			state.name = operationID
		}
		return next(ctx, w, r, request)
	}
}

func operationName(ctx context.Context) string {
	state, _ := ctx.Value(operationStateContextKey).(*operationState)
	if state == nil {
		return ""
	}
	return state.name
}

func normalizedRoute(ctx context.Context) string {
	value, _ := ctx.Value(normalizedRouteContextKey).(string)
	return value
}

func matchedRoutePattern(routes chi.Routes, method, path string) string {
	if routes == nil {
		return ""
	}
	methods := []string{method, http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions}
	seen := make(map[string]struct{}, len(methods))
	for _, candidate := range methods {
		if _, duplicate := seen[candidate]; duplicate {
			continue
		}
		seen[candidate] = struct{}{}
		routeContext := chi.NewRouteContext()
		if routes.Match(routeContext, candidate, path) {
			return routeContext.RoutePattern()
		}
	}
	return ""
}

func requestClientIP(r *http.Request, trustedProxies []netip.Prefix) string {
	peer, ok := parseIP(r.RemoteAddr)
	if !ok {
		return ""
	}
	if !isTrustedProxy(peer, trustedProxies) {
		return peer.String()
	}

	forwardedValues := r.Header.Values(forwardedForHeader)
	if len(forwardedValues) == 0 {
		return peer.String()
	}
	forwarded := make([]netip.Addr, 0, len(forwardedValues))
	for _, value := range forwardedValues {
		for _, part := range strings.Split(value, ",") {
			address, err := netip.ParseAddr(strings.TrimSpace(part))
			if err != nil {
				return peer.String()
			}
			forwarded = append(forwarded, canonicalIP(address))
		}
	}
	if len(forwarded) == 0 {
		return peer.String()
	}

	client := peer
	for index := len(forwarded) - 1; index >= 0 && isTrustedProxy(client, trustedProxies); index-- {
		client = forwarded[index]
	}
	return client.String()
}

func parseIP(address string) (netip.Addr, bool) {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		host = address
	}
	parsed, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}, false
	}
	return canonicalIP(parsed), true
}

func canonicalIP(address netip.Addr) netip.Addr {
	if address.Zone() != "" {
		address = address.WithZone("")
	}
	return address.Unmap()
}

func isTrustedProxy(address netip.Addr, trustedProxies []netip.Prefix) bool {
	for _, prefix := range trustedProxies {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

func boundedLogValue(value string, maxBytes int) string {
	value = strings.ToValidUTF8(value, "\uFFFD")
	if len(value) <= maxBytes {
		return value
	}
	const suffix = "…"
	cut := maxBytes - len(suffix)
	for cut > 0 && !utf8.RuneStart(value[cut]) {
		cut--
	}
	return value[:cut] + suffix
}

func writeAPIError(w http.ResponseWriter, r *http.Request, err error, logger *slog.Logger) {
	status := http.StatusInternalServerError
	response := openapi.Error{
		Code: "internal_error", Message: "An internal error occurred",
		RequestId: requestIDString(r.Context()),
	}
	var appError *apperror.Error
	if errors.As(err, &appError) {
		status = appError.HTTPStatus
		response.Code = appError.Code
		response.Message = appError.Message
		if len(appError.Details) > 0 {
			details := make(map[string]any, len(appError.Details))
			for key, value := range appError.Details {
				details[key] = value
			}
			response.Details = &details
		}
	} else {
		logger.ErrorContext(r.Context(), "request failed",
			"request_id", response.RequestId,
			"error_type", fmt.Sprintf("%T", err),
		)
	}
	if status == http.StatusTooManyRequests {
		w.Header().Set("Retry-After", "900")
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(response)
}

func requirePrincipal(ctx context.Context) (authorization.Principal, error) {
	authenticated, ok := ctx.Value(authenticatedContextKey).(auth.Authenticated)
	if !ok {
		return authorization.Principal{}, apperror.Unauthenticated
	}
	return authenticated.Principal, nil
}

func requestIDPointer(ctx context.Context) *uuid.UUID {
	requestID, ok := ctx.Value(requestIDContextKey).(uuid.UUID)
	if !ok {
		return nil
	}
	return &requestID
}

func requestIDString(ctx context.Context) string {
	requestID := requestIDPointer(ctx)
	if requestID == nil {
		return ""
	}
	return requestID.String()
}

func sourceAddress(ctx context.Context) string {
	value, _ := ctx.Value(sourceAddressContextKey).(string)
	return value
}

func remoteHost(remoteAddress string) string {
	host, _, err := net.SplitHostPort(remoteAddress)
	if err == nil {
		return host
	}
	return remoteAddress
}

func isPublicPath(path string) bool {
	if isSCIMPath(path) {
		return true
	}
	if isVisitorEnrollmentPublicPath(path) {
		return true
	}
	if path == apiBasePath+"/auth/oidc/callback" || path == apiBasePath+"/auth/oidc/providers" ||
		(strings.HasPrefix(path, apiBasePath+"/auth/oidc/") && strings.HasSuffix(path, "/start")) {
		return true
	}
	switch path {
	case apiBasePath + "/health/live", apiBasePath + "/health/ready", apiBasePath + "/auth/login", apiBasePath + "/auth/password-reset/complete",
		apiBasePath + "/auth/pin/login",
		apiBasePath + "/auth/password-reset/request", apiBasePath + "/auth/password-reset/complete-code",
		apiBasePath + "/auth/invitations/complete", apiBasePath + "/auth/email-verification/complete",
		apiBasePath + "/public/open-days", apiBasePath + "/public/open-days/calendar.ics":
		return true
	default:
		return false
	}
}

func isVisitorEnrollmentPublicPath(path string) bool {
	switch path {
	case apiBasePath + "/visitor-enrollment/context", apiBasePath + "/visitor-enrollment/state",
		apiBasePath + "/visitor-enrollment/lab-rules.pdf", apiBasePath + "/visitor-enrollment/submissions":
		return true
	default:
		return false
	}
}

func cookieValue(cookie *http.Cookie) string {
	if cookie == nil {
		return ""
	}
	return cookie.Value
}

func isSCIMPath(path string) bool {
	return strings.HasPrefix(path, apiBasePath+"/scim/v2/")
}

func isUnsafeMethod(method string) bool {
	return method != http.MethodGet && method != http.MethodHead && method != http.MethodOptions
}
