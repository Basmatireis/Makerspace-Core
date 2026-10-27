package printerconnectors

import (
	"context"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	authorizationdb "github.com/Basmatireis/Makerspace-Core/backend/internal/authorization/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

type permissionsStub struct {
	rows []authorizationdb.GetPrincipalRolePermissionsRow
}

func (permissionsStub) ListMasterReauthenticationPermissions(
	context.Context,
) ([]authorizationdb.ListMasterReauthenticationPermissionsRow, error) {
	return nil, nil
}

func (s permissionsStub) GetPrincipalRolePermissions(
	context.Context,
	uuid.UUID,
) ([]authorizationdb.GetPrincipalRolePermissionsRow, error) {
	return s.rows, nil
}

func principalWith(t *testing.T, accountID uuid.UUID, permissions ...authorization.Permission) authorization.Principal {
	t.Helper()
	rows := make([]authorizationdb.GetPrincipalRolePermissionsRow, 0, len(permissions))
	for _, permission := range permissions {
		permissionID, scope, minimum := string(
			permission,
		), string(
			authorization.GrantEverywhere,
		), string(
			authorization.AssuranceLow,
		)
		grantID := ids.New()
		rows = append(
			rows,
			authorizationdb.GetPrincipalRolePermissionsRow{
				RoleID:           ids.New(),
				GrantID:          &grantID,
				PermissionID:     &permissionID,
				Scope:            &scope,
				MinimumAssurance: &minimum,
			},
		)
	}
	principal, err := authorization.LoadPermissions(
		t.Context(),
		permissionsStub{rows: rows},
		authorization.Principal{AccountID: accountID},
	)
	if err != nil {
		t.Fatal(err)
	}
	return principal
}

func count(t *testing.T, h *ingestHarness, query string, args ...any) int {
	t.Helper()
	var n int
	if err := h.pool.QueryRow(t.Context(), query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestDeleteRequiresManagePermission(t *testing.T) {
	h := newIngestHarness(t)
	current, err := h.service.Get(t.Context(), h.principal, h.connector.ID)
	if err != nil {
		t.Fatal(err)
	}
	for name, principal := range map[string]authorization.Principal{
		"no permissions": principalWith(t, h.principal.AccountID),
		"read only":      principalWith(t, h.principal.AccountID, authorization.PrinterConnectorsRead),
		"credentials":    principalWith(t, h.principal.AccountID, authorization.PrinterConnectorsCredentialsManage),
	} {
		if err = h.service.Delete(t.Context(), principal, current.ID, current.Version, nil); !apperror.IsCode(
			err,
			"permission_denied",
		) {
			t.Fatalf("%s: expected permission_denied, got %v", name, err)
		}
	}
	allowed := principalWith(t, h.principal.AccountID, authorization.PrinterConnectorsManage)
	if err = h.service.Delete(t.Context(), allowed, current.ID, current.Version, nil); err != nil {
		t.Fatalf("manage permission may delete: %v", err)
	}
}

func TestDeleteConnectorKeepsBusinessRecords(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	runID := ids.New()
	runningID := ids.New()
	t0 := time.Now().UTC().Truncate(time.Second).Add(-2 * time.Hour)
	h.accepted(runID, "operational_state", t0, `{"state":"printing","fileName":"part.gcode"}`)
	h.accepted(runID, "terminal_outcome", t0.Add(10*time.Minute), `{"outcome":"completed"}`)
	h.accepted(runningID, "operational_state", t0.Add(time.Hour), `{"state":"printing"}`)
	if _, err := h.pool.Exec(ctx, `INSERT INTO printer_error_occurrences (id, machine_id, assignment_id, run_id, source_family, original_code, first_observed_at, last_observed_at)
		VALUES ($1, $2, $3, $4, 'hms', '0300_0001', now(), now())`, ids.New(), h.machine.ID, h.assignment.ID, runningID); err != nil {
		t.Fatal(err)
	}
	// A diagnostic event no run rests on.
	if _, err := h.pool.Exec(ctx, `INSERT INTO printer_events (id, source_id, event_key, fingerprint, protocol_version, machine_id, kind, occurred_at, source_sequence, payload, connector_id, connector_assignment_id, configuration_version)
		VALUES ($1, $2, $3, repeat('a', 64), 1, $4, 'connectivity', now(), 9999, '{}', $5, $6, 1)`,
		ids.New(),
		"diag-"+h.suffix,
		"diag-"+h.suffix,
		h.machine.ID,
		h.connector.ID,
		h.assignment.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(
		ctx,
		`INSERT INTO printer_live_statuses (assignment_id, machine_id, observed_at, configuration_version, snapshot) VALUES ($1, $2, now(), 1, '{}')`,
		h.assignment.ID,
		h.machine.ID,
	); err != nil {
		t.Fatal(err)
	}
	if n := count(
		t,
		h,
		`SELECT count(*) FROM printer_error_occurrences WHERE assignment_id = $1 AND resolved_at IS NULL`,
		h.assignment.ID,
	); n != 1 {
		t.Fatalf("expected an open error, got %d", n)
	}
	eventsOfRuns := count(
		t,
		h,
		`SELECT count(*) FROM printer_events WHERE connector_id = $1 AND run_id IS NOT NULL`,
		h.connector.ID,
	)

	current, err := h.service.Get(ctx, h.principal, h.connector.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = h.service.Delete(ctx, h.principal, h.connector.ID, current.Version+1, nil); !apperror.IsCode(
		err,
		"stale_write",
	) {
		t.Fatalf("stale version: %v", err)
	}
	if err = h.service.Delete(ctx, h.principal, h.connector.ID, current.Version, &h.assignment.ID); err != nil {
		t.Fatal(err)
	}

	if authenticated, authErr := h.service.Authenticate(ctx, h.secret); authErr != nil || authenticated != nil {
		t.Fatalf("deleted connector credential authenticated=%+v err=%v", authenticated, authErr)
	}
	if _, err = h.service.Get(ctx, h.principal, h.connector.ID); !apperror.IsCode(err, "not_found") {
		t.Fatalf("connector still readable: %v", err)
	}
	if err = h.service.Delete(ctx, h.principal, h.connector.ID, current.Version, nil); !apperror.IsCode(
		err,
		"not_found",
	) {
		t.Fatalf("second delete: %v", err)
	}
	for table, query := range map[string]string{
		"assignments": `SELECT count(*) FROM printer_connector_assignments WHERE id = $1`,
		"live status": `SELECT count(*) FROM printer_live_statuses WHERE assignment_id = $1`,
	} {
		if n := count(t, h, query, h.assignment.ID); n != 0 {
			t.Fatalf("%s survived: %d", table, n)
		}
	}
	if n := count(
		t,
		h,
		`SELECT count(*) FROM printer_connector_credentials WHERE connector_id = $1`,
		h.connector.ID,
	); n != 0 {
		t.Fatalf("credentials survived: %d", n)
	}
	// Business records survive without the connector reference.
	if n := count(
		t,
		h,
		`SELECT count(*) FROM machine_runs WHERE id = ANY($1) AND assignment_id IS NULL AND source = 'recorded'`,
		[]uuid.UUID{runID, runningID},
	); n != 2 {
		t.Fatalf("recorded runs after delete: %d", n)
	}
	if finished := h.run(runID); finished.state != "finished" {
		t.Fatalf("finished run changed: %+v", finished)
	}
	if running := h.run(runningID); running.state != "unknown" {
		t.Fatalf("running run must be settled, got %+v", running)
	}
	if n := count(
		t,
		h,
		`SELECT count(*) FROM printer_error_occurrences WHERE machine_id = $1 AND assignment_id IS NULL AND resolved_at IS NOT NULL`,
		h.machine.ID,
	); n != 1 {
		t.Fatalf("error history after delete: %d", n)
	}
	if n := count(
		t,
		h,
		`SELECT count(*) FROM printer_events WHERE machine_id = $1 AND connector_id IS NULL AND connector_assignment_id IS NULL AND run_id IS NOT NULL`,
		h.machine.ID,
	); n != eventsOfRuns {
		t.Fatalf("run events after delete = %d, want %d", n, eventsOfRuns)
	}
	if n := count(t, h, `SELECT count(*) FROM printer_events WHERE source_id = $1`, "diag-"+h.suffix); n != 0 {
		t.Fatalf("diagnostic event survived: %d", n)
	}
	if n := count(
		t,
		h,
		`SELECT count(*) FROM audit_events WHERE action = 'printer_connector.deleted' AND resource_id = $1 AND actor_account_id = $2`,
		h.connector.ID,
		h.principal.AccountID,
	); n != 1 {
		t.Fatalf("audit rows: %d", n)
	}
	// The machine can be given to another connector.
	other, err := h.service.Create(ctx, h.principal, "Replacement "+h.suffix, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.service.CreateAssignment(
		ctx,
		h.principal,
		other.ID,
		AssignmentInput{
			MachineID:            h.machine.ID,
			AdapterKind:          "simulator",
			AdapterSchemaVersion: 1,
			Settings:             []byte(`{"scenario":"idle"}`),
			Enabled:              true,
		},
		nil,
	); err != nil {
		t.Fatalf("reassign machine: %v", err)
	}
}

func TestDeleteRevokedConnector(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	current, err := h.service.Get(ctx, h.principal, h.connector.ID)
	if err != nil {
		t.Fatal(err)
	}
	revoked, err := h.service.Revoke(ctx, h.principal, h.connector.ID, current.Version, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = h.service.Delete(ctx, h.principal, h.connector.ID, revoked.Version, nil); err != nil {
		t.Fatal(err)
	}
	if n := count(t, h, `SELECT count(*) FROM printer_connectors WHERE id = $1`, h.connector.ID); n != 0 {
		t.Fatalf("connector survived: %d", n)
	}
}
