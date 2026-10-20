package accounts

import (
	"context"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
)

func TestMutationsRejectNonPositiveExpectedVersionBeforePersistence(t *testing.T) {
	service := NewService(nil, config.Config{}, nil)
	principal := authorization.Principal{Master: true, AccountID: ids.New()}
	accountID := ids.New()

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
			_, err := service.UpdateLoginEmail(
				context.Background(),
				principal,
				accountID,
				"person@example.test",
				0,
				nil,
			)
			return err
		}},
		{name: "password", run: func() error {
			_, err := service.SetPassword(context.Background(), principal, accountID, "long enough passphrase", 0, nil)
			return err
		}},
		{name: "remove authentication identity", run: func() error {
			return service.RemoveAuthIdentity(
				context.Background(),
				principal,
				accountID,
				ids.New(),
				0,
				nil,
			)
		}},
		{name: "password reset", run: func() error {
			_, err := service.IssuePasswordReset(context.Background(), principal, accountID, 0, nil)
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

func TestAuthIdentityRemovalPoliciesUseMethodSpecificPermissions(t *testing.T) {
	tests := []struct {
		kind       IdentityKind
		permission authorization.Permission
		action     string
	}{
		{kind: IdentityPassword, permission: authorization.AccountsPasswordRemoveAll, action: "account.password_removed"},
		{kind: IdentityPIN, permission: authorization.AccountsPINRemoveAll, action: "account.pin_removed"},
		{kind: IdentityOIDC, permission: authorization.OIDCUnlinkAll, action: "auth.oidc_unlinked"},
	}
	for _, test := range tests {
		t.Run(string(test.kind), func(t *testing.T) {
			policy, ok := authIdentityRemovalPolicyFor(test.kind)
			if !ok || policy.permission != test.permission || policy.auditAction != test.action {
				t.Fatalf("policy = %#v, ok=%v", policy, ok)
			}
		})
	}
	if _, ok := authIdentityRemovalPolicyFor("unsupported"); ok {
		t.Fatal("unsupported authentication identity kind has a removal policy")
	}
}
