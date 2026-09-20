package integration_test

import (
	"bytes"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
)

func TestSemanticMigrationsPreserveSessionsAndInvalidateUnprovenFlows(t *testing.T) {
	pool := emptySchemaPool(t)
	paths := orderedMigrationFiles(t)
	applyMigrationFiles(t, pool, paths[:15])
	ctx := testContext(t)
	actor := seedAccount(t, pool, "semantic-upgrade", true)
	provider := insertSCIMOIDCProvider(t, pool, "https://migration.example.test")
	identity := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO auth_identities(id,account_id,kind,provider_id,issuer,subject) VALUES($1,$2,'oidc',$3,'https://migration.example.test','preserved-subject')`, identity, actor.accountID, provider); err != nil {
		t.Fatal(err)
	}
	service, err := auth.NewService(pool, integrationConfig(t))
	if err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	session, err := service.CreateOIDCSession(ctx, tx, actor.accountID, identity, authorization.AssuranceNormal, time.Now())
	if err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	deviceType, device, contextID, flowID := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	digest := security.DigestToken("disposable migration fixture")
	if _, err := pool.Exec(ctx, `INSERT INTO device_types(id,name) VALUES($1,'Migration terminal'); INSERT INTO managed_devices(id,name,device_type_id,token_digest) VALUES($2,'Migration terminal',$1,$3); INSERT INTO visitor_enrollment_contexts(id,managed_device_id,token_digest,csrf_digest,expires_at) VALUES($4,$2,$3,$3,now()+interval '15 minutes')`, deviceType, device, digest, contextID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO oidc_flows(id,provider_id,kind,account_id,state_digest,browser_token_digest,encrypted_nonce,encrypted_pkce_verifier,expires_at) VALUES($1,$2,'link',$3,$4,$4,$4,$4,now()+interval '10 minutes')`, flowID, provider, actor.accountID, digest); err != nil {
		t.Fatal(err)
	}
	applyMigrationFiles(t, pool, paths[15:])
	assertCount(t, pool, `SELECT count(*) FROM visitor_enrollment_contexts WHERE id=$1 AND used_at IS NOT NULL AND lab_rules_version_id IS NULL`, 1, contextID)
	assertCount(t, pool, `SELECT count(*) FROM oidc_flows WHERE id=$1`, 0, flowID)
	authenticated, err := service.Authenticate(ctx, session.Token)
	if err != nil {
		t.Fatalf("migration revoked login: %v", err)
	}
	if authenticated.Principal.HasFreshAssurance(authorization.AssuranceNormal, auth.SensitiveAuthenticationAge, time.Now()) {
		t.Fatal("unverified old OIDC timestamp retained sensitive capability")
	}
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE id=$1 AND subject='preserved-subject'`, 1, identity)
	assertCount(t, pool, `SELECT count(*) FROM account_roles WHERE account_id=$1 AND role_id=$2`, 1, actor.accountID, masterRoleID)
	var stored []byte
	if err := pool.QueryRow(ctx, `SELECT token_digest FROM sessions WHERE id=$1`, session.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored, security.DigestToken(session.Token)) {
		t.Fatal("migration altered session credentials")
	}
	// Exercise these two Down paths with real retained account/session data.
	for index := 16; index >= 15; index-- {
		content, err := os.ReadFile(paths[index])
		if err != nil {
			t.Fatal(err)
		}
		_, down, _ := strings.Cut(string(content), "-- +goose Down")
		if _, err := pool.Exec(ctx, down); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := service.Authenticate(ctx, session.Token); err != nil {
		t.Fatalf("downgrade revoked login: %v", err)
	}
	applyMigrationFiles(t, pool, paths[15:])
}
