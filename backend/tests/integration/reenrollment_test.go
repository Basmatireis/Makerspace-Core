package integration_test

import (
	"net/http"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/google/uuid"
)

// reenrollment describes the printer connector for the re-enrollment scenario.
type reenrollment struct {
	adminPath    string // "/printer-connectors/{id}"
	enrollPath   string // daemon endpoint exchanging the enrollment secret
	configPath   string // daemon endpoint answering for a valid credential
	revisionSQL  string // SELECT configuration_revision ... WHERE id = $1
	childrenSQL  string // SELECT count of assignments / cameras ... WHERE <parent> = $1
	credentialsQ string // SELECT count(*) FROM credentials WHERE parent = $1 AND state = 'current'
	action       string // audit action
	revokedCode  string
	disable      string // SQL moving the entry to disabled
}

func (g *connectorEnv) runReenrollment(
	t *testing.T,
	spec reenrollment,
	id string,
	firstSecret, firstCredential string,
	manage staffSession,
	denied staffSession,
) {
	t.Helper()
	ctx := testContext(t)
	enroll := func(secret string) (string, string, *http.Response) {
		credID, credSecret := g.newCredential()
		return credID, credSecret, g.bearer(
			secret,
			http.MethodPost,
			spec.enrollPath,
			map[string]any{
				"credentialId":     credID,
				"credentialSecret": credSecret,
				"softwareVersion":  "test",
				"protocolVersion":  1,
			},
		)
	}
	var revisionBefore, children int64
	if err := g.pool.QueryRow(ctx, spec.revisionSQL, id).Scan(&revisionBefore); err != nil {
		t.Fatal(err)
	}
	if err := g.pool.QueryRow(ctx, spec.childrenSQL, id).Scan(&children); err != nil || children == 0 {
		t.Fatalf("children before = %d %v", children, err)
	}

	// Without the manage permission nothing is issued.
	g.expectCode(
		g.as(denied, http.MethodPost, spec.adminPath+"/enrollments", nil),
		http.StatusForbidden,
		"permission_denied",
	)

	// Issuing for an enrolled entry leaves the running daemon untouched.
	first := g.expect(g.as(manage, http.MethodPost, spec.adminPath+"/enrollments", nil), http.StatusCreated)
	g.expect(g.bearer(firstSecret, http.MethodGet, spec.configPath, nil), http.StatusOK)
	// A second issue revokes the first unused secret.
	second := g.expect(g.as(manage, http.MethodPost, spec.adminPath+"/enrollments", nil), http.StatusCreated)
	_, _, stale := enroll(first["enrollmentSecret"].(string))
	if stale.StatusCode != http.StatusUnauthorized {
		t.Fatalf("revoked enrollment status = %d", stale.StatusCode)
	}
	stale.Body.Close()
	g.expect(g.bearer(firstSecret, http.MethodGet, spec.configPath, nil), http.StatusOK)

	newID, newSecret, response := enroll(second["enrollmentSecret"].(string))
	g.expect(response, http.StatusOK)
	// The new credential works, the old daemon is rejected.
	g.expect(g.bearer(newSecret, http.MethodGet, spec.configPath, nil), http.StatusOK)
	g.expectCode(g.bearer(firstSecret, http.MethodGet, spec.configPath, nil), http.StatusUnauthorized, "unauthenticated")
	var current int
	var currentID string
	if err := g.pool.QueryRow(ctx, spec.credentialsQ, id).Scan(&current, &currentID); err != nil || current != 1 ||
		currentID != newID {
		t.Fatalf("current credentials = %d %s (%v), want 1 %s", current, currentID, err, newID)
	}
	if firstCredential == newID {
		t.Fatal("credential id reused")
	}
	// Entry keeps its lifecycle, children and gets a newer configuration revision.
	var revisionAfter, childrenAfter int64
	if err := g.pool.QueryRow(ctx, spec.revisionSQL, id).Scan(&revisionAfter); err != nil ||
		revisionAfter != revisionBefore+1 {
		t.Fatalf("revision %d -> %d (%v)", revisionBefore, revisionAfter, err)
	}
	if err := g.pool.QueryRow(ctx, spec.childrenSQL, id).Scan(&childrenAfter); err != nil || childrenAfter != children {
		t.Fatalf("children %d -> %d (%v)", children, childrenAfter, err)
	}
	if got := g.expect(g.as(manage, http.MethodGet, spec.adminPath, nil), http.StatusOK); got["lifecycle"] != "active" {
		t.Fatalf("lifecycle = %v", got["lifecycle"])
	}
	// The same exchange is idempotent; another credential on the used secret is refused.
	g.expect(
		g.bearer(
			second["enrollmentSecret"].(string),
			http.MethodPost,
			spec.enrollPath,
			map[string]any{
				"credentialId":     newID,
				"credentialSecret": newSecret,
				"softwareVersion":  "test",
				"protocolVersion":  1,
			},
		),
		http.StatusOK,
	)
	_, _, replay := enroll(second["enrollmentSecret"].(string))
	if replay.StatusCode != http.StatusConflict {
		t.Fatalf("replay status = %d", replay.StatusCode)
	}
	replay.Body.Close()
	if got := g.countAudit(spec.action); got != 1 {
		t.Fatalf("audit %s = %d", spec.action, got)
	}
	var leaked int
	for _, secret := range []string{
		first["enrollmentSecret"].(string),
		second["enrollmentSecret"].(string),
		newSecret,
		firstSecret,
	} {
		if err := g.pool.QueryRow(
			ctx,
			`SELECT count(*) FROM audit_events WHERE audit_events::text LIKE '%' || $1 || '%'`,
			secret,
		).Scan(&leaked); err != nil ||
			leaked != 0 {
			t.Fatalf("secret in %d audit rows (%v)", leaked, err)
		}
	}

	// A disabled entry can be re-enrolled and stays disabled.
	if _, err := g.pool.Exec(ctx, spec.disable, id); err != nil {
		t.Fatal(err)
	}
	third := g.expect(g.as(manage, http.MethodPost, spec.adminPath+"/enrollments", nil), http.StatusCreated)
	disabledID, disabledSecret, response := enroll(third["enrollmentSecret"].(string))
	_ = disabledID
	g.expect(response, http.StatusOK)
	g.expectCode(g.bearer(newSecret, http.MethodGet, spec.configPath, nil), http.StatusUnauthorized, "unauthenticated")
	g.expect(g.bearer(disabledSecret, http.MethodGet, spec.configPath, nil), http.StatusOK)
	if got := g.expect(
		g.as(manage, http.MethodGet, spec.adminPath, nil),
		http.StatusOK,
	); got["lifecycle"] != "disabled" {
		t.Fatalf("lifecycle = %v", got["lifecycle"])
	}

	// A revoked entry cannot be enrolled again, and an outstanding secret stops working.
	pending := g.expect(g.as(manage, http.MethodPost, spec.adminPath+"/enrollments", nil), http.StatusCreated)
	version := g.expect(g.as(manage, http.MethodGet, spec.adminPath, nil), http.StatusOK)["version"]
	g.expect(
		g.as(manage, http.MethodPost, spec.adminPath+"/revocation", map[string]any{"expectedVersion": version}),
		http.StatusOK,
	)
	g.expectCode(
		g.as(manage, http.MethodPost, spec.adminPath+"/enrollments", nil),
		http.StatusConflict,
		spec.revokedCode,
	)
	_, _, late := enroll(pending["enrollmentSecret"].(string))
	if late.StatusCode != http.StatusUnauthorized {
		t.Fatalf("enrollment after revocation = %d", late.StatusCode)
	}
	late.Body.Close()
	g.expectCode(g.bearer(disabledSecret, http.MethodGet, spec.configPath, nil), http.StatusUnauthorized, "unauthenticated")
}

