package integration_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var connectorTestKey = []byte("0123456789abcdef0123456789abcdef")

// connectorEnv is a signage environment with an encryption keyring plus helpers for Bambu printers
// behind printer connectors, called by plain bearer-token clients like the real connector.
type connectorEnv struct {
	*signageEnv
	admin   staffSession
	keyring *security.Keyring
	plain   *http.Client
}

func newConnectorEnv(t *testing.T) *connectorEnv {
	t.Helper()
	return newConnectorEnvWith(t, nil)
}

func newConnectorEnvWith(t *testing.T, adjust func(*config.Config)) *connectorEnv {
	t.Helper()
	// The extended protocol, like production: connector queries pass json columns as []byte.
	e := newSignageEnvMode(t, func(cfg *config.Config) {
		cfg.EncryptionKeys = [][]byte{connectorTestKey}
		if adjust != nil {
			adjust(cfg)
		}
	}, pgx.QueryExecModeCacheStatement)
	keyring, err := security.NewKeyring([][]byte{connectorTestKey})
	if err != nil {
		t.Fatal(err)
	}
	return &connectorEnv{
		signageEnv: e,
		admin: e.staff(
			"pcm-"+uuid.NewString()[:8],
			authorization.PrinterConnectorsRead,
			authorization.PrinterConnectorsManage,
			authorization.PrinterConnectorsCredentialsManage,
			authorization.MachinesManage,
		),
		keyring: keyring,
		plain:   &http.Client{},
	}
}

// bambu creates a machine with an active Bambu printer assignment whose LAN access code is stored
// encrypted exactly like the printer setup does. It returns the machine and its connector.
func (g *connectorEnv) bambu(name, kind, ip, code string) uuid.UUID {
	machine, _ := g.bambuWithConnector(name, kind, ip, code)
	return machine
}

func (g *connectorEnv) bambuWithConnector(name, kind, ip, code string) (machineID, connectorID uuid.UUID) {
	g.t.Helper()
	ctx := testContext(g.t)
	admin := g.fixture.admin
	requestID := ids.New()
	logbook := machinelogbook.NewService(g.pool, inbox.NewEmitter())
	printingService := printing.NewService(g.pool)
	connectors, err := printerconnectors.NewService(g.pool, inbox.NewEmitter(), printingService, nil)
	if err != nil {
		g.t.Fatal(err)
	}
	machineType, err := logbook.CreateMachineType(ctx, admin, name+" type", "fdm_printing", &requestID)
	if err != nil {
		g.t.Fatal(err)
	}
	machine, err := logbook.CreateMachine(ctx, admin, machineType.ID, name, "active", nil, false, &requestID)
	if err != nil {
		g.t.Fatal(err)
	}
	if _, err = printingService.ConfigureProfile(ctx, admin, machine.ID, true, 0, &requestID); err != nil {
		g.t.Fatal(err)
	}
	connector, err := connectors.Create(ctx, admin, name+" connector", nil, &requestID)
	if err != nil {
		g.t.Fatal(err)
	}
	g.assign(machine.ID, connector.ID, kind, ip, code)
	return machine.ID, connector.ID
}

func (g *connectorEnv) assign(machineID, connectorID uuid.UUID, kind, ip, code string) uuid.UUID {
	g.t.Helper()
	id := ids.New()
	var secrets []byte
	if code != "" {
		var err error
		if secrets, err = g.keyring.Encrypt(
			[]byte(`{"lanAccessCode":"`+code+`"}`),
			"printer-connector-assignment:"+id.String(),
		); err != nil {
			g.t.Fatal(err)
		}
	}
	settings := fmt.Sprintf(`{"ipAddress":%q,"serialNumber":"01P00A000000000","autoDetectSpools":false}`, ip)
	if _, err := g.pool.Exec(testContext(g.t), `INSERT INTO printer_connector_assignments (id, connector_id, machine_id, adapter_kind, settings, encrypted_secrets) VALUES ($1, $2, $3, $4, $5::text::jsonb, $6)`,
		id, connectorID, machineID, kind, settings, secrets); err != nil {
		g.t.Fatal(err)
	}
	return id
}

func (g *connectorEnv) newCredential() (string, string) {
	secret, _, err := security.NewOpaqueToken()
	if err != nil {
		g.t.Fatal(err)
	}
	return ids.New().String(), secret
}

// enrolledConnector creates a connector through the API and runs the enrollment handshake.
func (g *connectorEnv) enrolledConnector(name string) (string, string) {
	g.t.Helper()
	connector := g.expect(
		g.as(g.admin, http.MethodPost, "/printer-connectors", map[string]any{"name": name, "locationLabel": nil}),
		http.StatusCreated,
	)
	id := connector["id"].(string)
	issue := g.expect(g.as(g.admin, http.MethodPost, "/printer-connectors/"+id+"/enrollments", nil), http.StatusCreated)
	credID, credSecret := g.newCredential()
	g.expect(g.bearer(issue["enrollmentSecret"].(string), http.MethodPost, "/printer-connector/enroll", map[string]any{
		"credentialId":     credID,
		"credentialSecret": credSecret,
		"softwareVersion":  "0.8.3",
		"protocolVersion":  1,
	}), http.StatusOK)
	return id, credSecret
}

// bearer calls the API with a bearer token and no cookies, like a connector does.
func (g *connectorEnv) bearer(token, method, path string, body any) *http.Response {
	g.t.Helper()
	return g.do(g.plain, "", method, path, body, "Authorization", "Bearer "+token)
}

func cameraWidget(machine uuid.UUID) json.RawMessage {
	return json.RawMessage(
		`{"type":"camera","source":"machine","machineId":"` + machine.String() + `","multi":"split","showProgress":false,"showRemaining":false,"fallback":"text","fallbackMediaId":null}`,
	)
}
