package authorization

import "github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"

// Service owns authorization-facing application operations that do not need
// persistence of their own, such as exposing the registered permission catalog.
type Service struct{}

func NewService() *Service { return &Service{} }

func (*Service) ListPermissions(principal Principal) ([]Definition, error) {
	if !principal.Has(RolesRead) {
		return nil, apperror.PermissionDenied
	}
	return Definitions(), nil
}
