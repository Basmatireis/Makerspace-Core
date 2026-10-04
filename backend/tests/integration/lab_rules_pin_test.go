package integration_test

import (
	"bytes"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accounts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestLabRulesStatusIsReadOnlyAndExplicitRequestIsIdempotent(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	accountID, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Warning", LastName: "Member", ContactEmail: "warning@example.test",
		LoginEmail: "warning-login@example.test", Password: bootstrapPassword,
	})
	if err != nil {
		t.Fatal(err)
	}
	var personID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT person_id FROM accounts WHERE id=$1`, accountID).Scan(&personID); err != nil {
		t.Fatal(err)
	}
	warningRoleID := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO roles (id,name,laborordnung_mode) VALUES ($1,'Lab warning','warning')`, warningRoleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO person_roles (person_id,role_id) VALUES ($1,$2)`, personID, warningRoleID); err != nil {
		t.Fatal(err)
	}
	versionID := insertPublishedLabRulesVersion(t, pool, accountID, "2026.1")

	authService, err := auth.NewService(pool, integrationConfig(t))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := authService.Login(ctx, "warning-login@example.test", bootstrapPassword, "lab-rules-login", nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM laborordnung_requests WHERE person_id=$1`, 0, personID)

	service := laborordnung.NewService(pool, nil)
	status, err := service.Evaluate(ctx, personID)
	if err != nil {
		t.Fatal(err)
	}
	if status.Mode != "warning" || status.State != "outdated" || !status.ActionRequired || status.CurrentVersion == nil || status.CurrentVersion.ID != versionID || status.RequestID != nil {
		t.Fatalf("unexpected warning status: %#v", status)
	}
	if _, err := service.Evaluate(ctx, personID); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM laborordnung_requests WHERE person_id=$1`, 0, personID)

	principal := authorization.Principal{AccountID: accountID, PersonID: personID, Master: true, Assurance: authorization.AssuranceNormal, AuthenticatedAt: time.Now().UTC()}
	first, created, err := service.RequestOwnConfirmation(ctx, principal, nil)
	if err != nil || !created {
		t.Fatalf("create explicit request: created=%v err=%v", created, err)
	}
	second, created, err := service.RequestOwnConfirmation(ctx, principal, nil)
	if err != nil || created || second.ID != first.ID {
		t.Fatalf("reuse explicit request: first=%s second=%s created=%v err=%v", first.ID, second.ID, created, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM laborordnung_requests WHERE person_id=$1 AND status='pending'`, 1, personID)
	status, err = service.Evaluate(ctx, personID)
	if err != nil || status.RequestID == nil || *status.RequestID != first.ID {
		t.Fatalf("status after explicit request: %#v err=%v", status, err)
	}
	if _, err := service.Confirm(ctx, principal, first.ID, "physical-folder-42", nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	status, err = service.Evaluate(ctx, personID)
	if err != nil || status.State != "current" || status.ActionRequired || status.LatestConfirmedVersion == nil || status.LatestConfirmedVersion.ID != versionID {
		t.Fatalf("status after confirmation: %#v err=%v", status, err)
	}

	blockingRoleID := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO roles (id,name,laborordnung_mode) VALUES ($1,'Admission block','blocking')`, blockingRoleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO person_roles (person_id,role_id) VALUES ($1,$2)`, personID, blockingRoleID); err != nil {
		t.Fatal(err)
	}
	status, err = service.Evaluate(ctx, personID)
	if err != nil || status.Mode != "blocking" {
		t.Fatalf("strongest effective policy = %#v err=%v", status, err)
	}
}

