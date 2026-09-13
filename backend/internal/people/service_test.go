package people

import (
	"math"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	peopledb "github.com/Basmatireis/Makerspace-Core/backend/internal/people/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

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
	_, err := service.List(t.Context(), authorization.Principal{Master: true}, math.MaxInt32, 100, "")
	if !apperror.IsCode(err, "invalid_request") {
		t.Fatalf("expected invalid_request, got %v", err)
	}
}
