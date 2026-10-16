package printerconnectors

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAdministrationRequiresRegisteredPermissions(t *testing.T) {
	service, err := NewService(nil, printing.NewService(nil), nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	principal := authorization.Principal{}
	id := uuid.Must(uuid.NewV7())
	tests := []struct {
		name string
		call func() error
	}{
		{"create", func() error { _, err := service.Create(ctx, principal, "connector", nil, nil); return err }},
		{"list", func() error { _, err := service.List(ctx, principal); return err }},
		{"get", func() error { _, err := service.Get(ctx, principal, id); return err }},
		{"list events", func() error { _, err := service.ListEvents(ctx, principal, id, false); return err }},
		{"clear events", func() error { _, err := service.ClearEvents(ctx, principal, id, nil); return err }},
		{"update", func() error { _, err := service.Update(ctx, principal, id, "connector", nil, true, 1, nil); return err }},
		{"enrollment", func() error { _, err := service.IssueEnrollment(ctx, principal, id, nil); return err }},
		{"revoke", func() error { _, err := service.Revoke(ctx, principal, id, 1, nil); return err }},
		{"assignment", func() error {
			_, err := service.CreateAssignment(ctx, principal, id, AssignmentInput{}, nil)
			return err
		}},
		{"update assignment", func() error {
			_, err := service.UpdateAssignment(ctx, principal, id, id, AssignmentUpdate{}, nil)
			return err
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := test.call(); !apperror.IsCode(err, "permission_denied") {
				t.Fatalf("expected permission_denied, got %v", err)
			}
		})
	}
}

func TestX1CAssignmentUsesBambuLANContract(t *testing.T) {
	t.Parallel()
	settings, secrets, err := validateAssignmentContract("bambu_x1c", 1,
		json.RawMessage(`{"ipAddress":"192.168.1.43","serialNumber":" 00m00a123456789 ","autoDetectSpools":true}`),
		map[string]string{"lanAccessCode": " secret "}, true)
	if err != nil {
		t.Fatal(err)
	}
	if string(settings) != `{"ipAddress":"192.168.1.43","serialNumber":"00M00A123456789","autoDetectSpools":true}` || secrets["lanAccessCode"] != "secret" {
		t.Fatalf("normalized contract = %s / %#v", settings, secrets)
	}
}

func printerConnectorIntegrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if err = pool.Ping(t.Context()); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestPrinterConnectorPostgresVerticalSlice(t *testing.T) {
	pool := printerConnectorIntegrationPool(t)
	ctx := t.Context()
	logbook := machinelogbook.NewService(pool)
	printingService := printing.NewService(pool)
	service, err := NewService(pool, printingService, nil)
	if err != nil {
		t.Fatal(err)
	}
	personID := uuid.Must(uuid.NewV7())
	accountID := uuid.Must(uuid.NewV7())
	requestID := uuid.Must(uuid.NewV7())
	suffix := strings.ReplaceAll(personID.String(), "-", "")[:12]
	principal := authorization.Principal{AccountID: accountID, PersonID: personID, Master: true}
	if _, err = pool.Exec(ctx, `INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Connector', 'Operator', $2)`, personID, "connector-"+suffix+"@example.test"); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO accounts (id, person_id, status) VALUES ($1, $2, 'enabled')`, accountID, personID); err != nil {
		t.Fatal(err)
	}
	machineType, err := logbook.CreateMachineType(ctx, principal, "Connector printer "+suffix, true, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	machine, err := logbook.CreateMachine(ctx, principal, machineType.ID, "Simulated printer "+suffix, "active", nil, false, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = printingService.ConfigureProfile(ctx, principal, machine.ID, true, 0, &requestID); err != nil {
		t.Fatal(err)
	}
	connector, err := service.Create(ctx, principal, "Room connector "+suffix, nil, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	issue, err := service.IssueEnrollment(ctx, principal, connector.ID, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	credentialID := uuid.Must(uuid.NewV7())
	credentialSecret, _, err := security.NewOpaqueToken()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.Enroll(ctx, issue.Secret, credentialID, credentialSecret, "test", 1); err != nil {
		t.Fatal(err)
	}
	connectorContext, err := service.Authenticate(ctx, credentialSecret)
	if err != nil || connectorContext == nil || connectorContext.ID != connector.ID {
		t.Fatalf("authenticate connector=%+v err=%v", connectorContext, err)
	}
	assignment, err := service.CreateAssignment(ctx, principal, connector.ID, AssignmentInput{MachineID: machine.ID, AdapterKind: "simulator", AdapterSchemaVersion: 1, Settings: json.RawMessage(`{"scenario":"idle"}`), Enabled: true}, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	runID := uuid.Must(uuid.NewV7())
	vendorJobID := "sim-" + suffix
	firstID := uuid.Must(uuid.NewV7())
	receipts, err := service.IngestEvents(ctx, *connectorContext, []EventInput{{EventID: firstID, AssignmentID: assignment.ID, RunID: &runID, HistoryComplete: true, ConfigurationVersion: assignment.ConfigurationVersion, Sequence: 1, OccurredAt: time.Now().UTC(), Kind: "progress", ExternalPrintID: &vendorJobID, Payload: json.RawMessage(`{"percent":20}`)}})
	if err != nil || len(receipts) != 1 || receipts[0].Status != "accepted" {
		t.Fatalf("first event receipts=%+v err=%v", receipts, err)
	}
	runs, err := service.ListObservedRuns(ctx, principal, connector.ID)
	if err != nil || len(runs) != 1 {
		t.Fatalf("observed runs=%+v err=%v", runs, err)
	}
	secondID := uuid.Must(uuid.NewV7())
	second := EventInput{EventID: secondID, AssignmentID: assignment.ID, RunID: &runID, HistoryComplete: true, ConfigurationVersion: assignment.ConfigurationVersion, Sequence: 2, OccurredAt: time.Now().UTC(), Kind: "progress", ExternalPrintID: &vendorJobID, Payload: json.RawMessage(`{"percent":40}`)}
	receipts, err = service.IngestEvents(ctx, *connectorContext, []EventInput{second})
	if err != nil || receipts[0].Status != "accepted" {
		t.Fatalf("second event receipts=%+v err=%v", receipts, err)
	}
	events, err := service.ListEvents(ctx, principal, connector.ID, false)
	if err != nil || len(events) != 2 || events[0].AssignmentID != assignment.ID {
		t.Fatalf("connector events=%+v err=%v", events, err)
	}
	runsBeforeDuplicate, err := service.ListObservedRuns(ctx, principal, connector.ID)
	if err != nil || len(runsBeforeDuplicate) != 1 {
		t.Fatalf("observed runs before duplicate=%+v err=%v", runsBeforeDuplicate, err)
	}
	receipts, err = service.IngestEvents(ctx, *connectorContext, []EventInput{second})
	if err != nil || receipts[0].Status != "duplicate" {
		t.Fatalf("duplicate event receipts=%+v err=%v", receipts, err)
	}
	runsAfterDuplicate, err := service.ListObservedRuns(ctx, principal, connector.ID)
	if err != nil || len(runsAfterDuplicate) != 1 || runsAfterDuplicate[0].Version != runsBeforeDuplicate[0].Version {
		t.Fatalf("duplicate changed observed run version: before=%+v after=%+v err=%v", runsBeforeDuplicate, runsAfterDuplicate, err)
	}
	second.Payload = json.RawMessage(`{"percent":41}`)
	receipts, err = service.IngestEvents(ctx, *connectorContext, []EventInput{second})
	if err != nil || receipts[0].Status != "rejected" {
		t.Fatalf("conflicting event receipts=%+v err=%v", receipts, err)
	}
	current, err := service.Get(ctx, principal, connector.ID)
	if err != nil {
		t.Fatal(err)
	}
	current, err = service.Update(ctx, principal, connector.ID, current.Name, current.LocationLabel, false, current.Version, &requestID)
	if err != nil || current.Lifecycle != "disabled" {
		t.Fatalf("disable connector=%+v err=%v", current, err)
	}
	disabledConfiguration, err := service.Configuration(ctx, Context{ID: current.ID, Lifecycle: current.Lifecycle})
	if err != nil || len(disabledConfiguration.Assignments) != 0 || disabledConfiguration.Revision != current.ConfigurationRevision {
		t.Fatalf("disabled connector configuration=%+v error=%v", disabledConfiguration, err)
	}
	current, err = service.Update(ctx, principal, connector.ID, current.Name, current.LocationLabel, true, current.Version, &requestID)
	if err != nil || current.Lifecycle != "active" {
		t.Fatalf("enable connector=%+v err=%v", current, err)
	}
	assignment, err = service.UpdateAssignment(ctx, principal, connector.ID, assignment.ID, AssignmentUpdate{AdapterKind: assignment.AdapterKind, AdapterSchemaVersion: assignment.AdapterSchemaVersion, Settings: json.RawMessage(`{"scenario":"idle"}`), Enabled: false, ExpectedVersion: assignment.Version}, &requestID)
	if err != nil || assignment.Enabled || assignment.ConfigurationVersion != 2 {
		t.Fatalf("disable assignment=%+v err=%v", assignment, err)
	}
	current, err = service.Get(ctx, principal, connector.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.Revoke(ctx, principal, connector.ID, current.Version, &requestID); err != nil {
		t.Fatal(err)
	}
	if authenticated, authErr := service.Authenticate(ctx, credentialSecret); authErr != nil || authenticated != nil {
		t.Fatalf("revoked credential authenticated=%+v err=%v", authenticated, authErr)
	}
}