func TestAdministratorPINEnrollmentChallengeCreatesUsernamePINIdentity(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	cfg := integrationConfig(t)
	notifier := newNotificationRecorder()
	accountID, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "PIN", LastName: "Member", ContactEmail: "pin-member@example.test",
		LoginEmail: "pin-password@example.test", Password: bootstrapPassword,
	})
	if err != nil {
		t.Fatal(err)
	}
	var personID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT person_id FROM accounts WHERE id=$1`, accountID).Scan(&personID); err != nil {
		t.Fatal(err)
	}
	principal := authorization.Principal{AccountID: accountID, PersonID: personID, Master: true, Assurance: authorization.AssuranceNormal, AuthenticatedAt: time.Now().UTC()}
	issue, err := accounts.NewService(pool, cfg, notifier).IssuePINEnrollment(ctx, principal, accountID, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	code := notifier.pinCode("pin-member@example.test")
	if code == "" {
		t.Fatal("PIN enrollment code was not delivered")
	}
	assertChallengeStoredAsDigest(t, pool, cfg, accountID, "pin_enrollment", code)
	authService, err := auth.NewService(pool, cfg, notifier)
	if err != nil {
		t.Fatal(err)
	}
	if err := authService.CompletePINEnrollment(ctx, accountID, code, "Noel.Workshop", "654321", "pin-enrollment", nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE account_id=$1 AND kind='pin' AND identifier_display='Noel.Workshop' AND identifier_normalized='noel.workshop'`, 1, accountID)
	var pinHash string
	if err := pool.QueryRow(ctx, `SELECT pc.pin_hash FROM pin_credentials pc JOIN auth_identities i ON i.id=pc.auth_identity_id WHERE i.account_id=$1`, accountID).Scan(&pinHash); err != nil {
		t.Fatal(err)
	}
	if pinHash == "654321" || !bytes.HasPrefix([]byte(pinHash), []byte("$argon2id$")) {
		t.Fatal("PIN was not stored exclusively as an Argon2id hash")
	}
	session, err := authService.LoginWithPIN(ctx, "NOEL.WORKSHOP", "654321", "pin-login", nil)
	if err != nil {
		t.Fatal(err)
	}
	authenticated, err := authService.Authenticate(ctx, session.Token)
	if err != nil || authenticated.Principal.Assurance != authorization.AssuranceLow {
		t.Fatalf("PIN assurance=%q err=%v", authenticated.Principal.Assurance, err)
	}
	if err := authService.CompletePINEnrollment(ctx, accountID, code, "other-name", "123456", "replay", nil); !apperror.IsCode(err, "challenge_invalid") {
		t.Fatalf("challenge replay error=%v", err)
	}
	if issue.Account.Version != 2 {
		t.Fatalf("issued account version=%d, want 2", issue.Account.Version)
	}
}