func TestPrinterConnectorReenrollment(t *testing.T) {
	g := newConnectorEnv(t)
	manage := g.staff(
		"pcm-"+uuid.NewString()[:6],
		authorization.PrinterConnectorsRead,
		authorization.PrinterConnectorsManage,
		authorization.PrinterConnectorsCredentialsManage,
	)
	machine := g.bambu("Reenroll connector printer", "bambu_h2d", "192.168.1.61", "77778888")
	var connectorID string
	if err := g.pool.QueryRow(
		testContext(t),
		`SELECT connector_id::text FROM printer_connector_assignments WHERE machine_id = $1`,
		machine,
	).Scan(&connectorID); err != nil {
		t.Fatal(err)
	}
	path := "/printer-connectors/" + connectorID
	issue := g.expect(g.as(manage, http.MethodPost, path+"/enrollments", nil), http.StatusCreated)
	credID, credSecret := g.newCredential()
	g.expect(
		g.bearer(
			issue["enrollmentSecret"].(string),
			http.MethodPost,
			"/printer-connector/enroll",
			map[string]any{
				"credentialId":     credID,
				"credentialSecret": credSecret,
				"softwareVersion":  "test",
				"protocolVersion":  1,
			},
		),
		http.StatusOK,
	)
	g.runReenrollment(t, reenrollment{
		adminPath: path, enrollPath: "/printer-connector/enroll", configPath: "/printer-connector/self/configuration",
		revisionSQL:  `SELECT configuration_revision FROM printer_connectors WHERE id = $1`,
		childrenSQL:  `SELECT count(*) FROM printer_connector_assignments WHERE connector_id = $1 AND ended_at IS NULL`,
		credentialsQ: `SELECT count(*), COALESCE(max(id::text), '') FROM printer_connector_credentials WHERE connector_id = $1 AND state <> 'revoked'`,
		action:       "printer_connector.reenrolled", revokedCode: "printer_connector_revoked",
		disable: `UPDATE printer_connectors SET lifecycle = 'disabled', disabled_at = now() WHERE id = $1`,
	}, connectorID, credSecret, credID, manage, g.staff("pcr-"+uuid.NewString()[:6], authorization.PrinterConnectorsRead))
}
