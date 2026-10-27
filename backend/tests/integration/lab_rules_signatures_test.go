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
	"github.com/google/uuid"
)

func TestLabRulesSignatureListFiltersSortsPagesAndRequiresPermission(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	accountID, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Mia", LastName: "Master", LoginEmail: "signatures-master@example.test", Password: bootstrapPassword,
	})
	if err != nil {
		t.Fatal(err)
	}
	var masterPersonID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT person_id FROM accounts WHERE id=$1`, accountID).Scan(&masterPersonID); err != nil {
		t.Fatal(err)
	}
	versionOld := insertPublishedLabRulesVersion(t, pool, accountID, "2025.1")
	versionNew := insertPublishedLabRulesVersion(t, pool, accountID, "2026.1")

	addSignature := func(first, last string, version uuid.UUID, reference string, confirmedAt time.Time) uuid.UUID {
		personID := ids.New()
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO people(id,first_name,last_name,email) VALUES($1,$2,$3,$4)`,
			personID, first, last, first+"."+last+"@example.test",
		); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO laborordnung_requests
			  (id,person_id,required_version_id,status,requested_at,completed_at,confirmed_by_account_id,
			   physical_document_reference,signed_date)
			VALUES ($1,$2,$3,'completed',$4,$4,$5,$6,'2026-03-01')`,
			ids.New(), personID, version, confirmedAt, accountID, reference,
		); err != nil {
			t.Fatal(err)
		}
		return personID
	}
	base := time.Now().UTC().Add(-time.Hour)
	ada := addSignature("Ada", "Zed", versionOld, "folder-A-1", base)
	addSignature("Bob", "Yarn", versionNew, "folder-B-2", base.Add(time.Minute))
	addSignature("Cy", "Xu", versionNew, "folder-C-3", base.Add(2*time.Minute))
	// A pending request is not a signature.
	pendingPerson := ids.New()
	if _, err := pool.Exec(
		ctx, `INSERT INTO people(id,first_name,last_name,email) VALUES($1,'Pen','Ding','pending@example.test')`, pendingPerson,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx, `INSERT INTO laborordnung_requests (id,person_id,required_version_id) VALUES ($1,$2,$3)`,
		ids.New(), pendingPerson, versionNew,
	); err != nil {
		t.Fatal(err)
	}

	service := laborordnung.NewService(pool, inbox.NewEmitter(), nil)
	reader := authorization.Principal{
		AccountID: accountID, PersonID: masterPersonID, Assurance: authorization.AssuranceNormal,
		AuthenticatedAt: time.Now().UTC(), Master: true,
	}
	filters := func(mutate func(*laborordnung.SignatureFilters)) laborordnung.SignatureFilters {
		value := laborordnung.SignatureFilters{
			Sort: laborordnung.SignatureSortConfirmedAt, Descending: true, Page: 1, PageSize: 25,
		}
		if mutate != nil {
			mutate(&value)
		}
		return value
	}

	items, total, err := service.ListSignatures(ctx, reader, filters(nil))
	if err != nil || total != 3 || len(items) != 3 {
		t.Fatalf("all signatures: total=%d len=%d err=%v", total, len(items), err)
	}
	if items[0].PersonName != "Cy Xu" || items[0].ConfirmedByName == nil || *items[0].ConfirmedByName != "Mia Master" ||
		items[0].SignedDate == nil || items[0].PhysicalDocumentReference == nil || items[0].HumanRevision != "2026.1" {
		t.Fatalf("newest signature first with full fields: %#v", items[0])
	}

	items, total, err = service.ListSignatures(ctx, reader, filters(func(f *laborordnung.SignatureFilters) {
		f.Sort, f.Descending = laborordnung.SignatureSortPerson, false
	}))
	if err != nil || total != 3 || items[0].PersonName != "Cy Xu" || items[2].PersonName != "Ada Zed" {
		t.Fatalf("sorted by last name ascending: %#v err=%v", items, err)
	}

	items, total, err = service.ListSignatures(ctx, reader, filters(func(f *laborordnung.SignatureFilters) {
		f.VersionID = &versionNew
	}))
	if err != nil || total != 2 || len(items) != 2 {
		t.Fatalf("version filter: total=%d err=%v", total, err)
	}
	items, total, err = service.ListSignatures(ctx, reader, filters(func(f *laborordnung.SignatureFilters) {
		f.Search = "FOLDER-b"
	}))
	if err != nil || total != 1 || items[0].PersonName != "Bob Yarn" {
		t.Fatalf("reference search: %#v err=%v", items, err)
	}
	items, total, err = service.ListSignatures(ctx, reader, filters(func(f *laborordnung.SignatureFilters) {
		f.Search = "ada"
	}))
	if err != nil || total != 1 || items[0].PersonID != ada {
		t.Fatalf("name search: %#v err=%v", items, err)
	}
	items, total, err = service.ListSignatures(ctx, reader, filters(func(f *laborordnung.SignatureFilters) {
		f.PersonID = &ada
	}))
	if err != nil || total != 1 || len(items) != 1 {
		t.Fatalf("person filter: total=%d err=%v", total, err)
	}
	items, total, err = service.ListSignatures(ctx, reader, filters(func(f *laborordnung.SignatureFilters) {
		f.PageSize, f.Page = 2, 2
	}))
	if err != nil || total != 3 || len(items) != 1 {
		t.Fatalf("second page: total=%d len=%d err=%v", total, len(items), err)
	}
	if _, _, err := service.ListSignatures(ctx, reader, filters(func(f *laborordnung.SignatureFilters) {
		f.PageSize = 101
	})); err == nil {
		t.Fatal("oversized page must be rejected")
	}

	// A principal without the permission (not master, no grants) is refused.
	denied := reader
	denied.Master = false
	if _, _, err := service.ListSignatures(ctx, denied, filters(nil)); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("listing without laborordnung.requests.read must be denied, got %v", err)
	}
}
