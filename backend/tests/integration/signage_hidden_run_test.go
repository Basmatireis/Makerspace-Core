package integration_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

// A running run its operator hid removes the machine from signage entirely: no status, no camera ticket,
// also for automatic camera widgets. Runs that ended, were deleted or were never hidden change nothing.
func TestHiddenRunRemovesMachineFromSignageLive(t *testing.T) {
	g := newGatewayEnv(t)
	ctx := testContext(t)
	staff := g.allStaff()
	svc, admin := g.fixture.service, g.fixture.admin
	gateway, _ := g.enrolledGateway("Hidden run gateway", "gw-hidden.example.org")
	hiding := g.bambu("Hiding printer", "bambu_h2d", "192.168.1.81", "20000001")
	other := g.bambu("Other printer", "bambu_h2d", "192.168.1.82", "20000002")
	for _, machine := range []uuid.UUID{hiding, other} {
		g.expect(
			g.as(
				g.admin,
				http.MethodPost,
				"/streaming-gateways/"+gateway["id"].(string)+"/cameras",
				map[string]any{"machineId": machine.String(), "enabled": true},
			),
			http.StatusCreated,
		)
	}
	boundInput := sceneInput("Bound camera", "full")
	boundInput.Zones = map[string]json.RawMessage{"main": cameraWidget(hiding)}
	bound, err := svc.CreateScene(ctx, admin, boundInput, nil)
	if err != nil {
		t.Fatal(err)
	}
	autoInput := sceneInput("Automatic cameras", "full")
	autoInput.Zones = map[string]json.RawMessage{
		"main": json.RawMessage(
			`{"type":"camera","source":"auto","multi":"split","showProgress":false,"showRemaining":false,"fallback":"text","fallbackMediaId":null}`,
		),
	}
	automatic, err := svc.CreateScene(ctx, admin, autoInput, nil)
	if err != nil {
		t.Fatal(err)
	}
	display := func(name string, scene uuid.UUID) *http.Client {
		shown, player := g.pair(staff, name, g.fixture.playlist(t, name, scene).ID)
		g.expect(g.as(staff, http.MethodPost, "/signage/displays/"+shown["id"].(string)+"/publish", nil), http.StatusOK)
		return player
	}
	boundPlayer, autoPlayer := display("Bound display", bound.ID), display("Automatic display", automatic.ID)
	observed := func(player *http.Client) (streams, machines map[string]bool) {
		t.Helper()
		live := g.expect(g.do(player, "", http.MethodGet, "/signage/player/live", nil), http.StatusOK)
		streams, machines = map[string]bool{}, map[string]bool{}
		for _, item := range live["streams"].([]any) {
			streams[item.(map[string]any)["machineId"].(string)] = true
		}
		for _, item := range live["machines"].([]any) {
			machines[item.(map[string]any)["machineId"].(string)] = true
		}
		return streams, machines
	}
	expect := func(label string, player *http.Client, wantHiding bool, wantOther bool) {
		t.Helper()
		streams, machines := observed(player)
		want := map[string]bool{hiding.String(): wantHiding, other.String(): wantOther}
		for machine, visible := range want {
			if player == boundPlayer && machine == other.String() {
				continue // the bound widget never showed the other machine
			}
			if streams[machine] != visible || machines[machine] != visible {
				t.Fatalf("%s: machine %s want visible=%v, streams=%v machines=%v", label, machine, visible, streams, machines)
			}
		}
	}
	expect("bound, nothing hidden", boundPlayer, true, false)
	expect("auto, nothing hidden", autoPlayer, true, true)

	insertRun := func(hidden bool, state string, endsInFuture bool) uuid.UUID {
		t.Helper()
		id := ids.New()
		if _, err = g.pool.Exec(
			ctx,
			`INSERT INTO machine_runs (id, display_id, source, assignment_id, machine_id, state, first_observed_at, last_observed_at,
				started_at, ended_at, hidden_from_signage)
			 SELECT $1, 'R-2031-' || lpad((('x' || substr(replace($1::uuid::text, '-', ''), 17, 7))::bit(28)::int)::text, 9, '0'),
				'recorded', a.id, $2, $3, now() - interval '1 hour', now(), now() - interval '1 hour',
				CASE WHEN $4 THEN NULL ELSE now() END, $5
			 FROM printer_connector_assignments a WHERE a.machine_id = $2 AND a.ended_at IS NULL`,
			id,
			hiding,
			state,
			endsInFuture,
			hidden,
		); err != nil {
			t.Fatal(err)
		}
		return id
	}
	// A visible running run changes nothing.
	run := insertRun(false, "running", true)
	expect("running, visible", autoPlayer, true, true)
	// The opt-out removes the machine from machines and streams, for bound and automatic widgets alike.
	if _, err = g.pool.Exec(ctx, `UPDATE machine_runs SET hidden_from_signage = true WHERE id = $1`, run); err != nil {
		t.Fatal(err)
	}
	expect("running, hidden (bound)", boundPlayer, false, false)
	expect("running, hidden (auto)", autoPlayer, false, true)
	// The preview carries no tickets but must not list the machine either.
	displays := g.expect(g.as(staff, http.MethodGet, "/signage/displays", nil), http.StatusOK)
	for _, item := range displays["items"].([]any) {
		preview := g.expect(
			g.as(staff, http.MethodGet, "/signage/displays/"+item.(map[string]any)["id"].(string)+"/preview", nil),
			http.StatusOK,
		)
		for _, machine := range preview["live"].(map[string]any)["machines"].([]any) {
			if machine.(map[string]any)["machineId"] == hiding.String() {
				t.Fatalf("preview shows the hidden machine: %v", preview["live"])
			}
		}
	}
	// Once the run ended, the machine is visible again even though the flag stays on the finished run.
	if _, err = g.pool.Exec(ctx, `UPDATE machine_runs SET state = 'finished', ended_at = now() WHERE id = $1`, run); err != nil {
		t.Fatal(err)
	}
	expect("run ended", autoPlayer, true, true)
	// A deleted run no longer hides anything, and a new run starts visible.
	hiddenAgain := insertRun(true, "running", true)
	expect("second run hidden", autoPlayer, false, true)
	if _, err = g.pool.Exec(ctx, `UPDATE machine_runs SET deleted_at = now() WHERE id = $1`, hiddenAgain); err != nil {
		t.Fatal(err)
	}
	expect("hidden run deleted", autoPlayer, true, true)
}
