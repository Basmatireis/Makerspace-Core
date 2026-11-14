package integration_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

func TestPeopleListFiltersAccountAndLabRulesStatuses(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service := people.NewService(pool, nil)
	principal := authorization.Principal{Master: true}

	seedAccount(t, pool, "directory-filter-enabled", false)
	disabled := seedAccount(t, pool, "directory-filter-disabled", false)
	if _, err := pool.Exec(ctx, `UPDATE accounts SET status='disabled' WHERE id=$1`, disabled.accountID); err != nil {
		t.Fatal(err)
	}
	withoutAccountID := ids.New()
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO people(id,first_name,last_name,email) VALUES($1,'No','Account','directory-filter-no-account@example.test')`,
		withoutAccountID,
	); err != nil {
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
	warningRoleID := ids.New()
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO roles(id,name,laborordnung_mode) VALUES($1,'Directory filter warning','warning')`,
		warningRoleID,
	); err != nil {
		t.Fatal(err)
	}
	current := seedAccount(t, pool, "directory-filter-lab-current", false)
	selfConfirmed := seedAccount(t, pool, "directory-filter-lab-self", false)
	outdated := seedAccount(t, pool, "directory-filter-lab-outdated", false)
	notRequired := seedAccount(t, pool, "directory-filter-lab-not-required", false)
	for _, personID := range []uuid.UUID{current.personID, selfConfirmed.personID, outdated.personID} {
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO person_roles(person_id,role_id) VALUES($1,$2)`,
			personID,
			warningRoleID,
		); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO laborordnung_confirmations(
			id,person_id,version_id,method,confirmed_at,confirmed_by_account_id,physical_document_reference
		) VALUES($1,$2,$3,'paper',now(),$4,'directory-filter-current')`,
		ids.New(), current.personID, currentVersionID, creator.accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO laborordnung_confirmations(id,person_id,version_id,method,confirmed_at) VALUES($1,$2,$3,'kiosk',now())`,
		ids.New(), selfConfirmed.personID, currentVersionID); err != nil {
		t.Fatal(err)
	}

	page, err = service.List(ctx, principal, 1, 100, people.ListFilters{
		Search: "directory-filter-lab-", LaborordnungStatuses: []string{"current"},
	})
	if err != nil {
		t.Fatal(err)
	}
	assertPeoplePageIDs(t, page, current.personID, selfConfirmed.personID)
	if _, err = service.List(ctx, principal, 1, 100, people.ListFilters{LaborordnungStatuses: []string{"pending"}}); err == nil {
		t.Fatal("the pending Lab Rules filter no longer exists and must be rejected")
	}

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
	roleID := ids.New()
	subject := seedAccount(t, pool, "directory-filter-no-published-version", false)
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO roles(id,name,laborordnung_mode) VALUES($1,'No published version warning','warning')`,
		roleID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO person_roles(person_id,role_id) VALUES($1,$2)`,
		subject.personID,
		roleID,
	); err != nil {
		t.Fatal(err)
	}

	page, err := people.NewService(pool, nil).
		List(ctx, authorization.Principal{Master: true}, 1, 100, people.ListFilters{
			Search: "directory-filter-no-published-version", LaborordnungStatuses: []string{"no_published_version"},
		})
	if err != nil {
		t.Fatal(err)
	}
	assertPeoplePageIDs(t, page, subject.personID)
}

func TestPeopleListSearchesFullNameAndGatesMatriculation(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service := people.NewService(pool, nil)
	token := strings.ReplaceAll(ids.New().String(), "-", "")[:8]
	matriculation := fmt.Sprintf("s%07d", time.Now().UnixNano()%10_000_000)
	lovelace, other := ids.New(), ids.New()
	for _, person := range []struct {
		id                  uuid.UUID
		first, last, matric any
	}{{lovelace, "Ada", "Lovelace" + token, matriculation}, {other, "Charles", "Babbage" + token, nil}} {
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO people(id,first_name,last_name,email,matriculation_number) VALUES($1,$2,$3,$4,$5)`,
			person.id, person.first, person.last, "full-name-"+person.id.String()+"@example.test", person.matric,
		); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(
			context.Background(), `DELETE FROM people WHERE id = ANY($1)`, []uuid.UUID{lovelace, other},
		)
	})
	withoutMatriculation, _ := principalWithPermissions(t, pool, "people-search-plain-"+token, "people.read.all")
	withMatriculation, _ := principalWithPermissions(
		t, pool, "people-search-matric-"+token, "people.read.all", "people.read.matriculation",
	)
	search := func(principal authorization.Principal, term string) people.Page {
		t.Helper()
		page, err := service.List(ctx, principal, 1, 100, people.ListFilters{Search: term})
		if err != nil {
			t.Fatal(err)
		}
		return page
	}
	assertPeoplePageIDs(t, search(withoutMatriculation, "ada lovelace"+strings.ToLower(token[:5])), lovelace)
	assertPeoplePageIDs(t, search(withoutMatriculation, "LOVELACE"+token+" ada"), lovelace)
	assertPeoplePageIDs(t, search(withoutMatriculation, "babbage"+token+" charles"), other)
	assertPeoplePageIDs(t, search(withoutMatriculation, matriculation))
	assertPeoplePageIDs(t, search(withMatriculation, matriculation), lovelace)
}

