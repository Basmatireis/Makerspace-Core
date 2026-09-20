package integration_test

import (
	"bytes"
	"encoding/hex"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
)

func TestManagedDeviceTokenLifecycle(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	account := seedAccount(t, pool, "device-admin", true)
	principal := authorization.Principal{AccountID: account.accountID, PersonID: account.personID, Master: true}
	service := manageddevices.NewService(pool)
	typeRow, err := service.CreateType(ctx, principal, "Reception", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	loadedType, err := service.GetType(ctx, principal, typeRow.ID)
	if err != nil || loadedType.ID != typeRow.ID || loadedType.Name != typeRow.Name || loadedType.Version != typeRow.Version {
		t.Fatalf("get device type: got=%#v want=%#v err=%v", loadedType, typeRow, err)
	}
	issued, err := service.Create(ctx, principal, "Front desk", typeRow.ID, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if issued.Token == "" {
		t.Fatal("plaintext token missing from provisioning response")
	}
	var storedDigest []byte
	if err = pool.QueryRow(ctx, `SELECT token_digest FROM managed_devices WHERE id=$1`, issued.Device.ID).Scan(&storedDigest); err != nil {
		t.Fatal(err)
	}
	if len(storedDigest) != 32 || !bytes.Equal(storedDigest, security.DigestToken(issued.Token)) || bytes.Contains(storedDigest, []byte(issued.Token)) {
		t.Fatal("managed-device token was not stored exclusively as its SHA-256 digest")
	}
	device, err := service.Authenticate(ctx, issued.Token)
	if err != nil || device == nil || device.ID != issued.Device.ID {
		t.Fatalf("valid token result=%v err=%v", device, err)
	}
	if invalid, err := service.Authenticate(ctx, "not-a-token"); err != nil || invalid != nil {
		t.Fatalf("invalid token result=%v err=%v", invalid, err)
	}
	unknownToken, _, err := security.NewOpaqueToken()
	if err != nil {
		t.Fatal(err)
	}
	if invalid, err := service.Authenticate(ctx, unknownToken); err != nil || invalid != nil {
		t.Fatalf("unknown well-formed token result=%v err=%v", invalid, err)
	}
	rotated, err := service.Rotate(ctx, principal, issued.Device.ID, issued.Device.Version, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if old, err := service.Authenticate(ctx, issued.Token); err != nil || old != nil {
		t.Fatalf("old token remained valid: %v %v", old, err)
	}
	if current, err := service.Authenticate(ctx, rotated.Token); err != nil || current == nil {
		t.Fatalf("rotated token invalid: %v %v", current, err)
	}
	revoked, err := service.Revoke(ctx, principal, rotated.Device.ID, rotated.Device.Version, nil)
	if err != nil {
		t.Fatal(err)
	}
	if current, err := service.Authenticate(ctx, rotated.Token); err != nil || current != nil {
		t.Fatalf("revoked token authenticated: %v %v", current, err)
	}
	if err = service.Delete(ctx, principal, revoked.ID, revoked.Version, nil); err != nil {
		t.Fatal(err)
	}
	var auditRows string
	if err = pool.QueryRow(ctx, `SELECT coalesce(string_agg(row_to_json(a)::text, ''), '') FROM audit_events a WHERE resource_id = $1`, issued.Device.ID).Scan(&auditRows); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(auditRows, issued.Token) || strings.Contains(auditRows, rotated.Token) || strings.Contains(auditRows, hex.EncodeToString(security.DigestToken(issued.Token))) {
		t.Fatal("managed-device secret or digest leaked into audit data")
	}
	for _, action := range []string{"managed_device.created", "managed_device.token_rotated", "managed_device.revoked", "managed_device.deleted"} {
		if !strings.Contains(auditRows, action) {
			t.Fatalf("audit data did not contain %q: %s", action, auditRows)
		}
	}
}

func TestExpiredDeviceAndGlobalGrantMigration(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	typeID := uuid.Must(uuid.NewV7())
	deviceID := uuid.Must(uuid.NewV7())
	raw, digest, err := security.NewOpaqueToken()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO device_types(id,name) VALUES($1,'Workshop')`, typeID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO managed_devices(id,name,device_type_id,token_digest,expires_at) VALUES($1,'Expired terminal',$2,$3,now()-interval '1 minute')`, deviceID, typeID, digest); err != nil {
		t.Fatal(err)
	}
	device, err := manageddevices.NewService(pool).Authenticate(ctx, raw)
	if err != nil || device != nil {
		t.Fatalf("expired token result=%v err=%v", device, err)
	}
	roleID := uuid.Must(uuid.NewV7())
	if _, err = pool.Exec(ctx, `INSERT INTO roles(id,name) VALUES($1,'legacy'); INSERT INTO role_permission_grants(id,role_id,permission_id) VALUES(uuidv7(),$1,'people.read.all')`, roleID); err != nil {
		t.Fatal(err)
	}
	var scope string
	if err = pool.QueryRow(ctx, `SELECT scope FROM role_permission_grants WHERE role_id=$1`, roleID).Scan(&scope); err != nil || scope != "global" {
		t.Fatalf("legacy scope=%q err=%v", scope, err)
	}
}

func TestManagedDeviceMustBeRevokedBeforeDeletion(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	account := seedAccount(t, pool, "device-delete", true)
	p := authorization.Principal{AccountID: account.accountID, Master: true}
	s := manageddevices.NewService(pool)
	typ, err := s.CreateType(ctx, p, "Laser", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	issued, err := s.Create(ctx, p, "Laser terminal", typ.ID, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Delete(ctx, p, issued.Device.ID, issued.Device.Version, nil); !apperror.IsCode(err, "managed_device_not_revoked") {
		t.Fatalf("error=%v", err)
	}
}

func TestManagedDeviceStatusPrecedence(t *testing.T) {
	now := time.Now().UTC()
	past := now.Add(-time.Minute)
	if got := (manageddevices.Device{}).Status(now); got != manageddevices.StatusActive {
		t.Fatalf("active status = %q", got)
	}
	if got := (manageddevices.Device{ExpiresAt: &past}).Status(now); got != manageddevices.StatusExpired {
		t.Fatalf("expired status = %q", got)
	}
	if got := (manageddevices.Device{ExpiresAt: &past, RevokedAt: &past}).Status(now); got != manageddevices.StatusRevoked {
		t.Fatalf("revoked status precedence = %q", got)
	}
}

func TestManagedDeviceValidationConcurrencyAndLastSeenThrottle(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	account := seedAccount(t, pool, "device-validation", true)
	principal := authorization.Principal{AccountID: account.accountID, Master: true}
	service := manageddevices.NewService(pool)
	typeRow, err := service.CreateType(ctx, principal, "Admin workstation", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	past := time.Now().UTC().Add(-time.Minute)
	if _, err = service.Create(ctx, principal, "Invalid expiry", typeRow.ID, &past, nil); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("past expiration error = %v", err)
	}
	issued, err := service.Create(ctx, principal, "Office computer", typeRow.ID, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.Update(ctx, principal, issued.Device.ID, "Stale", typeRow.ID, nil, issued.Device.Version+1, nil); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale update error = %v", err)
	}
	if _, err = service.Create(ctx, principal, "office COMPUTER", typeRow.ID, nil, nil); !apperror.IsCode(err, "conflict") {
		t.Fatalf("case-insensitive duplicate error = %v", err)
	}
	if _, err = service.Authenticate(ctx, issued.Token); err != nil {
		t.Fatal(err)
	}
	var firstSeen time.Time
	if err = pool.QueryRow(ctx, `SELECT last_seen_at FROM managed_devices WHERE id=$1`, issued.Device.ID).Scan(&firstSeen); err != nil {
		t.Fatal(err)
	}
	if _, err = service.Authenticate(ctx, issued.Token); err != nil {
		t.Fatal(err)
	}
	var secondSeen time.Time
	if err = pool.QueryRow(ctx, `SELECT last_seen_at FROM managed_devices WHERE id=$1`, issued.Device.ID).Scan(&secondSeen); err != nil {
		t.Fatal(err)
	}
	if !secondSeen.Equal(firstSeen) {
		t.Fatalf("last_seen_at was not throttled: first=%s second=%s", firstSeen, secondSeen)
	}
	if _, err = pool.Exec(ctx, `UPDATE managed_devices SET last_seen_at=now()-interval '6 minutes' WHERE id=$1`, issued.Device.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = service.Authenticate(ctx, issued.Token); err != nil {
		t.Fatal(err)
	}
	var refreshed time.Time
	if err = pool.QueryRow(ctx, `SELECT last_seen_at FROM managed_devices WHERE id=$1`, issued.Device.ID).Scan(&refreshed); err != nil {
		t.Fatal(err)
	}
	if !refreshed.After(secondSeen) {
		t.Fatalf("last_seen_at was not refreshed: previous=%s refreshed=%s", secondSeen, refreshed)
	}
	if _, err = pool.Exec(ctx, `UPDATE managed_devices SET expires_at=now()-interval '1 minute' WHERE id=$1`, issued.Device.ID); err != nil {
		t.Fatal(err)
	}
	view, err := service.Get(ctx, principal, issued.Device.ID)
	if err != nil || view.ExpiresAt == nil {
		t.Fatalf("load expired device: %#v %v", view, err)
	}
	updated, err := service.Update(ctx, principal, view.ID, "Renamed expired computer", typeRow.ID, view.ExpiresAt, view.Version, nil)
	if err != nil || updated.Name != "Renamed expired computer" {
		t.Fatalf("edit expired metadata: %#v %v", updated, err)
	}
	if _, err = service.Update(ctx, principal, updated.ID, updated.Name, typeRow.ID, nil, updated.Version, nil); !apperror.IsCode(err, "managed_device_rotation_required") {
		t.Fatalf("expired token reactivated without rotation: %v", err)
	}
}
