package httpapi

import (
	"net/http"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/oapi-codegen/nullable"
)

func nullableStringPointer[T ~string](value nullable.Nullable[T]) *string {
	if !value.IsSpecified() || value.IsNull() {
		return nil
	}
	result := string(value.GetOrEmpty())
	return &result
}

func nullableString(value *string) nullable.Nullable[string] {
	if value == nil {
		return nullable.NewNullNullable[string]()
	}
	return nullable.NewNullableWithValue(*value)
}

func stringPointer[T ~string](value *T) *string {
	if value == nil {
		return nil
	}
	converted := string(*value)
	return &converted
}

func optionalString[T ~string](value nullable.Nullable[T]) people.OptionalString {
	return people.OptionalString{Set: value.IsSpecified(), Value: nullableStringPointer(value)}
}

func nullablePointer[T any, S any](value *T, convert func(T) S) nullable.Nullable[S] {
	if value == nil {
		return nullable.NewNullNullable[S]()
	}
	return nullable.NewNullableWithValue(convert(*value))
}

func invalidRequest(reason string) *apperror.Error {
	err := apperror.New(http.StatusBadRequest, "invalid_request", "Request is invalid")
	err.Details["reason"] = reason
	return err
}
