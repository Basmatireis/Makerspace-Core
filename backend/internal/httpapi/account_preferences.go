package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accountpreferences"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
)

func accountPreferenceDTO(item accountpreferences.Preference) openapi.AccountPreference {
	return openapi.AccountPreference{
		Key: openapi.AccountPreferenceKey(item.Key), Value: item.Value, UpdatedAt: item.UpdatedAt,
	}
}

func (s *Server) ListMyAccountPreferences(
	ctx context.Context,
	_ openapi.ListMyAccountPreferencesRequestObject,
) (openapi.ListMyAccountPreferencesResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.accountPreferences.List(ctx, principal)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.AccountPreference, 0, len(result))
	for _, item := range result {
		items = append(items, accountPreferenceDTO(item))
	}
	return openapi.ListMyAccountPreferences200JSONResponse(openapi.AccountPreferenceList{Items: items}), nil
}

func (s *Server) UpdateMyAccountPreference(
	ctx context.Context,
	r openapi.UpdateMyAccountPreferenceRequestObject,
) (openapi.UpdateMyAccountPreferenceResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.accountPreferences.Set(ctx, principal, accountpreferences.Key(r.Key), r.Body.Value)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateMyAccountPreference200JSONResponse(accountPreferenceDTO(result)), nil
}
