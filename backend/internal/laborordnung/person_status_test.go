package laborordnung

import (
	"context"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	authorizationdb "github.com/Basmatireis/Makerspace-Core/backend/internal/authorization/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

type personStatusPermissionsStub struct {
	rows []authorizationdb.GetPrincipalRolePermissionsRow
}

func (s personStatusPermissionsStub) GetPrincipalRolePermissions(context.Context, uuid.UUID) ([]authorizationdb.GetPrincipalRolePermissionsRow, error) {
	return s.rows, nil
}

func laborordnungPrincipal(t *testing.T, permissions ...authorization.Permission) authorization.Principal {
	t.Helper()
	rows := make([]authorizationdb.GetPrincipalRolePermissionsRow, 0, len(permissions))
	for _, permission := range permissions {
		permissionID := string(permission)
		grantID := uuid.Must(uuid.NewV7())
		scope := string(authorization.GrantEverywhere)
		minimum := string(authorization.AssuranceLow)
		rows = append(rows, authorizationdb.GetPrincipalRolePermissionsRow{
			RoleID: uuid.Must(uuid.NewV7()), GrantID: &grantID, PermissionID: &permissionID,
			Scope: &scope, MinimumAssurance: &minimum,
		})
	}
	principal, err := authorization.LoadPermissions(t.Context(), personStatusPermissionsStub{rows: rows}, authorization.Principal{AccountID: uuid.Must(uuid.NewV7())})
	if err != nil {
		t.Fatal(err)
	}
	return principal
}

func TestEvaluateForPersonRequiresBothPersonAndRequestRead(t *testing.T) {
	personID := uuid.Must(uuid.NewV7())
	service := NewService(nil, nil)

	for name, principal := range map[string]authorization.Principal{
		"person read without feature": laborordnungPrincipal(t, authorization.PeopleReadAll),
		"feature read without person": laborordnungPrincipal(t, authorization.LaborordnungRequestsRead),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := service.EvaluateForPerson(t.Context(), principal, personID)
			if !apperror.IsCode(err, "permission_denied") {
				t.Fatalf("expected permission_denied, got %v", err)
			}
		})
	}
}
