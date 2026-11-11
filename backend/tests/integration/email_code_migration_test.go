package integration_test

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
)

// TestEmailCodeMigrationConvertsVisitors checks 00132: visitors (Visitor membership, found by system_key) lose their
// password and pending invitation and sign in with an emailed code, a visitor's PIN stays, and accounts of other
// members or of masters are untouched. The Down section removes the method again.
func TestEmailCodeMigrationConvertsVisitors(t *testing.T) {
	pool := emptySchemaPool(t)
	ctx := testContext(t)
	const name = "00132_email_code_login.sql"
	var before []string
	var migration string
	for _, path := range allMigrationFiles(t) {
		switch {
		case filepath.Base(path) < "00132_":
			before = append(before, path)
		case filepath.Base(path) == name:
			migration = path
		}
	}
	if migration == "" {
		t.Fatal(name + " is missing")
	}
	applyMigrationFiles(t, pool, before)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}

	// seedAccount gives every new person the Visitor membership (trigger on people) and a password.
	passwordVisitor := seedAccount(t, pool, "migrate-password-visitor", false)
	exec(`INSERT INTO auth_challenges(id,kind,account_id,auth_identity_id,code_digest,delivery_address,expires_at)
		VALUES($1,'invitation',$2,$3,$4,'migrate-password-visitor@example.test',now()+interval '1 hour')`,
		ids.New(), passwordVisitor.accountID, passwordVisitor.identity, bytes.Repeat([]byte{1}, 32))
	pinVisitor := seedAccount(t, pool, "migrate-pin-visitor", false)
	exec(`DELETE FROM password_credentials WHERE auth_identity_id=$1`, pinVisitor.identity)
	pinIdentity := ids.New()
	exec(`INSERT INTO auth_identities(id,account_id,kind,identifier_display,identifier_normalized)
		VALUES($1,$2,'pin','pin.visitor','pin.visitor')`, pinIdentity, pinVisitor.accountID)
	exec(`INSERT INTO pin_credentials(auth_identity_id,pin_hash) VALUES($1,'integration-test-pin-hash')`, pinIdentity)
	member := seedAccount(t, pool, "migrate-member", false)
	exec(`UPDATE person_roles SET role_id=(SELECT id FROM roles WHERE system_key='supervisor')
		WHERE person_id=$1 AND role_id=(SELECT id FROM roles WHERE system_key='visitor')`, member.personID)
	master := seedAccount(t, pool, "migrate-master", true)
	exec(`INSERT INTO role_permission_grants(id,role_id,permission_id,scope,minimum_assurance)
		VALUES(uuidv7(),(SELECT id FROM roles WHERE system_key='supervisor'),'accounts.pin.enroll.self','global','normal')`)

	contents, err := os.ReadFile(migration)
	if err != nil {
		t.Fatal(err)
	}
	up, down, found := strings.Cut(string(contents), "-- +goose Down")
	if !found {
		t.Fatal("migration has no Down section")
	}
	exec(up)

	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE id=$1 AND email_code_enabled`, 1, passwordVisitor.identity)
	assertCount(t, pool, `SELECT count(*) FROM password_credentials WHERE auth_identity_id=$1`, 0, passwordVisitor.identity)
	assertCount(t, pool, `SELECT count(*) FROM auth_challenges WHERE account_id=$1`, 0, passwordVisitor.accountID)
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE id=$1 AND email_code_enabled`, 1, pinVisitor.identity)
	assertCount(t, pool, `SELECT count(*) FROM pin_credentials WHERE auth_identity_id=$1`, 1, pinIdentity)
	for _, untouched := range []seededAccount{member, master} {
		assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE id=$1 AND NOT email_code_enabled`, 1, untouched.identity)
		assertCount(t, pool, `SELECT count(*) FROM password_credentials WHERE auth_identity_id=$1`, 1, untouched.identity)
	}
	// Whoever may set up their own PIN may also switch the emailed code.
	assertCount(t, pool, `SELECT count(*) FROM role_permission_grants g JOIN roles r ON r.id=g.role_id
		WHERE r.system_key='supervisor' AND g.permission_id='accounts.email_code.manage.self' AND g.minimum_assurance='normal'`, 1)
	assertCount(t, pool, `SELECT count(*) FROM information_schema.columns
		WHERE table_schema=current_schema() AND table_name='visitor_enrollment_configuration' AND column_name='allowed_methods'`, 0)

	exec(down)
	assertCount(t, pool, `SELECT count(*) FROM information_schema.columns
		WHERE table_schema=current_schema() AND table_name='auth_identities' AND column_name='email_code_enabled'`, 0)
	assertCount(t, pool, `SELECT count(*) FROM visitor_enrollment_configuration WHERE allowed_methods=ARRAY['password','pin']`, 1)
	assertCount(t, pool, `SELECT count(*) FROM role_permission_grants WHERE permission_id LIKE 'accounts.email_code.%'`, 0)
	assertCount(t, pool, `SELECT count(*) FROM pin_credentials WHERE auth_identity_id=$1`, 1, pinIdentity)
}
