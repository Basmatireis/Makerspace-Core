package authorization

import (
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

func TestListPermissionsRequiresRoleReadAccess(t *testing.T) {
	service := NewService()
	if _, err := service.ListPermissions(Principal{}); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("error = %v, want permission_denied", err)
	}

	principal := Principal{permissions: map[Permission]struct{}{RolesRead: {}}}
	definitions, err := service.ListPermissions(principal)
	if err != nil {
		t.Fatal(err)
	}
	if len(definitions) != len(Registry()) {
		t.Fatalf("definition count = %d, want %d", len(definitions), len(Registry()))
	}
}
