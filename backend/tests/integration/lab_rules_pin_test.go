package integration_test

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accounts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
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
	if _, err := pool.Exec(ctx, `INSERT INTO account_roles (account_id,role_id) VALUES ($1,$2)`, accountID, warningRoleID); err != nil {
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
	if _, err := pool.Exec(ctx, `INSERT INTO account_roles (account_id,role_id) VALUES ($1,$2)`, accountID, blockingRoleID); err != nil {
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
