package streaminggateways

import (
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/testdb"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func integrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	return testdb.Pool(t)
}

func TestCameraCandidatesRequireLocalServicesManage(t *testing.T) {
	service, err := NewService(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.ListCameraCandidates(t.Context(), authorization.Principal{}); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("expected permission_denied, got %v", err)
	}
}

func TestCameraCandidatesAndCredentialExpiry(t *testing.T) {
	pool := integrationPool(t)
	ctx := t.Context()
	service, err := NewService(pool, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Linux clocks have nanosecond resolution; PostgreSQL keeps microseconds.
	// Simulate that so the returned expiry must already match the stored one.
	service.now = func() time.Time { return time.Now().UTC().Truncate(time.Microsecond).Add(789 * time.Nanosecond) }
	logbook := machinelogbook.NewService(pool)
	printingService := printing.NewService(pool)
	connectors, err := printerconnectors.NewService(pool, printingService, nil)
	if err != nil {
		t.Fatal(err)
	}
	personID, accountID, requestID := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	suffix := strings.ReplaceAll(personID.String(), "-", "")[:12]
	master := authorization.Principal{AccountID: accountID, PersonID: personID, Master: true}
	if _, err = pool.Exec(ctx, `INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Gateway', 'Operator', $2)`, personID, "gateway-"+suffix+"@example.test"); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO accounts (id, person_id, status) VALUES ($1, $2, 'enabled')`, accountID, personID); err != nil {
		t.Fatal(err)
	}
	machineType, err := logbook.CreateMachineType(ctx, master, "Camera printer "+suffix, "fdm_printing", &requestID)
	if err != nil {
		t.Fatal(err)
	}
	newMachine := func(name string, profile bool, adapter string, connectorID uuid.UUID) uuid.UUID {
		machine, createErr := logbook.CreateMachine(ctx, master, machineType.ID, name+" "+suffix, "active", nil, false, &requestID)
		if createErr != nil {
			t.Fatal(createErr)
		}
		if profile {
			if _, createErr = printingService.ConfigureProfile(ctx, master, machine.ID, true, 0, &requestID); createErr != nil {
				t.Fatal(createErr)
			}
			if _, createErr = pool.Exec(ctx, `INSERT INTO printer_connector_assignments (id, connector_id, machine_id, adapter_kind) VALUES ($1, $2, $3, $4)`, uuid.Must(uuid.NewV7()), connectorID, machine.ID, adapter); createErr != nil {
				t.Fatal(createErr)
			}
		}
		return machine.ID
	}
	connector, err := connectors.Create(ctx, master, "Camera connector "+suffix, nil, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	free := newMachine("Bambu free", true, "bambu_x1c", connector.ID)
	withCamera := newMachine("Bambu with camera", true, "bambu_h2d", connector.ID)
	newMachine("Simulated", true, "simulator", connector.ID)
	newMachine("Plain", false, "", uuid.Nil)

	gateway, err := service.Create(ctx, master, "Camera gateway "+suffix, "gw-"+suffix+".example.test", &requestID)
	if err != nil {
		t.Fatal(err)
	}
	if gateway.CredentialExpiresAt != nil {
		t.Fatalf("a new gateway has no credential, got %v", gateway.CredentialExpiresAt)
	}
	issue, err := service.IssueEnrollment(ctx, master, gateway.ID, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	credentialSecret, _, err := security.NewOpaqueToken()
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Enroll(ctx, issue.Secret, uuid.Must(uuid.NewV7()), credentialSecret, "test", ProtocolVersion)
	if err != nil {
		t.Fatal(err)
	}
	if result.Gateway.CredentialExpiresAt == nil || !result.Gateway.CredentialExpiresAt.Equal(result.CredentialExpiresAt) {
		t.Fatalf("enrollment gateway expiry = %v, want %v", result.Gateway.CredentialExpiresAt, result.CredentialExpiresAt)
	}
	if left := time.Until(result.CredentialExpiresAt); left < 89*24*time.Hour || left > 91*24*time.Hour {
		t.Fatalf("credential lifetime = %v", left)
	}
	got, err := service.Get(ctx, master, gateway.ID)
	if err != nil || got.CredentialExpiresAt == nil || !got.CredentialExpiresAt.Equal(result.CredentialExpiresAt) {
		t.Fatalf("Get expiry = %+v err=%v", got.CredentialExpiresAt, err)
	}
	listed, err := service.List(ctx, master)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range listed {
		if item.ID == gateway.ID {
			found = item.CredentialExpiresAt != nil && item.CredentialExpiresAt.Equal(result.CredentialExpiresAt)
		}
	}
	if !found {
		t.Fatal("List does not report the credential expiry")
	}

	if _, err = service.AssignCamera(ctx, master, gateway.ID, withCamera, true, &requestID); err != nil {
		t.Fatal(err)
	}
	candidates, err := service.ListCameraCandidates(ctx, master)
	if err != nil {
		t.Fatal(err)
	}
	ids := map[uuid.UUID]CameraCandidate{}
	for _, candidate := range candidates {
		ids[candidate.ID] = candidate
	}
	if _, ok := ids[free]; !ok {
		t.Fatalf("machine with an active Bambu assignment and no camera is missing: %+v", candidates)
	}
	if ids[free].Kind != machineType.Name {
		t.Fatalf("kind = %q, want %q", ids[free].Kind, machineType.Name)
	}
	if _, ok := ids[withCamera]; ok {
		t.Fatal("a machine that already has a camera must not be offered")
	}
	for _, candidate := range candidates {
		if strings.Contains(candidate.Name, "Simulated "+suffix) || strings.Contains(candidate.Name, "Plain "+suffix) {
			t.Fatalf("non-Bambu machine offered: %+v", candidate)
		}
	}
	if _, err = service.ListCameraCandidates(ctx, authorization.Principal{AccountID: accountID, PersonID: personID}); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("expected permission_denied without local_services.manage, got %v", err)
	}
}

func TestDeleteGatewayInAnyLifecycle(t *testing.T) {
	pool := integrationPool(t)
	ctx := t.Context()
	service, err := NewService(pool, nil)
	if err != nil {
		t.Fatal(err)
	}
	logbook := machinelogbook.NewService(pool)
	printingService := printing.NewService(pool)
	connectors, err := printerconnectors.NewService(pool, printingService, nil)
	if err != nil {
		t.Fatal(err)
	}
	personID, accountID, requestID := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	suffix := strings.ReplaceAll(personID.String(), "-", "")[:12]
	master := authorization.Principal{AccountID: accountID, PersonID: personID, Master: true}
	if _, err = pool.Exec(ctx, `INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Gateway', 'Deleter', $2)`, personID, "gwdel-"+suffix+"@example.test"); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO accounts (id, person_id, status) VALUES ($1, $2, 'enabled')`, accountID, personID); err != nil {
		t.Fatal(err)
	}
	machineType, err := logbook.CreateMachineType(ctx, master, "Delete printer "+suffix, "fdm_printing", &requestID)
	if err != nil {
		t.Fatal(err)
	}
	connector, err := connectors.Create(ctx, master, "Delete connector "+suffix, nil, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	newGateway := func(name string) (Gateway, string, uuid.UUID) {
		gateway, createErr := service.Create(ctx, master, name+" "+suffix, strings.ToLower(name)+"-"+suffix+".example.test", &requestID)
		if createErr != nil {
			t.Fatal(createErr)
		}
		issue, createErr := service.IssueEnrollment(ctx, master, gateway.ID, &requestID)
		if createErr != nil {
			t.Fatal(createErr)
		}
		secret, _, createErr := security.NewOpaqueToken()
		if createErr != nil {
			t.Fatal(createErr)
		}
		if _, createErr = service.Enroll(ctx, issue.Secret, uuid.Must(uuid.NewV7()), secret, "test", ProtocolVersion); createErr != nil {
			t.Fatal(createErr)
		}
		machine, createErr := logbook.CreateMachine(ctx, master, machineType.ID, name+" printer "+suffix, "active", nil, false, &requestID)
		if createErr != nil {
			t.Fatal(createErr)
		}
		if _, createErr = printingService.ConfigureProfile(ctx, master, machine.ID, true, 0, &requestID); createErr != nil {
			t.Fatal(createErr)
		}
		if _, createErr = pool.Exec(ctx, `INSERT INTO printer_connector_assignments (id, connector_id, machine_id, adapter_kind) VALUES ($1, $2, $3, 'bambu_x1c')`, uuid.Must(uuid.NewV7()), connector.ID, machine.ID); createErr != nil {
			t.Fatal(createErr)
		}
		if _, createErr = service.AssignCamera(ctx, master, gateway.ID, machine.ID, true, &requestID); createErr != nil {
			t.Fatal(createErr)
		}
		current, createErr := service.Get(ctx, master, gateway.ID)
		if createErr != nil {
			t.Fatal(createErr)
		}
		return current, secret, machine.ID
	}
	rowCount := func(query string, args ...any) int {
		var n int
		if err := pool.QueryRow(ctx, query, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	denied := func(g Gateway) {
		for _, principal := range []authorization.Principal{{AccountID: accountID, PersonID: personID}, {}} {
			if err := service.Delete(ctx, principal, g.ID, g.Version, nil); !apperror.IsCode(err, "permission_denied") {
				t.Fatalf("expected permission_denied, got %v", err)
			}
		}
	}

	active, activeSecret, activeMachine := newGateway("Active")
	if active.Lifecycle != "active" {
		t.Fatalf("lifecycle = %s", active.Lifecycle)
	}
	denied(active)
	if err = service.Delete(ctx, master, active.ID, active.Version+1, nil); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale version: %v", err)
	}
	if err = service.Delete(ctx, master, active.ID, active.Version, &requestID); err != nil {
		t.Fatal(err)
	}
	if gotContext, authErr := service.Authenticate(ctx, activeSecret); authErr != nil || gotContext != nil {
		t.Fatalf("deleted gateway credential authenticated: %+v %v", gotContext, authErr)
	}
	if n := rowCount(`SELECT (SELECT count(*) FROM streaming_gateways WHERE id = $1) + (SELECT count(*) FROM streaming_cameras WHERE gateway_id = $1) + (SELECT count(*) FROM streaming_gateway_credentials WHERE gateway_id = $1) + (SELECT count(*) FROM streaming_gateway_enrollments WHERE gateway_id = $1)`, active.ID); n != 0 {
		t.Fatalf("gateway data survived: %d", n)
	}
	if n := rowCount(`SELECT count(*) FROM machines WHERE id = $1`, activeMachine); n != 1 {
		t.Fatal("the machine must survive")
	}
	if n := rowCount(`SELECT count(*) FROM audit_events WHERE action = 'streaming_gateway.deleted' AND resource_id = $1`, active.ID); n != 1 {
		t.Fatalf("audit rows = %d", n)
	}
	if err = service.Delete(ctx, master, active.ID, active.Version, nil); !apperror.IsCode(err, "not_found") {
		t.Fatalf("second delete: %v", err)
	}

	revokedGateway, _, _ := newGateway("Revoked")
	revoked, err := service.Revoke(ctx, master, revokedGateway.ID, revokedGateway.Version, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	if err = service.Delete(ctx, master, revoked.ID, revoked.Version, nil); err != nil {
		t.Fatal(err)
	}
	disabledGateway, _, _ := newGateway("Disabled")
	disabled, err := service.Update(ctx, master, disabledGateway.ID, disabledGateway.Name, disabledGateway.PublicHost, false, disabledGateway.Version, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = service.Delete(ctx, master, disabled.ID, disabled.Version, nil); err != nil {
		t.Fatal(err)
	}
}
