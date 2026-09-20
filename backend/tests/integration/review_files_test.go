package integration_test

import (
	"errors"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
)

func TestPersonHardDeletionRemovesPrivateProfileImage(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	account := seedAccount(t, pool, "delete-profile-image", false)
	actor := authorization.Principal{AccountID: account.accountID, PersonID: account.personID, Master: true}
	store, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fileService := files.NewService(pool, store)
	image, err := fileService.StoreBytes(ctx, actor, "profile.jpg", "image/jpeg", []byte("private-profile-fixture"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE people SET profile_image_file_id=$1, profile_image_source='self_upload' WHERE id=$2`, image.ID, account.personID); err != nil {
		t.Fatal(err)
	}
	service := people.NewService(pool, fileService)
	if err := service.Delete(ctx, authorization.Principal{AccountID: account.accountID, PersonID: account.personID}, account.personID, 1, nil); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("unauthorized deletion: %v", err)
	}
	assertCount(t, pool, `SELECT count(*) FROM files WHERE id=$1`, 1, image.ID)
	if err := service.Delete(ctx, actor, account.personID, 1, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM people WHERE id=$1`, 0, account.personID)
	assertCount(t, pool, `SELECT count(*) FROM files WHERE id=$1`, 0, image.ID)
	if _, err := store.Metadata(ctx, image.StorageKey); !errors.Is(err, storage.ErrNotFound) {
		t.Fatalf("profile blob remains after hard deletion: %v", err)
	}
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='person.deleted' AND resource_id=$1`, 1, account.personID)
}
