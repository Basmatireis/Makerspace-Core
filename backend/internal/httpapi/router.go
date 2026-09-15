package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
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
	maxRequestBodyBytes = 64 << 10
	csrfHeaderName      = "X-CSRF-Token"
	requestIDHeaderName = "X-Request-ID"
)

type contextKey uint8

const (
	requestIDContextKey contextKey = iota
	authenticatedContextKey
	sourceAddressContextKey
	operationStateContextKey
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
	handler = accessLogMiddleware(handler, logger)
	handler = requestMetadataMiddleware(handler)
	return handler, nil
}

func (s *Server) authenticationMiddleware(next http.Handler, logger *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
		device, err := s.managedDevices.Authenticate(r.Context(), r.Header.Get("X-Managed-Device-Token"))
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
		if isUnsafeMethod(r.Method) && r.Header.Get("Origin") != expectedOrigin {
			writeAPIError(w, r, apperror.New(http.StatusForbidden, "origin_invalid", "Request origin is not allowed"), logger)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func requestMetadataMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := uuid.Must(uuid.NewV7())
		w.Header().Set(requestIDHeaderName, requestID.String())
		ctx := context.WithValue(r.Context(), requestIDContextKey, requestID)
		ctx = context.WithValue(ctx, sourceAddressContextKey, remoteHost(r.RemoteAddr))
		ctx = context.WithValue(ctx, operationStateContextKey, &operationState{})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func maxBodyMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
		}
		next.ServeHTTP(w, r)
	})
}

func noStoreMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, apiBasePath+"/auth/") || strings.HasSuffix(r.URL.Path, "/password-reset") ||
			(r.Method == http.MethodPost && r.URL.Path == apiBasePath+"/managed-devices") || strings.HasSuffix(r.URL.Path, "/token") {
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

func accessLogMiddleware(next http.Handler, logger *slog.Logger) http.Handler {
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
			route = "unmatched"
		}
		logger.InfoContext(r.Context(), "http request",
			"request_id", requestIDString(r.Context()),
			"method", r.Method,
			"route", route,
			"status", status,
			"response_bytes", recorder.bytes,
			"duration_ms", time.Since(started).Milliseconds(),
		)
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
	switch path {
	case apiBasePath + "/health/live", apiBasePath + "/health/ready", apiBasePath + "/auth/login", apiBasePath + "/auth/password-reset/complete",
		apiBasePath + "/public/open-days", apiBasePath + "/public/open-days/calendar.ics":
		return true
	default:
		return false
	}
}

func isUnsafeMethod(method string) bool {
	return method != http.MethodGet && method != http.MethodHead && method != http.MethodOptions
}
