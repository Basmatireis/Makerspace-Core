package integration_test

import (
	"errors"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/google/uuid"
)

func TestLabRulesConfirmationListFiltersSortsPagesAndRequiresPermission(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	accountID, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Mia", LastName: "Master", LoginEmail: "confirmations-master@example.test", Password: bootstrapPassword,
	})
	if err != nil {
		t.Fatal(err)
	}
	var masterPersonID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT person_id FROM accounts WHERE id=$1`, accountID).Scan(&masterPersonID); err != nil {
		t.Fatal(err)
	}
	versionOld := insertPublishedLabRulesVersionAt(t, pool, accountID, "2025.1", time.Now().Add(-time.Hour))
	versionNew := insertPublishedLabRulesVersion(t, pool, accountID, "2026.1")

	addPerson := func(first, last string) uuid.UUID {
		personID := ids.New()
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO people(id,first_name,last_name,email) VALUES($1,$2,$3,$4)`,
			personID, first, last, first+"."+last+"@example.test",
		); err != nil {
			t.Fatal(err)
		}
		return personID
	}
	addPaper := func(personID, version uuid.UUID, reference string, confirmedAt time.Time) {
		if _, err := pool.Exec(ctx, `
			INSERT INTO laborordnung_confirmations
			  (id,person_id,version_id,method,confirmed_at,confirmed_by_account_id,physical_document_reference,signed_date)
			VALUES ($1,$2,$3,'paper',$4,$5,$6,'2026-03-01')`,
			ids.New(), personID, version, confirmedAt, accountID, reference,
		); err != nil {
			t.Fatal(err)
		}
	}
	base := time.Now().UTC().Add(-time.Hour)
	ada := addPerson("Ada", "Zed")
	addPaper(ada, versionOld, "folder-A-1", base)
	addPaper(addPerson("Bob", "Yarn"), versionNew, "folder-B-2", base.Add(time.Minute))
	cy := addPerson("Cy", "Xu")
	if _, err := pool.Exec(ctx, `
		INSERT INTO laborordnung_confirmations (id,person_id,version_id,method,confirmed_at) VALUES ($1,$2,$3,'app',$4)`,
		ids.New(), cy, versionNew, base.Add(2*time.Minute),
	); err != nil {
		t.Fatal(err)
	}
	// Self-confirmations never carry paper evidence.
	if _, err := pool.Exec(ctx, `
		INSERT INTO laborordnung_confirmations (id,person_id,version_id,method,confirmed_at,physical_document_reference)
		VALUES ($1,$2,$3,'kiosk',now(),'folder-X')`, ids.New(), ada, versionNew,
	); err == nil {
		t.Fatal("a kiosk confirmation with a document reference must be rejected")
	}

	service := laborordnung.NewService(pool, inbox.NewEmitter(), nil)
	reader := authorization.Principal{
		AccountID: accountID, PersonID: masterPersonID, Assurance: authorization.AssuranceNormal,
		AuthenticatedAt: time.Now().UTC(), Master: true,
	}
	filters := func(mutate func(*laborordnung.ConfirmationFilters)) laborordnung.ConfirmationFilters {
		value := laborordnung.ConfirmationFilters{
			Sort: laborordnung.ConfirmationSortConfirmedAt, Descending: true, Page: 1, PageSize: 25,
		}
		if mutate != nil {
			mutate(&value)
		}
		return value
	}

	items, total, err := service.ListConfirmations(ctx, reader, filters(nil))
	if err != nil || total != 3 || len(items) != 3 {
		t.Fatalf("all confirmations: total=%d len=%d err=%v", total, len(items), err)
	}
	if items[0].PersonName != "Cy Xu" || items[0].Method != laborordnung.MethodApp || items[0].ConfirmedByName != nil ||
		items[0].PhysicalDocumentReference != nil || items[0].HumanRevision != "2026.1" {
		t.Fatalf("newest confirmation first: %#v", items[0])
	}
	if items[1].Method != laborordnung.MethodPaper || items[1].ConfirmedByName == nil ||
		*items[1].ConfirmedByName != "Mia Master" || items[1].SignedDate == nil || items[1].PhysicalDocumentReference == nil {
		t.Fatalf("paper confirmation with its evidence: %#v", items[1])
	}

	items, total, err = service.ListConfirmations(ctx, reader, filters(func(f *laborordnung.ConfirmationFilters) {
		f.Sort, f.Descending = laborordnung.ConfirmationSortPerson, false
	}))
	if err != nil || total != 3 || items[0].PersonName != "Cy Xu" || items[2].PersonName != "Ada Zed" {
		t.Fatalf("sorted by last name ascending: %#v err=%v", items, err)
	}
	items, total, err = service.ListConfirmations(ctx, reader, filters(func(f *laborordnung.ConfirmationFilters) {
		f.VersionID = &versionNew
	}))
	if err != nil || total != 2 || len(items) != 2 {
		t.Fatalf("version filter: total=%d err=%v", total, err)
	}
	paper := laborordnung.MethodPaper
	_, total, err = service.ListConfirmations(ctx, reader, filters(func(f *laborordnung.ConfirmationFilters) {
		f.Method = &paper
	}))
	if err != nil || total != 2 {
		t.Fatalf("method filter: total=%d err=%v", total, err)
	}
	items, total, err = service.ListConfirmations(ctx, reader, filters(func(f *laborordnung.ConfirmationFilters) {
		f.Search = "FOLDER-b"
	}))
	if err != nil || total != 1 || items[0].PersonName != "Bob Yarn" {
		t.Fatalf("reference search: %#v err=%v", items, err)
	}
	items, total, err = service.ListConfirmations(ctx, reader, filters(func(f *laborordnung.ConfirmationFilters) {
		f.Search = "ada"
	}))
	if err != nil || total != 1 || items[0].PersonID != ada {
		t.Fatalf("name search: %#v err=%v", items, err)
	}
	_, total, err = service.ListConfirmations(ctx, reader, filters(func(f *laborordnung.ConfirmationFilters) {
		f.PersonID = &ada
	}))
	if err != nil || total != 1 {
		t.Fatalf("person filter: total=%d err=%v", total, err)
	}
	items, total, err = service.ListConfirmations(ctx, reader, filters(func(f *laborordnung.ConfirmationFilters) {
		f.PageSize, f.Page = 2, 2
	}))
	if err != nil || total != 3 || len(items) != 1 {
		t.Fatalf("second page: total=%d len=%d err=%v", total, len(items), err)
	}
	if _, _, err := service.ListConfirmations(ctx, reader, filters(func(f *laborordnung.ConfirmationFilters) {
		f.PageSize = 101
	})); err == nil {
		t.Fatal("oversized page must be rejected")
	}

	// A principal without the permission (not master, no grants) is refused.
	denied := reader
	denied.Master = false
	if _, _, err := service.ListConfirmations(ctx, denied, filters(nil)); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("listing without laborordnung.confirmations.read must be denied, got %v", err)
	}

	// With only people.read.self the list holds the caller's own confirmations; asking for anyone else is denied,
	// and without any person read permission nothing is listed.
	grant := func(permissions ...authorization.Permission) authorization.Principal {
		t.Helper()
		grants := make([]authorization.PermissionGrant, 0, len(permissions))
		for _, permission := range permissions {
			grants = append(grants, authorization.PermissionGrant{PermissionID: permission, Scope: authorization.GrantEverywhere})
		}
		role, err := roles.NewService(pool).CreateWithBehaviors(
			ctx, reader, "Readers "+ids.New().String()[24:], nil, grants, false, laborordnung.ModeNotRequired, nil,
		)
		if err != nil {
			t.Fatal(err)
		}
		account := seedAccount(t, pool, "reader-"+ids.New().String()[24:], false)
		// The reader takes over Cy's confirmation, so it has one of its own.
		if _, err := pool.Exec(ctx, `UPDATE laborordnung_confirmations SET person_id=$1 WHERE person_id=$2`,
			account.personID, cy); err != nil {
			t.Fatal(err)
		}
		cy = account.personID
		if _, err := pool.Exec(ctx, `INSERT INTO person_roles(person_id,role_id) VALUES($1,$2)`, account.personID, role.ID); err != nil {
			t.Fatal(err)
		}
		principal, err := authorization.LoadPermissionsFrom(
			ctx, pool, authorization.Principal{AccountID: account.accountID, PersonID: account.personID},
		)
		if err != nil {
			t.Fatal(err)
		}
		return principal
	}
	self := grant(authorization.LaborordnungConfirmationsRead, authorization.PeopleReadSelf)
	items, total, err = service.ListConfirmations(ctx, self, filters(nil))
	if err != nil || total != 1 || items[0].PersonID != self.PersonID {
		t.Fatalf("self-scoped list: %#v total=%d err=%v", items, total, err)
	}
	if _, _, err := service.ListConfirmations(ctx, self, filters(func(f *laborordnung.ConfirmationFilters) {
		f.PersonID = &ada
	})); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("self-scoped reader asking for another person: %v", err)
	}
	noPeople := grant(authorization.LaborordnungConfirmationsRead)
	if _, _, err := service.ListConfirmations(ctx, noPeople, filters(nil)); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("reader without person read permission: %v", err)
	}
	all := grant(authorization.LaborordnungConfirmationsRead, authorization.PeopleReadAll)
	if _, total, err = service.ListConfirmations(ctx, all, filters(nil)); err != nil || total != 3 {
		t.Fatalf("reader with people.read.all: total=%d err=%v", total, err)
	}
}
