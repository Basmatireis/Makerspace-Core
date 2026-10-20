// Package optional holds the small pointer helpers that domain code uses for optional values.
package optional

import "strings"

// Of returns a pointer to value.
func Of[T any](value T) *T {
	return &value
}

// Value returns the pointed-to value, or the zero value for nil.
func Value[T any](value *T) T {
	if value == nil {
		var zero T
		return zero
	}
	return *value
}

// Trimmed returns value without surrounding white space, or nil when it is nil or blank.
func Trimmed(value *string) *string {
	if value == nil {
		return nil
	}
	clean := strings.TrimSpace(*value)
	if clean == "" {
		return nil
	}
	return &clean
}

// Convert converts an optional value between string-based types, for example at
// the persistence or transport boundary.
func Convert[To, From ~string](value *From) *To {
	if value == nil {
		return nil
	}
	converted := To(*value)
	return &converted
}

// ConvertSlice converts a list between string-based types.
func ConvertSlice[To, From ~string](values []From) []To {
	if values == nil {
		return nil
	}
	converted := make([]To, len(values))
	for i, value := range values {
		converted[i] = To(value)
	}
	return converted
}
