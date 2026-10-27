package integration_test

import (
	"bytes"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

var mergePermissions = []string{"people.merge", "people.read.all", "people.roles.assign"}

func mergeExec(t *testing.T, pool *pgxpool.Pool, query string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(testContext(t), query, args...); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
}

// mergeVersions reads the current person and account versions, as a client copies them from the preview.
func mergeVersions(t *testing.T, pool *pgxpool.Pool, personIDs ...uuid.UUID) []people.MergeExpectedVersion {
	t.Helper()
	result := make([]people.MergeExpectedVersion, 0, len(personIDs))
	for _, id := range personIDs {
		version := people.MergeExpectedVersion{PersonID: id}
		var accountVersion *int64
		if err := pool.QueryRow(testContext(t), `SELECT p.version, a.version FROM people p
			LEFT JOIN accounts a ON a.person_id=p.id WHERE p.id=$1`, id).Scan(&version.Version, &accountVersion); err != nil {
			t.Fatal(err)
		}
		version.AccountVersion = accountVersion
		result = append(result, version)
	}
	return result
}

func mergeConflictCodes(preview people.MergePreview) map[people.MergeConflictCode]bool {
	codes := map[people.MergeConflictCode]bool{}
	for _, conflict := range preview.Conflicts {
		codes[conflict.Code] = true
	}
	return codes
}

func TestPeopleMergeHandlesEveryReference(t *testing.T) {
	pool := migratedPool(t)
	rows, err := pool.Query(testContext(t), `
		SELECT c.conrelid::regclass::text, a.attname::text, c.confrelid::regclass::text
		FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum = ANY(c.conkey)
		WHERE c.contype='f' AND c.confrelid IN ('people'::regclass, 'accounts'::regclass)`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	inDatabase := map[string]bool{}
	for rows.Next() {
		var table, column, referenced string
		if err := rows.Scan(&table, &column, &referenced); err != nil {
			t.Fatal(err)
		}
		inDatabase[table+"."+column+" -> "+referenced] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	handled := map[string]bool{}
	for _, reference := range people.MergeReferences {
		handled[reference.Table+"."+reference.Column+" -> "+reference.Referenced] = true
	}
	var missing, stale []string
	for key := range inDatabase {
		if !handled[key] {
			missing = append(missing, key)
		}
	}
	for key := range handled {
		if !inDatabase[key] {
			stale = append(stale, key)
		}
	}
	sort.Strings(missing)
	sort.Strings(stale)
	if len(missing) > 0 {
		t.Errorf("people merge does not handle these references (add them to people.MergeReferences and merge_execute.go): %v", missing)
	}
	if len(stale) > 0 {
		t.Errorf("people.MergeReferences lists references that no longer exist: %v", stale)
	}
}

func TestPeopleMergeMasterPolicyRequiresFreshSignIn(t *testing.T) {
	pool := migratedPool(t)
	assertCount(t, pool,
		`SELECT count(*) FROM master_reauthentication_permissions WHERE permission_id='people.merge' AND within_minutes=10`, 1)
}

func TestPeopleMergePreviewReportsConflictsAndHidesMatriculation(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	actor, _ := principalWithPermissions(t, pool, "merge-preview-actor", mergePermissions...)
	reader, _ := principalWithPermissions(t, pool, "merge-preview-reader",
		append([]string{"people.read.matriculation"}, mergePermissions...)...)
	target := seedAccount(t, pool, "merge-preview-target", false)
	source := seedAccount(t, pool, "merge-preview-source", false)
	mergeExec(t, pool, `UPDATE people SET matriculation_number='01234567' WHERE id=$1`, source.personID)
	for index, account := range []seededAccount{target, source} {
		mergeExec(t, pool, `INSERT INTO auth_identities(id,account_id,kind,identifier_display,identifier_normalized)
			VALUES(uuidv7(),$1,'pin',$2,$2)`, account.accountID, []string{"merge-pin-a", "merge-pin-b"}[index])
		mergeExec(t, pool, `INSERT INTO mfa_totp_credentials(id,account_id,secret_ciphertext,confirmed_at)
			VALUES(uuidv7(),$1,'\x01',now())`, account.accountID)
		mergeExec(t, pool, `INSERT INTO visits(id,person_id,checked_in_at,status,check_in_method,check_in_assurance,admission_decision)
			VALUES(uuidv7(),$1,now(),'checked_in','supervisor','normal','admitted')`, account.personID)
	}
	selection := people.MergeSelection{TargetPersonID: target.personID, SourcePersonIDs: []uuid.UUID{source.personID}}
	service := people.NewService(pool, nil)
	preview, err := service.PreviewMerge(ctx, actor, selection)
	if err != nil {
		t.Fatal(err)
	}
	codes := mergeConflictCodes(preview)
	for _, code := range []people.MergeConflictCode{people.ConflictPINs, people.ConflictTOTP, people.ConflictOpenVisits} {
		if !codes[code] {
			t.Errorf("conflict %s missing: %+v", code, preview.Conflicts)
		}
	}
	if preview.CanMerge() || len(preview.People) != 2 || preview.People[0].Person.ID != target.personID {
		t.Fatalf("preview = %+v", preview)
	}
	if preview.People[1].Person.MatriculationNumber != nil {
		t.Fatal("matriculation number exposed without people.read.matriculation")
	}
	if preview.SurvivingAccountID == nil || *preview.SurvivingAccountID != target.accountID {
		t.Fatalf("surviving account = %v", preview.SurvivingAccountID)
	}
	account := preview.People[1].Account
	if account == nil || !account.PINEnrolled || !account.TOTPEnrolled || !account.PasswordSet {
		t.Fatalf("source account summary = %+v", account)
	}
	visible, err := service.PreviewMerge(ctx, reader, selection)
	if err != nil {
		t.Fatal(err)
	}
	if number := visible.People[1].Person.MatriculationNumber; number == nil || *number != "01234567" {
		t.Fatalf("matriculation with permission = %v", number)
	}
	// Executing reports the same conflicts and changes nothing.
	_, err = service.Merge(ctx, actor, people.MergeInput{
		MergeSelection:   selection,
		ExpectedVersions: mergeVersions(t, pool, target.personID, source.personID),
	}, nil)
	expectAppCode(t, err, "people_merge_blocked")
	assertCount(t, pool, `SELECT count(*) FROM people WHERE id=$1`, 1, source.personID)

	if _, err := service.PreviewMerge(ctx, actor, people.MergeSelection{
		TargetPersonID: target.personID, SourcePersonIDs: []uuid.UUID{target.personID},
	}); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("merging a person into itself = %v", err)
	}
	if _, err := service.PreviewMerge(ctx, actor, people.MergeSelection{
		TargetPersonID: target.personID, SourcePersonIDs: []uuid.UUID{ids.New()},
	}); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("unknown source = %v", err)
	}
}

func TestPeopleMergeMovesHistoryAndDeletesSources(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	actor, actorSeed := principalWithPermissions(t, pool, "merge-run-actor", mergePermissions...)
	target := seedAccount(t, pool, "merge-run-target", false)
	source := seedAccount(t, pool, "merge-run-source", false)
	plain := insertPlainPerson(t, pool, "merge-run-plain@example.test")
	mergeExec(t, pool, `UPDATE people SET first_name='Ada', phone='+43 316 000', matriculation_number='0099'
		WHERE id=$1`, source.personID)
	mergeExec(t, pool, `UPDATE people SET member_since='2020-02-02' WHERE id=$1`, plain)

	// A role the actor may delegate, held only by the source.
	roleID := ids.New()
	mergeExec(t, pool, `INSERT INTO roles(id,name) VALUES($1,'Merge helpers')`, roleID)
	mergeExec(t, pool, `INSERT INTO role_permission_grants(id,role_id,permission_id) VALUES(uuidv7(),$1,'people.read.all')`, roleID)
	mergeExec(t, pool, `INSERT INTO person_roles(person_id,role_id) VALUES($1,$2)`, source.personID, roleID)

	// History: a closed visit, the same training for both (the source's "trainer" wins), a second factor and a
	// session on each account, a cash movement recorded by the source (immutable history) and an audit event.
	mergeExec(t, pool, `INSERT INTO visits(id,person_id,checked_in_at,checked_out_at,status,check_in_method,check_in_assurance,
			check_out_method,check_out_assurance,admission_decision)
		VALUES(uuidv7(),$1,now()-interval '2 hours',now()-interval '1 hour','checked_out','supervisor','normal',
			'supervisor','normal','admitted')`, source.personID)
	mergeExec(t, pool, `INSERT INTO visits(id,person_id,checked_in_at,status,check_in_method,check_in_assurance,admission_decision,checked_in_by_account_id)
		VALUES(uuidv7(),$1,now(),'checked_in','supervisor','normal','admitted',$2)`, plain, source.accountID)
	trainingID := ids.New()
	mergeExec(t, pool, `INSERT INTO trainings(id,name) VALUES($1,'Laser cutter')`, trainingID)
	mergeExec(t, pool, `INSERT INTO training_records(person_id,training_id,status) VALUES($1,$2,'trained')`, target.personID, trainingID)
	mergeExec(t, pool, `INSERT INTO training_records(person_id,training_id,status,recorded_by_account_id) VALUES($1,$2,'trainer',$3)`,
		source.personID, trainingID, source.accountID)
	mergeExec(t, pool, `INSERT INTO mfa_totp_credentials(id,account_id,secret_ciphertext,confirmed_at) VALUES(uuidv7(),$1,'\x01',now())`,
		source.accountID)
	for index, account := range []seededAccount{target, source} {
		mergeExec(t, pool, `INSERT INTO sessions(id,account_id,auth_identity_id,token_digest,csrf_digest,auth_method,idle_expires_at,absolute_expires_at)
			VALUES(uuidv7(),$1,$2,$3,$4,'password',now()+interval '1 hour',now()+interval '2 hours')`,
			account.accountID, account.identity, bytes.Repeat([]byte{byte(10 + index)}, 32), bytes.Repeat([]byte{byte(20 + index)}, 32))
	}
	mergeExec(t, pool, `INSERT INTO cash_movements(id,reference,operation_key,kind,amount,reason,occurred_at,recorded_by_person_id)
		VALUES(uuidv7(),'C-2026-000001',uuidv7(),'withdrawal',10,'safe',now(),$1)`, source.personID)
	mergeExec(t, pool, `INSERT INTO audit_events(id,actor_type,actor_account_id,action,resource_type,resource_id)
		VALUES(uuidv7(),'user',$1,'person.updated','person',$2)`, source.accountID, source.personID)

	service := people.NewService(pool, nil)
	input := people.MergeInput{
		MergeSelection: people.MergeSelection{
			TargetPersonID: target.personID, SourcePersonIDs: []uuid.UUID{source.personID, plain},
		},
		ExpectedVersions: mergeVersions(t, pool, target.personID, source.personID, plain),
		FieldSources: map[people.MergeField]uuid.UUID{
			people.MergeFirstName: source.personID, people.MergeEmail: source.personID, people.MergeMemberSince: plain,
		},
	}
	preview, err := service.PreviewMerge(ctx, actor, input.MergeSelection)
	if err != nil {
		t.Fatal(err)
	}
	if !preview.CanMerge() {
		t.Fatalf("conflicts = %+v", preview.Conflicts)
	}
	// Without the matriculation permissions the field cannot be chosen, but the source's value is kept.
	input.FieldSources[people.MergeMatriculationNumber] = source.personID
	if _, err := service.Merge(ctx, actor, input, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("choosing a matriculation number without permission = %v", err)
	}
	delete(input.FieldSources, people.MergeMatriculationNumber)

	result, err := service.Merge(ctx, actor, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	person := result.Person
	if person.ID != target.personID || person.FirstName != "Ada" || person.Email == nil ||
		*person.Email != "merge-run-source@example.test" || person.Phone == nil || *person.Phone != "+43 316 000" ||
		person.MemberSince.Format(time.DateOnly) != "2020-02-02" {
		t.Fatalf("merged person = %+v", person)
	}
	assertCount(t, pool, `SELECT count(*) FROM people WHERE id=$1 AND matriculation_number='0099'`, 1, target.personID)
	assertCount(t, pool, `SELECT count(*) FROM people WHERE id IN ($1,$2)`, 0, source.personID, plain)
	assertCount(t, pool, `SELECT count(*) FROM accounts WHERE id=$1`, 0, source.accountID)
	assertCount(t, pool, `SELECT count(*) FROM person_roles WHERE person_id=$1 AND role_id=$2`, 1, target.personID, roleID)
	// The chosen login email (with its password) survives on the target's account; the other identity is gone.
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE account_id=$1 AND kind='password'
		AND identifier_normalized='merge-run-source@example.test'`, 1, target.accountID)
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE identifier_normalized='merge-run-target@example.test'`, 0)
	assertCount(t, pool, `SELECT count(*) FROM password_credentials WHERE auth_identity_id=$1`, 1, source.identity)
	assertCount(t, pool, `SELECT count(*) FROM mfa_totp_credentials WHERE account_id=$1`, 1, target.accountID)
	assertCount(t, pool, `SELECT count(*) FROM sessions WHERE account_id=$1 AND revoked_at IS NULL`, 0, target.accountID)
	assertCount(t, pool, `SELECT count(*) FROM visits WHERE person_id=$1`, 2, target.personID)
	assertCount(t, pool, `SELECT count(*) FROM visits WHERE checked_in_by_account_id=$1`, 1, target.accountID)
	assertCount(t, pool, `SELECT count(*) FROM training_records WHERE person_id=$1 AND status='trainer'
		AND recorded_by_account_id=$2`, 1, target.personID, target.accountID)
	assertCount(t, pool, `SELECT count(*) FROM cash_movements WHERE recorded_by_person_id=$1`, 1, target.personID)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='person.updated' AND resource_id=$1
		AND actor_account_id=$2`, 1, target.personID, target.accountID)
	var changedFields []string
	var metadata map[string]string
	if err := pool.QueryRow(ctx, `SELECT changed_fields, metadata FROM audit_events
		WHERE action='person.merged' AND resource_type='person' AND resource_id=$1 AND actor_account_id=$2`,
		target.personID, actorSeed.accountID).Scan(&changedFields, &metadata); err != nil {
		t.Fatal(err)
	}
	if metadata["countMergedPeople"] != "2" || metadata["countVisits"] != "2" || metadata["countTrainingRecords"] != "1" {
		t.Fatalf("audit metadata = %v", metadata)
	}
	for _, value := range metadata {
		if value == "Ada" || value == "merge-run-source@example.test" || value == "0099" {
			t.Fatalf("audit metadata contains personal data: %v", metadata)
		}
	}
	counts := map[people.MergeCategory]int64{}
	for _, count := range result.Moved {
		counts[count.Category] = count.Count
	}
	if counts[people.MergedVisits] != 2 || counts[people.MergedCashMovements] != 1 || counts[people.MergedActorReferences] == 0 {
		t.Fatalf("moved = %+v", result.Moved)
	}
	// Immutable history stays protected outside a merge.
	_, err = pool.Exec(ctx, `UPDATE cash_movements SET recorded_by_person_id=$1`, actorSeed.personID)
	expectPostgresCode(t, err, "23514")
}

func TestPeopleMergeAttachesTheSourceAccountToATargetWithoutOne(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	actor, _ := principalWithPermissions(t, pool, "merge-attach-actor", mergePermissions...)
	target := insertPlainPerson(t, pool, "merge-attach-target@example.test")
	source := seedAccount(t, pool, "merge-attach-source", false)
	service := people.NewService(pool, nil)
	input := people.MergeInput{
		MergeSelection:   people.MergeSelection{TargetPersonID: target, SourcePersonIDs: []uuid.UUID{source.personID}},
		ExpectedVersions: mergeVersions(t, pool, target, source.personID),
		FieldSources:     map[people.MergeField]uuid.UUID{people.MergeEmail: target},
	}
	if _, err := service.Merge(ctx, actor, input, nil); !apperror.IsCode(err, "merge_email_requires_account") {
		t.Fatalf("email from a person without account = %v", err)
	}
	input.FieldSources = nil
	result, err := service.Merge(ctx, actor, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Person.Email == nil || *result.Person.Email != "merge-attach-source@example.test" {
		t.Fatalf("email = %v", result.Person.Email)
	}
	assertCount(t, pool, `SELECT count(*) FROM accounts WHERE id=$1 AND person_id=$2 AND version=2`, 1, source.accountID, target)
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE account_id=$1 AND kind='password'`, 1, source.accountID)
}

