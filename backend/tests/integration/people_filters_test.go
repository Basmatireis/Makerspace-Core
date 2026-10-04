package integration_test

import (
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/google/uuid"
)

func TestPeopleListFiltersAccountAndLabRulesStatuses(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service := people.NewService(pool)
	principal := authorization.Principal{Master: true}

	seedAccount(t, pool, "directory-filter-enabled", false)
	disabled := seedAccount(t, pool, "directory-filter-disabled", false)
	if _, err := pool.Exec(ctx, `UPDATE accounts SET status='disabled' WHERE id=$1`, disabled.accountID); err != nil {
		t.Fatal(err)
	}
	withoutAccountID := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO people(id,first_name,last_name,email) VALUES($1,'No','Account','directory-filter-no-account@example.test')`, withoutAccountID); err != nil {
		t.Fatal(err)
	}

	page, err := service.List(ctx, principal, 1, 100, people.ListFilters{
		Search: "directory-filter-", AccountStatuses: []string{"disabled", "no_account"},
	})
	if err != nil {
		t.Fatal(err)
	}
	assertPeoplePageIDs(t, page, disabled.personID, withoutAccountID)

	creator := seedAccount(t, pool, "directory-filter-version-creator", false)
	currentVersionID := insertPublishedLabRulesVersion(t, pool, creator.accountID, "directory-filter-v1")
	warningRoleID := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO roles(id,name,laborordnung_mode) VALUES($1,'Directory filter warning','warning')`, warningRoleID); err != nil {
		t.Fatal(err)
	}
	current := seedAccount(t, pool, "directory-filter-lab-current", false)
	pending := seedAccount(t, pool, "directory-filter-lab-pending", false)
	outdated := seedAccount(t, pool, "directory-filter-lab-outdated", false)
	notRequired := seedAccount(t, pool, "directory-filter-lab-not-required", false)
	for _, personID := range []uuid.UUID{current.personID, pending.personID, outdated.personID} {
		if _, err := pool.Exec(ctx, `INSERT INTO person_roles(person_id,role_id) VALUES($1,$2)`, personID, warningRoleID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO laborordnung_requests(
			id,person_id,required_version_id,status,completed_at,confirmed_by_account_id,physical_document_reference
		) VALUES($1,$2,$3,'completed',now(),$4,'directory-filter-current')`,
		uuid.Must(uuid.NewV7()), current.personID, currentVersionID, creator.accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO laborordnung_requests(id,person_id,required_version_id) VALUES($1,$2,$3)`,
		uuid.Must(uuid.NewV7()), pending.personID, currentVersionID); err != nil {
		t.Fatal(err)
	}

	page, err = service.List(ctx, principal, 1, 100, people.ListFilters{
		Search: "directory-filter-lab-", LaborordnungStatuses: []string{"current", "pending"},
	})
	if err != nil {
		t.Fatal(err)
	}
	assertPeoplePageIDs(t, page, current.personID, pending.personID)

	page, err = service.List(ctx, principal, 1, 100, people.ListFilters{
		Search: "directory-filter-lab-", LaborordnungStatuses: []string{"outdated"},
	})
	if err != nil {
		t.Fatal(err)
	}
	assertPeoplePageIDs(t, page, outdated.personID)

	page, err = service.List(ctx, principal, 1, 100, people.ListFilters{
		Search: "directory-filter-lab-", LaborordnungStatuses: []string{"not_required"},
	})
	if err != nil {
		t.Fatal(err)
	}
	assertPeoplePageIDs(t, page, notRequired.personID)
}

func TestPeopleListFiltersMissingPublishedLabRulesVersion(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	roleID := uuid.Must(uuid.NewV7())
	subject := seedAccount(t, pool, "directory-filter-no-published-version", false)
	if _, err := pool.Exec(ctx, `INSERT INTO roles(id,name,laborordnung_mode) VALUES($1,'No published version warning','warning')`, roleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO person_roles(person_id,role_id) VALUES($1,$2)`, subject.personID, roleID); err != nil {
		t.Fatal(err)
	}

	page, err := people.NewService(pool).List(ctx, authorization.Principal{Master: true}, 1, 100, people.ListFilters{
		Search: "directory-filter-no-published-version", LaborordnungStatuses: []string{"no_published_version"},
	})
	if err != nil {
		t.Fatal(err)
	}
	assertPeoplePageIDs(t, page, subject.personID)
}

func assertPeoplePageIDs(t *testing.T, page people.Page, expected ...uuid.UUID) {
	t.Helper()
	if page.Total != int64(len(expected)) || len(page.Items) != len(expected) {
		t.Fatalf("people page has total/items %d/%d, want %d: %#v", page.Total, len(page.Items), len(expected), page.Items)
	}
	remaining := make(map[uuid.UUID]struct{}, len(expected))
	for _, id := range expected {
		remaining[id] = struct{}{}
	}
	for _, person := range page.Items {
		delete(remaining, person.ID)
	}
	if len(remaining) != 0 {
		t.Fatalf("people page omitted IDs: %#v", remaining)
	}
}