func TestPhoneOnlyAccountSupportsAdministrativePINAndManualEnrollment(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	cfg := integrationConfig(t)
	masterAccountID, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "PIN", LastName: "Administrator", ContactEmail: "pin-admin@example.test",
		LoginEmail: "pin-admin-login@example.test", Password: bootstrapPassword,
	})
	if err != nil {
		t.Fatal(err)
	}
	var masterPersonID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT person_id FROM accounts WHERE id=$1`, masterAccountID).Scan(&masterPersonID); err != nil {
		t.Fatal(err)
	}
	principal := authorization.Principal{AccountID: masterAccountID, PersonID: masterPersonID, Master: true, Assurance: authorization.AssuranceNormal, AuthenticatedAt: time.Now().UTC()}

	personID, accountID := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO people (id,first_name,last_name,phone) VALUES ($1,'Phone','Only','+43 660 123456')`, personID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO accounts (id,person_id,status) VALUES ($1,$2,'disabled')`, accountID, personID); err != nil {
		t.Fatal(err)
	}
	authService, err := auth.NewService(pool, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := authService.SetAccountPIN(ctx, authorization.Principal{}, accountID, "phone.only", "123456", 1, nil); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("PIN setup without permission error=%v", err)
	}
	if err := authService.SetAccountPIN(ctx, principal, accountID, "phone.only", "123456", 2, nil); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale PIN setup error=%v", err)
	}

	issue, err := accounts.NewService(pool, cfg).IssuePINEnrollment(ctx, principal, accountID, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if issue.DeliveryStatus != "manual" || issue.SetupURL == nil {
		t.Fatalf("phone-only PIN enrollment issue=%#v", issue)
	}
	assertCount(t, pool, `SELECT count(*) FROM auth_challenges WHERE account_id=$1 AND kind='pin_enrollment' AND delivery_address IS NULL AND used_at IS NULL`, 1, accountID)

	if err := authService.SetAccountPIN(ctx, principal, accountID, "Phone.Only", "123456", issue.Account.Version, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM auth_challenges WHERE account_id=$1 AND kind='pin_enrollment'`, 0, accountID)
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE account_id=$1 AND kind='password'`, 0, accountID)
	var pinHash string
	if err := pool.QueryRow(ctx, `SELECT pc.pin_hash FROM pin_credentials pc JOIN auth_identities i ON i.id=pc.auth_identity_id WHERE i.account_id=$1 AND i.kind='pin'`, accountID).Scan(&pinHash); err != nil {
		t.Fatal(err)
	}
	if pinHash == "123456" || !security.VerifyPIN(cfg.PINPepper, pinHash, "123456") {
		t.Fatal("administrative PIN was not stored as a valid peppered hash")
	}
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE resource_id=$1 AND action='account.pin_set'`, 1, accountID)
	if _, err := authService.LoginWithPIN(ctx, "phone.only", "123456", "disabled-phone-only-login", nil); !apperror.IsCode(err, "invalid_credentials") {
		t.Fatalf("inactive account with a PIN login returned %v, want invalid_credentials", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM pin_login_throttles`); err != nil {
		t.Fatal(err)
	}

	account, err := accounts.NewService(pool, cfg).SetStatus(ctx, principal, accountID, "enabled", issue.Account.Version+1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if account.Status != "enabled" || len(account.AuthIdentities) != 1 || !account.AuthIdentities[0].Usable {
		t.Fatalf("enabled PIN-only account=%#v", account)
	}
	session, err := authService.LoginWithPIN(ctx, "PHONE.ONLY", "123456", "phone-only-login", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := authService.SetAccountPIN(ctx, principal, accountID, "phone.only", "654321", account.Version, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := authService.Authenticate(ctx, session.Token); !apperror.IsCode(err, "unauthenticated") {
		t.Fatalf("session after administrative PIN reset error=%v", err)
	}
	newPINSession, err := authService.LoginWithPIN(ctx, "phone.only", "654321", "phone-only-new-pin", nil)
	if err != nil {
		t.Fatalf("login with reset PIN: %v", err)
	}

	conflictPersonID, conflictAccountID := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO people (id,first_name,last_name,phone) VALUES ($1,'PIN','Conflict','+43 660 654321')`, conflictPersonID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO accounts (id,person_id,status) VALUES ($1,$2,'disabled')`, conflictAccountID, conflictPersonID); err != nil {
		t.Fatal(err)
	}
	if err := authService.SetAccountPIN(ctx, principal, conflictAccountID, "PHONE.ONLY", "789012", 1, nil); !apperror.IsCode(err, "login_name_unavailable") {
		t.Fatalf("duplicate PIN username error=%v", err)
	}

	accountService := accounts.NewService(pool, cfg)
	currentAccount, err := accountService.Get(ctx, principal, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if len(currentAccount.AuthIdentities) != 1 || currentAccount.AuthIdentities[0].Kind != "pin" {
		t.Fatalf("account before PIN removal=%#v", currentAccount)
	}
	pinIdentityID := currentAccount.AuthIdentities[0].ID
	if err := accountService.RemoveAuthIdentity(ctx, authorization.Principal{}, accountID, pinIdentityID, currentAccount.Version, nil); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("PIN removal without permission error=%v", err)
	}
	if err := accountService.RemoveAuthIdentity(ctx, principal, accountID, pinIdentityID, currentAccount.Version+1, nil); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale PIN removal error=%v", err)
	}
	if err := accountService.RemoveAuthIdentity(ctx, principal, accountID, pinIdentityID, currentAccount.Version, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE account_id=$1 AND kind='pin'`, 0, accountID)
	assertCount(t, pool, `SELECT count(*) FROM accounts WHERE id=$1 AND status='enabled'`, 1, accountID)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE resource_id=$1 AND action='account.pin_removed'`, 1, accountID)
	if _, err := authService.Authenticate(ctx, newPINSession.Token); !apperror.IsCode(err, "unauthenticated") {
		t.Fatalf("session after administrative PIN removal error=%v", err)
	}
}

func TestPhoneOnlyPINSetupLinkIsSingleUse(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	cfg := integrationConfig(t)
	masterAccountID, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Manual", LastName: "Administrator", ContactEmail: "manual-admin@example.test",
		LoginEmail: "manual-admin-login@example.test", Password: bootstrapPassword,
	})
	if err != nil {
		t.Fatal(err)
	}
	var masterPersonID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT person_id FROM accounts WHERE id=$1`, masterAccountID).Scan(&masterPersonID); err != nil {
		t.Fatal(err)
	}
	principal := authorization.Principal{AccountID: masterAccountID, PersonID: masterPersonID, Master: true, Assurance: authorization.AssuranceNormal, AuthenticatedAt: time.Now().UTC()}
	personID, accountID := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO people (id,first_name,last_name,phone) VALUES ($1,'Manual','PIN','+43 660 999999')`, personID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO accounts (id,person_id,status) VALUES ($1,$2,'disabled')`, accountID, personID); err != nil {
		t.Fatal(err)
	}
	issue, err := accounts.NewService(pool, cfg).IssuePINEnrollment(ctx, principal, accountID, 1, nil)
	if err != nil || issue.SetupURL == nil {
		t.Fatalf("manual issue=%#v err=%v", issue, err)
	}
	parsed, err := url.Parse(*issue.SetupURL)
	if err != nil {
		t.Fatal(err)
	}
	fragment, err := url.ParseQuery(parsed.Fragment)
	if err != nil {
		t.Fatal(err)
	}
	code := fragment.Get("code")
	if code == "" {
		t.Fatal("manual setup URL did not contain a challenge code")
	}
	assertChallengeStoredAsDigest(t, pool, cfg, accountID, "pin_enrollment", code)
	authService, err := auth.NewService(pool, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := authService.CompletePINEnrollment(ctx, accountID, code, "manual.pin", "112233", "manual-pin", nil); err != nil {
		t.Fatal(err)
	}
	if err := authService.CompletePINEnrollment(ctx, accountID, code, "manual.pin", "112233", "manual-pin-replay", nil); !apperror.IsCode(err, "challenge_invalid") {
		t.Fatalf("manual setup replay error=%v", err)
	}
}

