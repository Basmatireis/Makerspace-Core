package people

import (
	"context"
	"math"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	authorizationdb "github.com/Basmatireis/Makerspace-Core/backend/internal/authorization/db"
	peopledb "github.com/Basmatireis/Makerspace-Core/backend/internal/people/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

type permissionsStub struct {
	rows []authorizationdb.GetPrincipalRolePermissionsRow
}

func (s permissionsStub) GetPrincipalRolePermissions(context.Context, uuid.UUID) ([]authorizationdb.GetPrincipalRolePermissionsRow, error) {
	return s.rows, nil
}

func principalWithPermissions(t *testing.T, permissions ...authorization.Permission) authorization.Principal {
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
	principal, err := authorization.LoadPermissions(t.Context(), permissionsStub{rows: rows}, authorization.Principal{AccountID: uuid.Must(uuid.NewV7())})
	if err != nil {
		t.Fatal(err)
	}
	return principal
}

func TestFromRowRedactsDetailsWithoutPersonReadPermission(t *testing.T) {
	email := "contact@example.test"
	phone := "+43 1 234"
	matriculation := "s12345"
	photo := "opaque-photo-reference"

	person := fromRow(peopledb.Person{
		FirstName:           "Ada",
		LastName:            "Lovelace",
		Email:               &email,
		Phone:               &phone,
		MatriculationNumber: &matriculation,
		PhotoReference:      &photo,
	}, false, true)

	if person.FirstName != "Ada" || person.LastName != "Lovelace" {
		t.Fatal("minimal shell identity was redacted")
	}
	if person.Email != nil || person.Phone != nil || person.MatriculationNumber != nil || person.PhotoReference != nil {
		t.Fatal("contact or sensitive person details were exposed without self/all read permission")
	}
}

func TestFromRowRequiresDedicatedMatriculationReadPermission(t *testing.T) {
	email := "contact@example.test"
	matriculation := "s12345"
	row := peopledb.Person{Email: &email, MatriculationNumber: &matriculation}

	withoutSensitivePermission := fromRow(row, true, false)
	if withoutSensitivePermission.Email == nil || withoutSensitivePermission.MatriculationNumber != nil {
		t.Fatal("matriculation was not independently redacted")
	}
	withSensitivePermission := fromRow(row, true, true)
	if withSensitivePermission.MatriculationNumber == nil || *withSensitivePermission.MatriculationNumber != matriculation {
		t.Fatal("authorized matriculation was not returned")
	}
}

func TestCleanOptionalNormalizesWhitespaceToNull(t *testing.T) {
	whitespace := "   "
	if cleanOptional(&whitespace) != nil {
		t.Fatal("empty optional string was not normalized to nil")
	}
	value := "  retained value  "
	cleaned := cleanOptional(&value)
	if cleaned == nil || *cleaned != "retained value" {
		t.Fatalf("optional string was not trimmed: %v", cleaned)
	}
}

func TestListRejectsPaginationOffsetOverflowBeforeQuery(t *testing.T) {
	service := NewService(nil)
	_, err := service.List(t.Context(), authorization.Principal{Master: true}, math.MaxInt32, 100, "", nil)
	if !apperror.IsCode(err, "invalid_request") {
		t.Fatalf("expected invalid_request, got %v", err)
	}
}

func TestListRequiresAccountsReadForRoleFiltering(t *testing.T) {
	service := NewService(nil)
	principal := principalWithPermissions(t, authorization.PeopleReadAll)
	_, err := service.List(t.Context(), principal, 1, 25, "", []uuid.UUID{uuid.Must(uuid.NewV7())})
	if !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("expected permission_denied, got %v", err)
	}
}
