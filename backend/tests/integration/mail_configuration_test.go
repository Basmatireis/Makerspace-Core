package integration_test

import (
	"bytes"
	"net/url"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accounts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	mailservice "github.com/Basmatireis/Makerspace-Core/backend/internal/mail"
)

func TestDatabaseMailConfigurationAndManualPasswordResetLink(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	cfg := integrationConfig(t)
	accountID, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{FirstName: "Mail", LastName: "Administrator", ContactEmail: "mail-admin@example.test", LoginEmail: "mail-login@example.test", Password: bootstrapPassword})
	if err != nil {
		t.Fatal(err)
	}
	var personID string
	if err := pool.QueryRow(ctx, `SELECT person_id::text FROM accounts WHERE id=$1`, accountID).Scan(&personID); err != nil {
		t.Fatal(err)
	}
	principal := authorization.Principal{AccountID: accountID, Master: true}

	keys := [][]byte{bytes.Repeat([]byte{7}, 32)}
	mail, err := mailservice.NewService(pool, keys)
	if err != nil {
		t.Fatal(err)
	}
	initial, err := mail.GetConfiguration(ctx, principal)
	if err != nil || initial.Enabled || initial.PasswordConfigured {
		t.Fatalf("initial mail configuration=%#v err=%v", initial, err)
	}
	password := "smtp-secret-value"
	configured, err := mail.UpdateConfiguration(ctx, principal, mailservice.ConfigurationInput{Enabled: true, Host: "smtp.example.test", Port: 587, TLSMode: "starttls", Username: "mailer", Password: password, FromAddress: "makerspace@example.test", FromName: "Makerspace", BaseURL: "https://makerspace.example.test", ExpectedVersion: initial.Version}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !configured.Enabled || !configured.PasswordConfigured || configured.Version != initial.Version+1 {
		t.Fatalf("updated mail configuration=%#v", configured)
	}
	var encrypted []byte
	if err := pool.QueryRow(ctx, `SELECT encrypted_smtp_password FROM mail_configuration WHERE singleton=true`).Scan(&encrypted); err != nil {
		t.Fatal(err)
	}
	if len(encrypted) == 0 || bytes.Contains(encrypted, []byte(password)) {
		t.Fatal("SMTP password was not stored exclusively as encrypted ciphertext")
	}

	configured, err = mail.UpdateConfiguration(ctx, principal, mailservice.ConfigurationInput{Enabled: false, Host: configured.Host, Port: configured.Port, TLSMode: configured.TLSMode, Username: configured.Username, FromAddress: configured.FromAddress, FromName: configured.FromName, BaseURL: configured.BaseURL, ExpectedVersion: configured.Version}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !configured.PasswordConfigured {
		t.Fatal("blank update unexpectedly removed encrypted SMTP password")
	}

	var accountVersion int64
	if err := pool.QueryRow(ctx, `SELECT version FROM accounts WHERE id=$1`, accountID).Scan(&accountVersion); err != nil {
		t.Fatal(err)
	}
	issue, err := accounts.NewService(pool, cfg).IssuePasswordReset(ctx, principal, accountID, accountVersion, nil)
	if err != nil {
		t.Fatal(err)
	}
	if issue.DeliveryStatus != "manual" || issue.SetupURL == nil {
		t.Fatalf("manual issue=%#v", issue)
	}
	parsed, err := url.Parse(*issue.SetupURL)
	if err != nil {
		t.Fatal(err)
	}
	fragment, err := url.ParseQuery(parsed.Fragment)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Path != "/reset-password" || fragment.Get("email") != "mail-login@example.test" || fragment.Get("code") == "" {
		t.Fatalf("manual URL=%q", *issue.SetupURL)
	}
	authService, err := auth.NewService(pool, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := authService.CompletePasswordResetCode(ctx, fragment.Get("email"), fragment.Get("code"), "replacement password for mail test", "manual-link", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := authService.Login(ctx, "mail-login@example.test", "replacement password for mail test", "manual-login", nil); err != nil {
		t.Fatal(err)
	}
}