func TestAuthenticationIdentityUsabilityProjection(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	cfg := integrationConfig(t)
	accountID, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Usability", LastName: "Projection", ContactEmail: "usability-contact@example.test",
		LoginEmail: "usability-login@example.test", Password: bootstrapPassword,
	})
	if err != nil {
		t.Fatal(err)
	}
	var personID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT person_id FROM accounts WHERE id=$1`, accountID).Scan(&personID); err != nil {
		t.Fatal(err)
	}
	principal := authorization.Principal{AccountID: accountID, PersonID: personID, Master: true}
	service := accounts.NewService(pool, cfg)
	identityUsable := func(kind string) bool {
		t.Helper()
		account, getErr := service.Get(ctx, principal, accountID)
		if getErr != nil {
			t.Fatal(getErr)
		}
		for _, identity := range account.AuthIdentities {
			if identity.Kind == kind {
				return identity.Usable
			}
		}
		t.Fatalf("%s identity missing from projection", kind)
		return false
	}
	if _, err := pool.Exec(ctx, `UPDATE auth_identities SET verified_at=NULL WHERE account_id=$1 AND kind='password'`, accountID); err != nil {
		t.Fatal(err)
	}
	if !identityUsable("password") {
		t.Fatal("unverified password identity with a usable credential was projected unusable")
	}
	if _, err := pool.Exec(ctx, `UPDATE password_credentials SET reset_required=true WHERE auth_identity_id=(SELECT id FROM auth_identities WHERE account_id=$1 AND kind='password')`, accountID); err != nil {
		t.Fatal(err)
	}
	if identityUsable("password") {
		t.Fatal("reset-required password identity was projected usable")
	}

	pinIdentityID := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO auth_identities (id,account_id,kind,identifier_display,identifier_normalized,verified_at) VALUES ($1,$2,'pin','usability.pin','usability.pin',now())`, pinIdentityID, accountID); err != nil {
		t.Fatal(err)
	}
	if identityUsable("pin") {
		t.Fatal("PIN identity without a credential was projected usable")
	}
	pinHash, err := security.HashPIN(cfg.PINPepper, "445566")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO pin_credentials (auth_identity_id,pin_hash) VALUES ($1,$2)`, pinIdentityID, pinHash); err != nil {
		t.Fatal(err)
	}
	if !identityUsable("pin") {
		t.Fatal("PIN identity with a credential was projected unusable")
	}

	providerID, oidcIdentityID := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO oidc_providers (id,slug,display_name,issuer,client_id,encrypted_client_secret,enabled) VALUES ($1,'usability','Usability SSO','https://usability.example.test','client',$2,false)`, providerID, []byte{1}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO auth_identities (id,account_id,kind,provider_id,issuer,subject,verified_at) VALUES ($1,$2,'oidc',$3,'https://usability.example.test','subject',now())`, oidcIdentityID, accountID, providerID); err != nil {
		t.Fatal(err)
	}
	if identityUsable("oidc") {
		t.Fatal("OIDC identity for a disabled provider was projected usable")
	}
	if _, err := pool.Exec(ctx, `UPDATE oidc_providers SET enabled=true WHERE id=$1`, providerID); err != nil {
		t.Fatal(err)
	}
	if !identityUsable("oidc") {
		t.Fatal("OIDC identity for an enabled provider was projected unusable")
	}
	if _, err := pool.Exec(ctx, `UPDATE auth_identities SET disabled_at=now() WHERE id=$1`, oidcIdentityID); err != nil {
		t.Fatal(err)
	}
	if identityUsable("oidc") {
		t.Fatal("disabled OIDC identity was projected usable")
	}
}

func TestStandaloneEmailVerificationIsSingleUse(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	cfg := integrationConfig(t)
	notifier := newNotificationRecorder()
	loginEmail := "verify-login@example.test"
	accountID, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Verify", LastName: "Member", ContactEmail: "verify-contact@example.test",
		LoginEmail: loginEmail, Password: bootstrapPassword,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE auth_identities SET verified_at=NULL WHERE account_id=$1 AND kind='password'`, accountID); err != nil {
		t.Fatal(err)
	}
	service, err := auth.NewService(pool, cfg, notifier)
	if err != nil {
		t.Fatal(err)
	}
	principal := authorization.Principal{AccountID: accountID}
	if err := service.RequestOwnEmailVerification(ctx, principal, nil); err != nil {
		t.Fatal(err)
	}
	code := notifier.verificationCode(loginEmail)
	if code == "" {
		t.Fatal("verification code was not delivered")
	}
	var storedDigest []byte
	if err := pool.QueryRow(ctx, `SELECT code_digest FROM auth_challenges WHERE account_id=$1 AND kind='email_verification'`, accountID).Scan(&storedDigest); err != nil {
		t.Fatal(err)
	}
	if string(storedDigest) == code {
		t.Fatal("verification code was stored in plaintext")
	}
	if err := service.CompleteEmailVerification(ctx, strings.ToUpper(loginEmail), strings.ToLower(code), "verification-source", nil); err != nil {
		t.Fatal(err)
	}
	var verified bool
	if err := pool.QueryRow(ctx, `SELECT verified_at IS NOT NULL FROM auth_identities WHERE account_id=$1 AND kind='password'`, accountID).Scan(&verified); err != nil {
		t.Fatal(err)
	}
	if !verified {
		t.Fatal("password identity was not verified")
	}
	if err := service.CompleteEmailVerification(ctx, loginEmail, code, "verification-replay", nil); !apperror.IsCode(err, "challenge_invalid") {
		t.Fatalf("replayed verification returned %v", err)
	}
}

func insertPublishedLabRulesVersion(t *testing.T, pool *pgxpool.Pool, accountID uuid.UUID, revision string) uuid.UUID {
	t.Helper()
	ctx := testContext(t)
	fileID, versionID := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	digest := bytes.Repeat([]byte{5}, 32)
	if _, err := pool.Exec(ctx, `
		INSERT INTO files (id,storage_key,original_filename,content_type,size_bytes,sha256,created_by_account_id)
		VALUES ($1,$2,'lab-rules.pdf','application/pdf',4,$3,$4)`, fileID, "lab-rules/"+fileID.String(), digest, accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO laborordnung_versions (id,status,human_revision,pdf_file_id,pdf_sha256,effective_at,published_at,created_by_account_id)
		VALUES ($1,'published',$2,$3,$4,now()-interval '1 minute',now(),$5)`, versionID, revision, fileID, digest, accountID); err != nil {
		t.Fatal(err)
	}
	return versionID
}
