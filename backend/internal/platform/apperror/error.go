package apperror

import (
	"errors"
	"net/http"
	"time"
)

type Error struct {
	HTTPStatus int
	Code       string
	Message    string
	Details    map[string]any
	// RetryAfter, when positive, tells the client when a rate-limited request may be repeated.
	RetryAfter time.Duration
}

func (e *Error) Error() string { return e.Message }

func New(status int, code, message string) *Error {
	return &Error{HTTPStatus: status, Code: code, Message: message, Details: map[string]any{}}
}

// RateLimited reports a throttled request that may be repeated after retryAfter.
func RateLimited(code, message string, retryAfter time.Duration) *Error {
	err := New(http.StatusTooManyRequests, code, message)
	err.RetryAfter = retryAfter
	return err
}

// Blocked reports every independent reason an operation cannot proceed in
// details.reasons. A single reason keeps its own status and code so callers
// that match on it keep working; several reasons use the combined code.
func Blocked(code, message string, reasons ...*Error) *Error {
	listed := make([]map[string]any, 0, len(reasons))
	for _, reason := range reasons {
		listed = append(listed, map[string]any{"code": reason.Code, "message": reason.Message})
	}
	result := New(http.StatusConflict, code, message)
	if len(reasons) == 1 {
		result = New(reasons[0].HTTPStatus, reasons[0].Code, reasons[0].Message)
	}
	result.Details["reasons"] = listed
	return result
}

func IsCode(err error, code string) bool {
	var appErr *Error
	return errors.As(err, &appErr) && appErr.Code == code
}

var (
	Unauthenticated    = New(http.StatusUnauthorized, "unauthenticated", "Authentication is required")
	InvalidCredentials = New(http.StatusUnauthorized, "invalid_credentials", "Invalid email or password")
	PermissionDenied   = New(http.StatusForbidden, "permission_denied", "Permission denied")
	NotFound           = New(http.StatusNotFound, "not_found", "Resource not found")
	Conflict           = New(http.StatusConflict, "conflict", "The request conflicts with existing data")
	StaleWrite         = New(http.StatusConflict, "stale_write", "The resource changed; reload it and try again")
	Validation         = New(http.StatusUnprocessableEntity, "validation_failed", "Request validation failed")
)
