package roles

import (
	"context"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

func TestMutationsRejectNonPositiveExpectedVersionBeforePersistence(t *testing.T) {
	service := NewService(nil)
	principal := authorization.Principal{Master: true, AccountID: ids.New()}
	roleID := ids.New()
	name := "renamed"

	tests := []struct {
		name string
		run  func() error
	}{
		{name: "update", run: func() error {
			_, err := service.Update(context.Background(), principal, roleID, 0, &name, false, nil, nil)
			return err
		}},
		{name: "replace permissions", run: func() error {
			_, err := service.ReplacePermissions(context.Background(), principal, roleID, 0, nil, nil)
			return err
		}},
		{name: "delete", run: func() error {
			return service.Delete(context.Background(), principal, roleID, 0, nil)
		}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := test.run(); !apperror.IsCode(err, "validation_failed") {
				t.Fatalf("error = %v, want validation_failed", err)
			}
		})
	}
}

func TestCleanOptionalDescription(t *testing.T) {
	spaces := strings.Repeat(" ", 501)
	if got := optional.Trimmed(&spaces); got != nil {
		t.Fatalf("whitespace-only description normalized to %q, want nil", *got)
	}
	padded := "  description  "
	if got := optional.Trimmed(&padded); got == nil || *got != "description" {
		t.Fatalf("padded description normalized to %v, want description", got)
	}
}
