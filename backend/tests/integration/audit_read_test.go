package integration_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

func TestAuditReadAuthorizationFiltersPaginationAndCurrentLabels(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	reader := seedAccount(t, pool, "audit-reader", false)
	actor := seedAccount(t, pool, "audit-actor", false)
	if _, err := pool.Exec(ctx, `UPDATE people SET phone='+43 000 private', matriculation_number='private-matriculation' WHERE id=$1`, actor.personID); err != nil {
		t.Fatal(err)
	}
	roleID := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO roles (id, name) VALUES ($1, 'Workshop supervisor')`, roleID); err != nil {
		t.Fatal(err)
	}
	readerRoleID := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO roles (id, name) VALUES ($1, 'Audit reader')`, readerRoleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO role_permission_grants (id, role_id, permission_id) VALUES (uuidv7(), $1, 'audit.read')`, readerRoleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO account_roles (account_id, role_id) VALUES ($1, $2)`, reader.accountID, readerRoleID); err != nil {
		t.Fatal(err)
	}
	principal, err := authorization.LoadPermissionsFrom(ctx, pool, authorization.Principal{AccountID: reader.accountID})
	if err != nil {
		t.Fatal(err)
	}
	service := audit.NewService(pool)
	if _, err := service.List(ctx, authorization.Principal{}, audit.Filter{Limit: 25}); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("unauthorized list error = %v", err)
	}

	requestID := uuid.Must(uuid.NewV7())
	if err := audit.Write(ctx, pool, audit.Event{
		ActorAccountID: &actor.accountID,
		Action:         "account.role_assigned",
		ResourceType:   "person",
		ResourceID:     &actor.personID,
		RequestID:      &requestID,
		Metadata:       map[string]any{"roleId": roleID.String()},
	}); err != nil {
		t.Fatal(err)
	}
	if err := audit.Write(ctx, pool, audit.Event{Action: "role.updated", ResourceType: "role", ResourceID: &roleID, Source: "system"}); err != nil {
		t.Fatal(err)
	}

	page, err := service.List(ctx, principal, audit.Filter{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.NextCursor == nil {
		t.Fatalf("first page = %#v", page)
	}
	second, err := service.List(ctx, principal, audit.Filter{Limit: 1, Cursor: *page.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Items) != 1 || second.Items[0].ID == page.Items[0].ID {
		t.Fatalf("second page = %#v", second)
	}

	actorType := "user"
	action := "account.role_assigned"
	filtered, err := service.List(ctx, principal, audit.Filter{Limit: 25, ActorType: &actorType, ActorSearch: "test person", Action: &action})
	if err != nil {
		t.Fatal(err)
	}
	if len(filtered.Items) != 1 {
		t.Fatalf("filtered items = %#v", filtered.Items)
	}
	event := filtered.Items[0]
	if event.ActorType != "user" || event.ActorDisplayName == nil || *event.ActorDisplayName != "Test Person" ||
		event.ResourceDisplayName == nil || *event.ResourceDisplayName != "Test Person" || event.ResolvedMetadata["roleId"] != "Workshop supervisor" {
		t.Fatalf("resolved event = %#v", event)
	}
	serialized, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"audit-actor@example.test", "+43 000 private", "private-matriculation"} {
		if strings.Contains(string(serialized), forbidden) {
			t.Fatalf("audit response exposed %q: %s", forbidden, serialized)
		}
	}

	resourceType := "role"
	systemType := "system"
	systemEvents, err := service.List(ctx, principal, audit.Filter{Limit: 25, ActorType: &systemType, ResourceType: &resourceType})
	if err != nil {
		t.Fatal(err)
	}
	if len(systemEvents.Items) != 1 || systemEvents.Items[0].ResourceDisplayName == nil || *systemEvents.Items[0].ResourceDisplayName != "Workshop supervisor" {
		t.Fatalf("system events = %#v", systemEvents.Items)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM roles WHERE id=$1`, roleID); err != nil {
		t.Fatal(err)
	}
	deleted, err := service.List(ctx, principal, audit.Filter{Limit: 25, ResourceType: &resourceType, ResourceID: &roleID})
	if err != nil {
		t.Fatal(err)
	}
	if len(deleted.Items) != 1 || deleted.Items[0].ResourceDisplayName != nil {
		t.Fatalf("deleted resource label = %#v", deleted.Items)
	}
}
