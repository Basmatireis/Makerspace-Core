package integration_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
)

// Migration 00104 turns completed paper requests into confirmations with method 'paper', drops pending and
// superseded requests and held check-ins, renames the read permission, removes laborordnung.confirm and marks the
// versions already in effect as announced so deploying it e-mails nobody.
func TestLabRulesSelfConfirmationMigrationKeepsPaperHistory(t *testing.T) {
	pool := emptySchemaPool(t)
	ctx := testContext(t)
	var before []string
	var migration string
	for _, path := range allMigrationFiles(t) {
		switch {
		case filepath.Base(path) < "00104_":
			before = append(before, path)
		case filepath.Base(path) == "00104_lab_rules_self_confirmation.sql":
			migration = path
		}
	}
	if migration == "" {
		t.Fatal("00104_lab_rules_self_confirmation.sql is missing")
	}
	applyMigrationFiles(t, pool, before)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}

	supervisor := seedAccount(t, pool, "migration-supervisor", false)
	signed := seedAccount(t, pool, "migration-signed", false)
	waiting := seedAccount(t, pool, "migration-waiting", false)
	effective := insertPublishedLabRulesVersionAt(t, pool, supervisor.accountID, "2026.1", time.Now().Add(-time.Hour))
	upcoming := insertPublishedLabRulesVersionAt(t, pool, supervisor.accountID, "2026.2", time.Now().Add(24*time.Hour))
	paper := ids.New()
	exec(`INSERT INTO laborordnung_requests
		(id,person_id,required_version_id,status,completed_at,confirmed_by_account_id,physical_document_reference,signed_date,archive_note)
		VALUES ($1,$2,$3,'completed',now()-interval '1 day',$4,'folder-7','2026-02-01','shelf B')`,
		paper, signed.personID, effective, supervisor.accountID)
	exec(`INSERT INTO laborordnung_requests (id,person_id,required_version_id) VALUES ($1,$2,$3)`,
		ids.New(), waiting.personID, effective)
	exec(`INSERT INTO laborordnung_requests (id,person_id,required_version_id,status,superseded_at)
		VALUES ($1,$2,$3,'superseded',now())`, ids.New(), signed.personID, effective)
	exec(`INSERT INTO attendance_holds (id,person_id,requested_at,expires_at,check_in_method,check_in_assurance)
		VALUES ($1,$2,now(),now()+interval '1 hour','pin','low')`, ids.New(), waiting.personID)
	role := ids.New()
	exec(`INSERT INTO roles(id,name) VALUES($1,'Lab Rules desk')`, role)
	exec(`INSERT INTO role_permission_grants(id,role_id,permission_id) VALUES
		(uuidv7(),$1,'laborordnung.requests.read'),(uuidv7(),$1,'laborordnung.confirm'),(uuidv7(),$1,'laborordnung.read')`, role)
	notification := ids.New()
	exec(`INSERT INTO inbox_notifications(id,kind,title,body,created_at,expires_at)
		VALUES($1,'lab_rules_confirmation_requested','Requested','Someone asked.',now(),now()+interval '1 day')`, notification)

	content, err := os.ReadFile(migration)
	if err != nil {
		t.Fatal(err)
	}
	up, down, found := strings.Cut(string(content), "-- +goose Down")
	if !found {
		t.Fatal("00104 has no Down section")
	}
	exec(up)

	assertCount(t, pool, `SELECT count(*) FROM laborordnung_confirmations`, 1)
	assertCount(t, pool, `
		SELECT count(*) FROM laborordnung_confirmations
		WHERE id=$1 AND person_id=$2 AND version_id=$3 AND method='paper' AND confirmed_by_account_id=$4
		  AND physical_document_reference='folder-7' AND signed_date='2026-02-01' AND archive_note='shelf B'`,
		1, paper, signed.personID, effective, supervisor.accountID)
	assertCount(t, pool, `SELECT count(*) FROM pg_tables WHERE tablename='attendance_holds' AND schemaname=current_schema()`, 0)
	assertCount(t, pool, `SELECT count(*) FROM role_permission_grants WHERE role_id=$1 AND permission_id='laborordnung.confirmations.read'`, 1, role)
	assertCount(t, pool, `SELECT count(*) FROM role_permission_grants WHERE permission_id IN ('laborordnung.requests.read','laborordnung.confirm')`, 0)
	assertCount(t, pool, `SELECT count(*) FROM inbox_notifications WHERE id=$1`, 0, notification)
	assertCount(t, pool, `SELECT count(*) FROM laborordnung_versions WHERE id=$1 AND announced_at IS NOT NULL`, 1, effective)
	assertCount(t, pool, `SELECT count(*) FROM laborordnung_versions WHERE id=$1 AND announced_at IS NULL`, 1, upcoming)

	// The version in effect at migration time is not announced again.
	labRules := laborordnung.NewService(pool, inbox.NewEmitter(), nil)
	if announced, err := labRules.Announce(ctx); err != nil || announced {
		t.Fatalf("announce after migration = %v, %v", announced, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM inbox_notifications`, 0)

	exec(`INSERT INTO laborordnung_confirmations(id,person_id,version_id,method,confirmed_at) VALUES($1,$2,$3,'app',now())`,
		ids.New(), waiting.personID, effective)
	exec(down)
	assertCount(t, pool, `
		SELECT count(*) FROM laborordnung_requests
		WHERE id=$1 AND status='completed' AND required_version_id=$2 AND physical_document_reference='folder-7'`,
		1, paper, effective)
	assertCount(t, pool, `SELECT count(*) FROM laborordnung_requests`, 1)
	assertCount(t, pool, `SELECT count(*) FROM role_permission_grants WHERE permission_id='laborordnung.requests.read'`, 1)
	exec(up)
	assertCount(t, pool, `SELECT count(*) FROM laborordnung_confirmations WHERE method='paper'`, 1)
}