func assertPeoplePageIDs(t *testing.T, page people.Page, expected ...uuid.UUID) {
	t.Helper()
	if page.Total != int64(len(expected)) || len(page.Items) != len(expected) {
		t.Fatalf(
			"people page has total/items %d/%d, want %d: %#v",
			page.Total,
			len(page.Items),
			len(expected),
			page.Items,
		)
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

func TestPeopleListSortsWholeResultBeforePaging(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service := people.NewService(pool, nil)
	// The tail of a UUIDv7 is random; its head is a timestamp shared by IDs made in the same millisecond.
	token := ids.New().String()[24:]
	// Name order is Adams < Baker < Clark; contact, role and Lab Rules orders differ from it.
	adams, baker, clark := ids.New(), ids.New(), ids.New()
	for _, person := range []struct {
		id           uuid.UUID
		last, email  string
		phone        any
		emailMissing bool
	}{
		{id: adams, last: "Adams", email: "c-" + token + "@example.test"},
		{id: baker, last: "Baker", email: "a-" + token + "@example.test"},
		{id: clark, last: "Clark", phone: "+43 " + token, emailMissing: true},
	} {
		var email any = person.email
		if person.emailMissing {
			email = nil
		}
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO people(id,first_name,last_name,email,phone) VALUES($1,'Sort',$2,$3,$4)`,
			person.id, person.last+token, email, person.phone,
		); err != nil {
			t.Fatal(err)
		}
	}
	warningRoleID, plainRoleID := ids.New(), ids.New()
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO roles(id,name,laborordnung_mode) VALUES($1,$2,'warning'),($3,$4,'not_required')`,
		warningRoleID, "Zeta sort "+token, plainRoleID, "Alpha sort "+token,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO person_roles(person_id,role_id) VALUES($1,$2),($3,$4)`,
		adams, warningRoleID, clark, plainRoleID,
	); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM people WHERE id = ANY($1)`, []uuid.UUID{adams, baker, clark})
		_, _ = pool.Exec(context.Background(), `DELETE FROM roles WHERE id = ANY($1)`, []uuid.UUID{warningRoleID, plainRoleID})
	})

	// Reads every page of one person so the order must hold across pages, not only within one.
	order := func(principal authorization.Principal, sort string, descending bool) []uuid.UUID {
		t.Helper()
		var result []uuid.UUID
		for pageNumber := 1; pageNumber <= 3; pageNumber++ {
			page, err := service.List(ctx, principal, pageNumber, 1, people.ListFilters{
				Search: token, Sort: sort, Descending: descending,
			})
			if err != nil {
				t.Fatal(err)
			}
			if page.Total != 3 || len(page.Items) != 1 {
				t.Fatalf("page %d has total/items %d/%d, want 3/1", pageNumber, page.Total, len(page.Items))
			}
			result = append(result, page.Items[0].ID)
		}
		return result
	}
	master := authorization.Principal{Master: true}
	for _, test := range []struct {
		sort       string
		descending bool
		want       []uuid.UUID
	}{
		{"", false, []uuid.UUID{adams, baker, clark}},
		{"name", true, []uuid.UUID{clark, baker, adams}},
		{"contact", false, []uuid.UUID{clark, baker, adams}},
		{"contact", true, []uuid.UUID{adams, baker, clark}},
		{"roles", false, []uuid.UUID{baker, clark, adams}},
		{"roles", true, []uuid.UUID{adams, clark, baker}},
		{"labRules", false, []uuid.UUID{adams, baker, clark}},
		{"labRules", true, []uuid.UUID{baker, clark, adams}},
	} {
		got := order(master, test.sort, test.descending)
		if fmt.Sprint(got) != fmt.Sprint(test.want) {
			t.Errorf("sort %q descending=%v gave %v, want %v", test.sort, test.descending, got, test.want)
		}
	}

	if _, err := service.List(ctx, master, 1, 25, people.ListFilters{Sort: "matriculation"}); err == nil {
		t.Fatal("unknown sort columns must be rejected")
	}
	// The reader's own person must not match the search token.
	reader, _ := principalWithPermissions(t, pool, "people-sort-reader-"+ids.New().String()[24:], "people.read.all")
	if got := order(reader, "roles", false); fmt.Sprint(got) != fmt.Sprint([]uuid.UUID{baker, clark, adams}) {
		t.Errorf("roles sort without Lab Rules permission gave %v", got)
	}
	if _, err := service.List(ctx, reader, 1, 25, people.ListFilters{Sort: "labRules"}); !errors.Is(
		err, apperror.PermissionDenied,
	) {
		t.Fatalf("sorting by Lab Rules status without its permission returned %v, want permission denied", err)
	}
}
