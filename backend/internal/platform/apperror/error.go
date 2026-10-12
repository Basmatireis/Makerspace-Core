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

// Blocked reports every independent reason an operation cannot proceed in
// details.reasons. A single reason keeps its own status and code so callers
// that match on it keep working; several reasons use the combined code.
func Blocked(code, message string, reasons ...*Error) *Error {
	listed := make([]map[string]any, 0, len(reasons))
	for _, reason := range reasons {
		listed = append(listed, map[string]any{"code": reason.Code, "message": reason.Message})
	}
	result := New(409, code, message)
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
	Unauthenticated    = New(401, "unauthenticated", "Authentication is required")
	InvalidCredentials = New(401, "invalid_credentials", "Invalid email or password")
	PermissionDenied   = New(403, "permission_denied", "Permission denied")
	NotFound           = New(404, "not_found", "Resource not found")
	Conflict           = New(409, "conflict", "The request conflicts with existing data")
	StaleWrite         = New(409, "stale_write", "The resource changed; reload it and try again")
	Validation         = New(422, "validation_failed", "Request validation failed")
)
