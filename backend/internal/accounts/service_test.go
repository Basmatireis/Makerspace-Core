package accounts

import (
	"context"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/google/uuid"
)

func TestMutationsRejectNonPositiveExpectedVersionBeforePersistence(t *testing.T) {
	service := NewService(nil, config.Config{})
	principal := authorization.Principal{Master: true, AccountID: uuid.Must(uuid.NewV7())}
	accountID := uuid.Must(uuid.NewV7())
	roleID := uuid.Must(uuid.NewV7())

	tests := []struct {
		name string
		run  func() error
	}{
		{name: "enable", run: func() error {
			_, err := service.SetStatus(context.Background(), principal, accountID, "enabled", 0, nil)
			return err
		}},
		{name: "delete", run: func() error {
			return service.Delete(context.Background(), principal, accountID, 0, nil)
		}},
		{name: "login email", run: func() error {
			_, err := service.UpdateLoginEmail(context.Background(), principal, accountID, "person@example.test", 0, nil)
			return err
		}},
		{name: "password", run: func() error {
			_, err := service.SetPassword(context.Background(), principal, accountID, "long enough passphrase", 0, nil)
			return err
		}},
		{name: "password reset", run: func() error {
			_, err := service.IssuePasswordReset(context.Background(), principal, accountID, 0, nil)
			return err
		}},
		{name: "role assignment", run: func() error {
			_, err := service.ChangeRole(context.Background(), principal, accountID, roleID, 0, true, nil)
			return err
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
