package integration_test

import (
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accounts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/scim"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// principalWithPermissions gives a fresh account a role holding exactly the listed permissions.
func principalWithPermissions(
	t *testing.T,
	pool *pgxpool.Pool,
	suffix string,
	permissions ...string,
) (authorization.Principal, seededAccount) {
	t.Helper()
	ctx := testContext(t)
	seeded := seedAccount(t, pool, suffix, false)
	roleID := ids.New()
	if _, err := pool.Exec(ctx, `INSERT INTO roles(id,name) VALUES($1,$2)`, roleID, "role-"+suffix); err != nil {
		t.Fatal(err)
	}
	for _, permission := range permissions {
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO role_permission_grants(id,role_id,permission_id) VALUES(uuidv7(),$1,$2)`,
			roleID, permission,
		); err != nil {
			t.Fatalf("grant %s: %v", permission, err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO person_roles(person_id,role_id) VALUES($1,$2)`, seeded.personID, roleID); err != nil {
		t.Fatal(err)
	}
	principal, err := authorization.LoadPermissionsFrom(
		ctx, pool, authorization.Principal{AccountID: seeded.accountID, PersonID: seeded.personID},
	)
	if err != nil {
		t.Fatal(err)
	}
	return principal, seeded
}

func insertPlainPerson(t *testing.T, pool *pgxpool.Pool, email string) uuid.UUID {
	t.Helper()
	id := ids.New()
	if _, err := pool.Exec(
		testContext(t),
		`INSERT INTO people(id,first_name,last_name,email) VALUES($1,'Plain','Person',$2)`, id, email,
	); err != nil {
		t.Fatal(err)
	}
	return id
}

func requireAppError(t *testing.T, err error, status int, code string) {
	t.Helper()
	var appErr *apperror.Error
	if !errors.As(err, &appErr) || appErr.HTTPStatus != status || (code != "" && appErr.Code != code) {
		t.Fatalf("error = %v, want status %d code %q", err, status, code)
	}
}

func personEmail(t *testing.T, pool *pgxpool.Pool, personID uuid.UUID) string {
	t.Helper()
	var email *string
	if err := pool.QueryRow(testContext(t), `SELECT email FROM people WHERE id=$1`, personID).Scan(&email); err != nil {
		t.Fatal(err)
	}
	if email == nil {
		return ""
	}
	return *email
}

func TestAccountCreationRequiresLoginEmailAndMirrorsItIntoThePerson(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service := accounts.NewService(pool, config.Config{}, nil)
	admin, _ := principalWithPermissions(t, pool, "acct-create-admin", "accounts.create", "accounts.read")
	noPermission, _ := principalWithPermissions(t, pool, "acct-create-none")

	personID := insertPlainPerson(t, pool, "old-contact@example.test")
	if _, err := service.Create(ctx, noPermission, personID, "new@example.test", 1, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("create without accounts.create = %v", err)
	}
	if _, err := service.Create(ctx, admin, personID, "  ", 1, nil); err == nil {
		t.Fatal("an empty login email must be rejected")
	} else {
		requireAppError(t, err, http.StatusUnprocessableEntity, "validation_failed")
	}
	assertCount(t, pool, `SELECT count(*) FROM accounts WHERE person_id=$1`, 0, personID)

	account, err := service.Create(ctx, admin, personID, "New.Login@Example.test", 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if account.LoginEmail != "New.Login@Example.test" {
		t.Fatalf("login email = %q", account.LoginEmail)
	}
	if got := personEmail(t, pool, personID); got != "New.Login@Example.test" {
		t.Fatalf("person email = %q, want the login email", got)
	}
	assertCount(t, pool, `SELECT count(*) FROM people WHERE id=$1 AND version=2`, 1, personID)

	// A login email held by another account is a conflict and leaves no account behind.
	other := insertPlainPerson(t, pool, "other@example.test")
	if _, err := service.Create(ctx, admin, other, "new.login@example.test", 1, nil); err == nil {
		t.Fatal("duplicate login email must be rejected")
	} else {
		requireAppError(t, err, http.StatusConflict, "")
	}
	assertCount(t, pool, `SELECT count(*) FROM accounts WHERE person_id=$1`, 0, other)
}

func TestLoginEmailChangeUpdatesPersonEmailAndNeedsPermission(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service := accounts.NewService(pool, config.Config{}, nil)
	editor, _ := principalWithPermissions(t, pool, "login-edit-admin", "accounts.login_email.update")
	reader, _ := principalWithPermissions(t, pool, "login-edit-reader", "accounts.read", "people.update.all")
	target := seedAccount(t, pool, "login-edit-target", false)
	taken := seedAccount(t, pool, "login-edit-taken", false)

	if _, err := service.UpdateLoginEmail(ctx, reader, target.accountID, "x@example.test", 1, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("login email change without permission = %v", err)
	}
	if _, err := service.UpdateLoginEmail(ctx, editor, target.accountID, personEmail(t, pool, taken.personID), 1, nil); err == nil {
		t.Fatal("login email of another account must be rejected")
	} else {
		requireAppError(t, err, http.StatusConflict, "")
	}
	if got := personEmail(t, pool, target.personID); got != "login-edit-target@example.test" {
		t.Fatalf("a rejected change altered the person email: %q", got)
	}

	updated, err := service.UpdateLoginEmail(ctx, editor, target.accountID, "Renamed@Example.test", 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if updated.LoginEmail != "Renamed@Example.test" || personEmail(t, pool, target.personID) != "Renamed@Example.test" {
		t.Fatalf("login email %q, person email %q", updated.LoginEmail, personEmail(t, pool, target.personID))
	}
	assertCount(t, pool, `SELECT count(*) FROM people WHERE id=$1 AND version=2`, 1, target.personID)
	assertCount(t, pool,
		`SELECT count(*) FROM auth_identities WHERE account_id=$1 AND kind='password' AND identifier_normalized='renamed@example.test'`,
		1, target.accountID)
}

func TestLoginEmailCreatesMissingIdentityForAccountWithoutOne(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service := accounts.NewService(pool, config.Config{}, nil)
	editor, _ := principalWithPermissions(t, pool, "login-missing-admin", "accounts.login_email.update")
	target := seedAccount(t, pool, "login-missing-target", false)
	if _, err := pool.Exec(testContext(t), `DELETE FROM auth_identities WHERE account_id=$1`, target.accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.UpdateLoginEmail(ctx, editor, target.accountID, "fresh@example.test", 1, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE account_id=$1 AND kind='password'`, 1, target.accountID)
	if got := personEmail(t, pool, target.personID); got != "fresh@example.test" {
		t.Fatalf("person email = %q", got)
	}
}

func TestPersonUpdateCannotDivergeAccountHolderEmail(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service := people.NewService(pool, nil)
	admin, _ := principalWithPermissions(t, pool, "diverge-admin", "people.update.all", "people.read.all")
	target := seedAccount(t, pool, "diverge-target", false)
	changed := "other-address@example.test"

	_, err := service.Update(ctx, admin, target.personID, people.UpdateInput{
		ExpectedVersion: 1, Email: people.OptionalString{Set: true, Value: &changed},
	}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "email_managed_by_account")
	_, err = service.Update(ctx, admin, target.personID, people.UpdateInput{
		ExpectedVersion: 1, Email: people.OptionalString{Set: true},
	}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "email_managed_by_account")
	if got := personEmail(t, pool, target.personID); got != "diverge-target@example.test" {
		t.Fatalf("person email = %q", got)
	}

	// Resending the current email together with another change is accepted.
	current, first := personEmail(t, pool, target.personID), "Renamed"
	updated, err := service.Update(ctx, admin, target.personID, people.UpdateInput{
		ExpectedVersion: 1, FirstName: &first, Email: people.OptionalString{Set: true, Value: &current},
	}, nil)
	if err != nil || updated.FirstName != "Renamed" {
		t.Fatalf("update with unchanged email = %v, %v", updated.FirstName, err)
	}

	// People without an account keep a freely editable email.
	plain := insertPlainPerson(t, pool, "plain@example.test")
	if _, err := service.Update(ctx, admin, plain, people.UpdateInput{
		ExpectedVersion: 1, Email: people.OptionalString{Set: true, Value: &changed},
	}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestMemberSinceRequiresAllScopeUpdatePermission(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service := people.NewService(pool, nil)
	selfEditor, self := principalWithPermissions(t, pool, "since-self", "people.update.self", "people.read.self")
	allEditor, _ := principalWithPermissions(t, pool, "since-all", "people.update.all", "people.read.all")
	day := time.Date(2024, time.September, 5, 0, 0, 0, 0, time.UTC)

	// Own profile edits work, but never with memberSince.
	first := "Selfmade"
	if _, err := service.Update(ctx, selfEditor, self.personID, people.UpdateInput{ExpectedVersion: 1, FirstName: &first}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Update(ctx, selfEditor, self.personID, people.UpdateInput{ExpectedVersion: 2, MemberSince: &day}, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("self-scope memberSince = %v", err)
	}
	other := insertPlainPerson(t, pool, "since-other@example.test")
	if _, err := service.Update(ctx, selfEditor, other, people.UpdateInput{ExpectedVersion: 1, MemberSince: &day}, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("self-scope memberSince of another person = %v", err)
	}

	updated, err := service.Update(ctx, allEditor, other, people.UpdateInput{ExpectedVersion: 1, MemberSince: &day}, nil)
	if err != nil || !updated.MemberSince.Equal(day) {
		t.Fatalf("all-scope memberSince = %v, %v", updated.MemberSince, err)
	}
	assertCount(t, pool,
		`SELECT count(*) FROM audit_events WHERE action='person.updated' AND resource_id=$1 AND changed_fields @> ARRAY['memberSince']`,
		1, other)
	future := time.Now().UTC().AddDate(0, 0, 10)
	if _, err := service.Update(ctx, allEditor, other, people.UpdateInput{ExpectedVersion: 2, MemberSince: &future}, nil); err == nil {
		t.Fatal("a future member-since date must be rejected")
	} else {
		requireAppError(t, err, http.StatusUnprocessableEntity, "validation_failed")
	}
}

func TestNewPeopleStartMembershipToday(t *testing.T) {
	pool := migratedPool(t)
	creator, _ := principalWithPermissions(t, pool, "since-create", "people.create")
	email := "since-created@example.test"
	person, err := people.NewService(pool, nil).Create(testContext(t), creator, people.CreateInput{
		FirstName: "New", LastName: "Member", Email: &email,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	today := time.Now().UTC().Truncate(24 * time.Hour)
	if !person.MemberSince.Equal(today) {
		t.Fatalf("memberSince = %v, want %v", person.MemberSince, today)
	}
}

func TestSCIMPrimaryEmailBecomesLoginEmail(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	owner := seedAccount(t, pool, "scim-email-owner", false)
	principal := authorization.Principal{AccountID: owner.accountID, Master: true}
	service := scim.NewService(pool)
	issue, err := service.CreateConnector(ctx, principal, "Email mapping", nil, true, time.Now().Add(time.Hour), nil)
	if err != nil {
		t.Fatal(err)
	}
	connector, err := service.Authenticate(ctx, issue.BearerToken)
	if err != nil {
		t.Fatal(err)
	}
	input := scim.UserInput{
		UserName: "mapped", Active: true, GivenName: "Mapped", FamilyName: "User",
		Emails: []scim.MultiValue{{Value: "Mapped.User@Example.test", Primary: true}},
	}
	user, err := service.CreateUser(ctx, connector, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	var accountID, personID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT account_id,person_id FROM scim_users WHERE id=$1`, user.ID).Scan(&accountID, &personID); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool,
		`SELECT count(*) FROM auth_identities WHERE account_id=$1 AND kind='password' AND identifier_display='Mapped.User@Example.test' AND identifier_normalized='mapped.user@example.test'`,
		1, accountID)
	if got := personEmail(t, pool, personID); got != "Mapped.User@Example.test" {
		t.Fatalf("person email = %q", got)
	}

	// A replace with a new primary email moves the login email along; one without an email keeps it.
	input.Emails = []scim.MultiValue{{Value: "moved@example.test", Primary: true}}
	if _, err := service.ReplaceUser(ctx, connector, user.ID, input, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE account_id=$1 AND kind='password' AND identifier_display='moved@example.test'`, 1, accountID)
	input.Emails = nil
	input.PhoneNumbers = []scim.MultiValue{{Value: "+43 660 1", Primary: true}}
	if _, err := service.ReplaceUser(ctx, connector, user.ID, input, nil); err != nil {
		t.Fatal(err)
	}
	if got := personEmail(t, pool, personID); got != "moved@example.test" {
		t.Fatalf("person email after replace without email = %q", got)
	}

	// An address already used as login email by another account is a SCIM uniqueness conflict.
	clash := input
	clash.UserName = "clash"
	clash.Emails = []scim.MultiValue{{Value: personEmail(t, pool, owner.personID), Primary: true}}
	if _, err := service.CreateUser(ctx, connector, clash, nil); err == nil {
		t.Fatal("duplicate login email must be rejected")
	}
	assertCount(t, pool, `SELECT count(*) FROM scim_users WHERE user_name='clash'`, 0)
}

// Migration 00061 backfills member_since in Vienna time, mirrors login emails into people and creates login
// identities for accounts that had none, except where the address is taken or not plain ASCII.
func TestAccountEmailMigrationBackfill(t *testing.T) {
	pool := emptySchemaPool(t)
	ctx := testContext(t)
	var before []string
	var migration string
	for _, path := range allMigrationFiles(t) {
		switch {
		case filepath.Base(path) < "00061_":
			before = append(before, path)
		case strings.HasPrefix(filepath.Base(path), "00061_"):
			migration = path
		}
	}
	if migration == "" {
		t.Fatal("00061 migration is missing")
	}
	applyMigrationFiles(t, pool, before)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}
	type seeded struct{ person, account uuid.UUID }
	account := func(contact *string, login *string, created string) seeded {
		s := seeded{ids.New(), ids.New()}
		exec(`INSERT INTO people(id,first_name,last_name,email,phone,created_at) VALUES($1,'A','B',$2,'+43 1',$3::timestamptz)`,
			s.person, contact, created)
		exec(`INSERT INTO accounts(id,person_id,status,created_at) VALUES($1,$2,'enabled',$3::timestamptz)`, s.account, s.person, created)
		if login != nil {
			exec(`INSERT INTO auth_identities(id,account_id,kind,identifier_display,identifier_normalized) VALUES(uuidv7(),$1,'password',$2,lower($2))`,
				s.account, *login)
		}
		return s
	}
	str := func(v string) *string { return &v }
	withLogin := account(str("contact@example.test"), str("Login@Example.test"), "2026-03-01T23:30:00Z")
	adopt := account(str("Adopt@Example.test"), nil, "2026-01-10T10:00:00Z")
	// Two accounts whose persons share an address: the older one adopts it.
	older := account(str("shared@example.test"), nil, "2026-01-01T10:00:00Z")
	younger := account(str("SHARED@example.test"), nil, "2026-02-01T10:00:00Z")
	taken := account(str("login@example.test"), nil, "2026-01-11T10:00:00Z")
	unicode := account(str("jürgen@example.test"), nil, "2026-01-12T10:00:00Z")
	noEmail := account(nil, nil, "2026-01-13T10:00:00Z")
	spaced := account(str("with space@example.test"), nil, "2026-01-15T10:00:00Z")
	noAt := account(str("not-an-address"), nil, "2026-01-16T10:00:00Z")
	twoAts := account(str("a@b@example.test"), nil, "2026-01-17T10:00:00Z")

	applyMigrationFiles(t, pool, []string{migration})

	email := func(personID uuid.UUID) string {
		var value *string
		if err := pool.QueryRow(ctx, `SELECT email FROM people WHERE id=$1`, personID).Scan(&value); err != nil {
			t.Fatal(err)
		}
		if value == nil {
			return ""
		}
		return *value
	}
	loginOf := func(accountID uuid.UUID) string {
		var value string
		err := pool.QueryRow(ctx, `SELECT identifier_normalized FROM auth_identities WHERE account_id=$1 AND kind='password'`, accountID).Scan(&value)
		if err != nil {
			return ""
		}
		return value
	}
	if email(withLogin.person) != "Login@Example.test" {
		t.Fatalf("person with login identity = %q", email(withLogin.person))
	}
	if loginOf(adopt.account) != "adopt@example.test" || email(adopt.person) != "Adopt@Example.test" {
		t.Fatalf("adopting account login = %q", loginOf(adopt.account))
	}
	if loginOf(older.account) != "shared@example.test" || loginOf(younger.account) != "" {
		t.Fatalf("shared address: older %q younger %q", loginOf(older.account), loginOf(younger.account))
	}
	if loginOf(taken.account) != "" || email(taken.person) != "login@example.test" {
		t.Fatalf("address held by another login must stay without identity, got %q", loginOf(taken.account))
	}
	if loginOf(unicode.account) != "" || loginOf(noEmail.account) != "" {
		t.Fatal("non-ASCII and missing emails must not get a login identity")
	}
	for name, implausible := range map[string]seeded{"spaced": spaced, "no @": noAt, "two @": twoAts} {
		if loginOf(implausible.account) != "" {
			t.Fatalf("%s address got a login identity %q", name, loginOf(implausible.account))
		}
	}
	var memberSince time.Time
	if err := pool.QueryRow(ctx, `SELECT member_since FROM people WHERE id=$1`, withLogin.person).Scan(&memberSince); err != nil {
		t.Fatal(err)
	}
	// 23:30 UTC on 1 March is already 2 March in Vienna.
	if want := time.Date(2026, time.March, 2, 0, 0, 0, 0, time.UTC); !memberSince.Equal(want) {
		t.Fatalf("member_since = %v, want %v", memberSince, want)
	}
}
