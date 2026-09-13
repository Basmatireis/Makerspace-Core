package apperror

import "errors"

type Error struct {
	HTTPStatus int
	Code       string
	Message    string
	Details    map[string]any
}

func (e *Error) Error() string { return e.Message }

func New(status int, code, message string) *Error {
	return &Error{HTTPStatus: status, Code: code, Message: message, Details: map[string]any{}}
}

func IsCode(err error, code string) bool {
	var appErr *Error
	return errors.As(err, &appErr) && appErr.Code == code
}

var (
	Unauthenticated    = New(401, "unauthenticated", "Authentication is required")
	InvalidCredentials = New(401, "invalid_credentials", "Invalid email or password")
	PermissionDenied   = New(403, "permission_denied", "Permission denied")
	NotFound           = New(404, "not_found", "Resource not found")
	Conflict           = New(409, "conflict", "The request conflicts with existing data")
	StaleWrite         = New(409, "stale_write", "The resource changed; reload it and try again")
	Validation         = New(422, "validation_failed", "Request validation failed")
)