func TestPeopleMergeRejectsStaleVersions(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	actor, _ := principalWithPermissions(t, pool, "merge-stale-actor", mergePermissions...)
	target := seedAccount(t, pool, "merge-stale-target", false)
	source := insertPlainPerson(t, pool, "merge-stale-source@example.test")
	service := people.NewService(pool, nil)
	selection := people.MergeSelection{TargetPersonID: target.personID, SourcePersonIDs: []uuid.UUID{source}}
	versions := mergeVersions(t, pool, target.personID, source)
	stalePerson := append([]people.MergeExpectedVersion(nil), versions...)
	stalePerson[1].Version++
	if _, err := service.Merge(ctx, actor, people.MergeInput{MergeSelection: selection, ExpectedVersions: stalePerson}, nil); !errors.Is(err, apperror.StaleWrite) {
		t.Fatalf("stale person version = %v", err)
	}
	missingAccount := append([]people.MergeExpectedVersion(nil), versions...)
	missingAccount[0].AccountVersion = nil
	if _, err := service.Merge(ctx, actor, people.MergeInput{MergeSelection: selection, ExpectedVersions: missingAccount}, nil); !errors.Is(err, apperror.StaleWrite) {
		t.Fatalf("account appeared since the preview = %v", err)
	}
	if _, err := service.Merge(ctx, actor, people.MergeInput{MergeSelection: selection, ExpectedVersions: versions[:1]}, nil); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("incomplete versions = %v", err)
	}
	assertCount(t, pool, `SELECT count(*) FROM people WHERE id=$1`, 1, source)
	if _, err := service.Merge(ctx, actor, people.MergeInput{MergeSelection: selection, ExpectedVersions: versions}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestPeopleMergeAuthorization(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service := people.NewService(pool, nil)
	target := seedAccount(t, pool, "merge-auth-target", false)
	source := insertPlainPerson(t, pool, "merge-auth-source@example.test")
	selection := people.MergeSelection{TargetPersonID: target.personID, SourcePersonIDs: []uuid.UUID{source}}
	input := people.MergeInput{MergeSelection: selection, ExpectedVersions: mergeVersions(t, pool, target.personID, source)}

	without, _ := principalWithPermissions(t, pool, "merge-auth-none", "people.read.all", "people.delete")
	if _, err := service.PreviewMerge(ctx, without, selection); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("preview without people.merge = %v", err)
	}
	if _, err := service.Merge(ctx, without, input, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("merge without people.merge = %v", err)
	}

	// A grant that requires a fresh sign-in is withheld from a stale session and reported as such.
	_, seeded := principalWithPermissions(t, pool, "merge-auth-fresh", mergePermissions...)
	mergeExec(t, pool, `UPDATE role_permission_grants SET reauth_within_minutes=10, minimum_assurance='normal'
		WHERE permission_id='people.merge' AND role_id IN (SELECT role_id FROM person_roles WHERE person_id=$1)`, seeded.personID)
	stale, err := authorization.LoadPermissionsFrom(ctx, pool, authorization.Principal{
		AccountID: seeded.accountID, PersonID: seeded.personID, Assurance: authorization.AssuranceNormal,
		AuthenticatedAt: time.Now().Add(-time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Merge(ctx, stale, input, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("merge with a stale sign-in = %v", err)
	}
	if requirement, denied := stale.ReauthenticationDenial(); !denied || requirement.WithinMinutes != 10 {
		t.Fatalf("reauthentication denial = %v %+v", denied, requirement)
	}

	// Only a master merges a person who holds the master role.
	master := seedAccount(t, pool, "merge-auth-master", true)
	actor, _ := principalWithPermissions(t, pool, "merge-auth-actor", mergePermissions...)
	masterSelection := people.MergeSelection{TargetPersonID: target.personID, SourcePersonIDs: []uuid.UUID{master.personID}}
	preview, err := service.PreviewMerge(ctx, actor, masterSelection)
	if err != nil {
		t.Fatal(err)
	}
	if !mergeConflictCodes(preview)[people.ConflictMasterMergeForbidden] {
		t.Fatalf("conflicts = %+v", preview.Conflicts)
	}
	if _, err := service.Merge(ctx, actor, people.MergeInput{
		MergeSelection: masterSelection, ExpectedVersions: mergeVersions(t, pool, target.personID, master.personID),
	}, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("non-master merging a master = %v", err)
	}
	// A role the actor cannot delegate blocks the merge too.
	roleID := ids.New()
	mergeExec(t, pool, `INSERT INTO roles(id,name) VALUES($1,'Treasurers')`, roleID)
	mergeExec(t, pool, `INSERT INTO role_permission_grants(id,role_id,permission_id) VALUES(uuidv7(),$1,'payments.reverse')`, roleID)
	mergeExec(t, pool, `INSERT INTO person_roles(person_id,role_id) VALUES($1,$2)`, source, roleID)
	if _, err := service.Merge(ctx, actor, people.MergeInput{
		MergeSelection: selection, ExpectedVersions: mergeVersions(t, pool, target.personID, source),
	}, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("merging a role the actor cannot assign = %v", err)
	}
}

func TestPeopleMergeKeepsAnEnabledMaster(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service := people.NewService(pool, nil)
	operator := seedAccount(t, pool, "merge-master-operator", false)
	master := authorization.Principal{AccountID: operator.accountID, PersonID: operator.personID, Master: true}
	onlyMaster := seedAccount(t, pool, "merge-master-only", true)
	disabledTarget := seedAccount(t, pool, "merge-master-target", false)
	mergeExec(t, pool, `UPDATE accounts SET status='disabled' WHERE id=$1`, disabledTarget.accountID)
	input := people.MergeInput{
		MergeSelection: people.MergeSelection{
			TargetPersonID: disabledTarget.personID, SourcePersonIDs: []uuid.UUID{onlyMaster.personID},
		},
		ExpectedVersions: mergeVersions(t, pool, disabledTarget.personID, onlyMaster.personID),
	}
	if _, err := service.Merge(ctx, master, input, nil); !apperror.IsCode(err, "last_master_required") {
		t.Fatalf("merging the only enabled master into a disabled account = %v", err)
	}
	mergeExec(t, pool, `UPDATE accounts SET status='enabled' WHERE id=$1`, disabledTarget.accountID)
	input.ExpectedVersions = mergeVersions(t, pool, disabledTarget.personID, onlyMaster.personID)
	if _, err := service.Merge(ctx, master, input, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM person_roles WHERE person_id=$1 AND role_id=$2`, 1, disabledTarget.personID, masterRoleID)
}

func TestPeopleMergeHTTPRequiresAFreshMasterSignIn(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	const (
		origin   = "http://makerspace.example.test"
		login    = "merge-http-master@example.test"
		password = "Merge HTTP master workshop password 7"
	)
	if _, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Merge", LastName: "Master", LoginEmail: login, Password: password,
	}); err != nil {
		t.Fatal(err)
	}
	baseURL, err := url.Parse(origin)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		PublicBaseURL: baseURL, SessionCookieName: "makerspace_session", CSRFCookieName: "makerspace_csrf",
		SessionIdleTTL: 6 * time.Hour, SessionAbsoluteTTL: 72 * time.Hour, PasswordResetTTL: 30 * time.Minute,
	}
	handler, err := httpapi.NewHandler(pool, cfg, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	client := newCookieClient(t)
	response := doJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", origin, "", map[string]any{
		"email": login, "password": password,
	})
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	csrf := cookieValue(t, client, server.URL, cfg.CSRFCookieName)

	target := insertPlainPerson(t, pool, "merge-http-target@example.test")
	source := insertPlainPerson(t, pool, "merge-http-source@example.test")
	mergeExec(t, pool, `UPDATE people SET matriculation_number='M-1' WHERE id=$1`, source)
	selection := map[string]any{"targetPersonId": target, "sourcePersonIds": []uuid.UUID{source}}

	// The default master policy needs a strong_mfa sign-in within ten minutes for people.merge.
	mergeExec(t, pool, `UPDATE sessions SET authenticated_at=now()-interval '1 hour' WHERE revoked_at IS NULL`)
	response = doJSON(t, client, http.MethodPost, server.URL+"/api/v1/people/merge/preview", origin, csrf, selection)
	assertStatus(t, response, http.StatusForbidden)
	var failure openapi.Error
	decodeResponse(t, response, &failure)
	if failure.Code != "reauthentication_required" {
		t.Fatalf("stale master preview = %+v", failure)
	}
	elevateMasterSessions(t, pool)

	response = doJSON(t, client, http.MethodPost, server.URL+"/api/v1/people/merge/preview", origin, csrf, selection)
	assertStatus(t, response, http.StatusOK)
	var preview openapi.PeopleMergePreview
	decodeResponse(t, response, &preview)
	if !preview.CanMerge || len(preview.People) != 2 || preview.People[1].MatriculationNumber.MustGet() != "M-1" ||
		preview.SurvivingAccountId.IsSpecified() && !preview.SurvivingAccountId.IsNull() {
		t.Fatalf("preview = %+v", preview)
	}
	expected := make([]map[string]any, 0, 2)
	for _, candidate := range preview.People {
		expected = append(expected, map[string]any{"personId": candidate.Id, "version": candidate.Version, "accountVersion": nil})
	}
	response = doJSON(t, client, http.MethodPost, server.URL+"/api/v1/people/merge", origin, csrf, map[string]any{
		"targetPersonId": target, "sourcePersonIds": []uuid.UUID{source}, "expectedVersions": expected,
		"fieldSources": map[string]any{"email": source, "matriculationNumber": source},
	})
	assertStatus(t, response, http.StatusOK)
	var result openapi.PeopleMergeResult
	decodeResponse(t, response, &result)
	if result.Person.Id != target || string(result.Person.Email.MustGet()) != "merge-http-source@example.test" ||
		result.Person.MatriculationNumber.MustGet() != "M-1" || len(result.MergedPersonIds) != 1 {
		t.Fatalf("result = %+v", result)
	}
	assertCount(t, pool, `SELECT count(*) FROM people WHERE id=$1`, 0, source)
}
