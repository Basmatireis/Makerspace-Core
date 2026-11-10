package integration_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// printPageFixture seeds recorded runs with jobs, a 3MF with one preview and a timelapse.
type printPageFixture struct {
	g       *connectorEnv
	machine uuid.UUID
	store   *files.Service
	jobs    int
}

func (f *printPageFixture) exec(query string, args ...any) {
	f.g.t.Helper()
	if _, err := f.g.pool.Exec(testContext(f.g.t), query, args...); err != nil {
		f.g.t.Fatal(err)
	}
}

func (f *printPageFixture) job(person, organization, operator *uuid.UUID, title string) uuid.UUID {
	f.g.t.Helper()
	f.jobs++
	id := ids.New()
	f.exec(`INSERT INTO machine_jobs (id, display_id, machine_id, customer_person_id, customer_organization_id,
		operator_person_id, title) VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, ''))`,
		id, fmt.Sprintf("J-2031-%06d", 900000+f.jobs), f.machine, person, organization, operator, title)
	return id
}

func (f *printPageFixture) run(job *uuid.UUID) uuid.UUID {
	f.g.t.Helper()
	id := ids.New()
	f.exec(`INSERT INTO machine_runs (id, display_id, source, assignment_id, machine_id, state, first_observed_at,
			last_observed_at, started_at, ended_at, outcome, file_name, job_id)
		SELECT $1, 'R-2031-' || lpad((('x' || substr(replace($1::uuid::text, '-', ''), 17, 7))::bit(28)::int)::text, 9, '0'),
			'recorded', a.id, $2, 'finished', now() - interval '2 hours', now() - interval '1 hour',
			now() - interval '2 hours', now() - interval '1 hour', 'successful', 'printer-name.gcode.3mf', $3
		FROM printer_connector_assignments a WHERE a.machine_id = $2 AND a.ended_at IS NULL`, id, f.machine, job)
	return id
}

func (f *printPageFixture) stored(name, mime string, data []byte) uuid.UUID {
	f.g.t.Helper()
	file, err := f.store.StoreSystemBytes(testContext(f.g.t), name, mime, data, nil)
	if err != nil {
		f.g.t.Fatal(err)
	}
	return file.ID
}

// files gives the run a 3MF with one plate preview and a timelapse and returns their bytes and the preview.
func (f *printPageFixture) files(run uuid.UUID) (threeMF, preview, video []byte, previewID uuid.UUID) {
	f.g.t.Helper()
	threeMF = append([]byte("PK\x03\x04"), []byte(run.String())...)
	preview = append([]byte("\x89PNG\r\n\x1a\n"), []byte(run.String())...)
	video = append([]byte("\x00\x00\x00\x18ftypisom"), bytes.Repeat([]byte{'v'}, 2000)...)
	artifact, previewID := ids.New(), ids.New()
	artifactSum, previewSum, videoSum := sha256.Sum256(threeMF), sha256.Sum256(preview), sha256.Sum256(video)
	f.exec(`INSERT INTO print_artifacts (id, original_file_id, sha256, parser_status, parser_version)
		VALUES ($1, $2, $3, 'complete', 'test')`, artifact, f.stored("Lamp shade.3mf", "application/octet-stream", threeMF), artifactSum[:])
	f.exec(`INSERT INTO print_artifact_previews (id, artifact_id, file_id, archive_path, role, plate_number, width, height,
		mime_type, size_bytes, sha256) VALUES ($1, $2, $3, 'Metadata/plate_1.png', 'plate', 1, 2, 2, 'image/png', $4, $5)`,
		previewID, artifact, f.stored("plate_1.png", "image/png", preview), len(preview), previewSum[:])
	f.exec(`UPDATE print_artifacts SET primary_preview_id = $2 WHERE id = $1`, artifact, previewID)
	f.exec(`UPDATE machine_runs SET artifact_id = $2 WHERE id = $1`, run, artifact)
	f.exec(`INSERT INTO machine_run_timelapses (run_id, file_id, size_bytes, sha256) VALUES ($1, $2, $3, $4)`,
		run, f.stored("clip.mp4", "video/mp4", video), len(video), videoSum[:])
	return threeMF, preview, video, previewID
}

func printPagePaths(run, preview uuid.UUID) []string {
	base := "/print-pages/" + run.String()
	return []string{base, base + "/timelapse/content", base + "/file/content", base + "/previews/" + preview.String() + "/content"}
}

func (g *connectorEnv) expectPrintPageHidden(session staffSession, run, preview uuid.UUID, label string) {
	g.t.Helper()
	for _, path := range printPagePaths(run, preview) {
		response, body := g.rawGet(session.client, path)
		if response.StatusCode != http.StatusNotFound || !strings.Contains(string(body), `"not_found"`) {
			g.t.Fatalf("%s: GET %s = %d %s, want 404 not_found", label, path, response.StatusCode, body)
		}
	}
}

// jsonKeys collects every object key of a JSON document, at any depth.
func jsonKeys(t *testing.T, raw []byte) []string {
	t.Helper()
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	var keys []string
	var walk func(any)
	walk = func(v any) {
		switch typed := v.(type) {
		case map[string]any:
			for key, item := range typed {
				keys = append(keys, key)
				walk(item)
			}
		case []any:
			for _, item := range typed {
				walk(item)
			}
		}
	}
	walk(value)
	return keys
}

func TestPrintPageOpensForTheJobRecipientAndStaffOnly(t *testing.T) {
	g := newConnectorEnv(t)
	suffix := uuid.NewString()[:8]
	f := &printPageFixture{
		g: g, machine: g.bambu("Print page printer", "bambu_h2d", "192.168.1.95", "30000005"),
		store: files.NewService(g.pool, g.fixture.store),
	}
	recipient, other := g.staff("pp-recipient-"+suffix), g.staff("pp-other-"+suffix)
	staff := g.staff("pp-staff-"+suffix, authorization.MachineJobsRead)
	if recipient.principal.Has(authorization.MachineJobsRead) || other.principal.Has(authorization.MachineJobsRead) {
		t.Fatal("the test people must not hold machine_jobs.read")
	}
	operator := staff.account.personID
	recipientPerson := recipient.account.personID
	job := f.job(&recipientPerson, nil, &operator, "Lamp shade")
	run := f.run(&job)
	threeMF, preview, video, previewID := f.files(run)
	f.exec(`UPDATE machine_jobs SET calculated_price = 12.50 WHERE id = $1`, job)

	// The recipient sees the page without any material, price, operator or recipient data.
	response, body := g.rawGet(recipient.client, "/print-pages/"+run.String())
	if response.StatusCode != http.StatusOK || response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("recipient page = %d %s (Cache-Control %q)", response.StatusCode, body, response.Header.Get("Cache-Control"))
	}
	keys := jsonKeys(t, body)
	for _, key := range keys {
		lower := strings.ToLower(key)
		for _, forbidden := range []string{"material", "filament", "quantity", "price", "cost", "operator", "recipient", "customer", "person", "started_by", "startedby", "spool", "usage"} {
			if strings.Contains(lower, forbidden) {
				t.Fatalf("print page carries %q: %s", key, body)
			}
		}
	}
	top := []string{"runId", "displayId", "title", "machineName", "startedAt", "endedAt", "durationSeconds", "outcome",
		"timelapse", "timelapseStatus", "artifact", "previews", "viewerIsStaff"}
	var page map[string]any
	if err := json.Unmarshal(body, &page); err != nil {
		t.Fatal(err)
	}
	if len(page) != len(top) {
		t.Fatalf("print page keys = %v, want %v", keys, top)
	}
	for _, key := range top {
		if _, ok := page[key]; !ok {
			t.Fatalf("print page lacks %s: %s", key, body)
		}
	}
	if page["title"] != "Lamp shade" || page["machineName"] != "Print page printer" || page["outcome"] != "successful" ||
		page["viewerIsStaff"] != false || page["durationSeconds"] != float64(3600) ||
		page["artifact"].(map[string]any)["originalFileName"] != "Lamp shade.3mf" ||
		page["timelapse"].(map[string]any)["mimeType"] != "video/mp4" || len(page["previews"].([]any)) != 1 {
		t.Fatalf("recipient page = %s", body)
	}
	if bytes.Contains(body, []byte("12.5")) || bytes.Contains(body, []byte("Test")) {
		t.Fatalf("print page leaks a price or a name: %s", body)
	}

	// The recipient can load every piece of content, the video also by range.
	paths := printPagePaths(run, previewID)
	for path, want := range map[string][]byte{paths[1]: video, paths[2]: threeMF, paths[3]: preview} {
		response, body := g.rawGet(recipient.client, path)
		if response.StatusCode != http.StatusOK || !bytes.Equal(body, want) || response.Header.Get("Cache-Control") != "no-store" ||
			response.Header.Get("X-Content-Type-Options") != "nosniff" {
			t.Fatalf("recipient GET %s = %d headers=%v", path, response.StatusCode, response.Header)
		}
	}
	response, body = g.rawGet(recipient.client, paths[1], "Range", "bytes=10-19")
	if response.StatusCode != http.StatusPartialContent || !bytes.Equal(body, video[10:20]) {
		t.Fatalf("timelapse range = %d", response.StatusCode)
	}
	if response, _ := g.rawGet(recipient.client, "/print-pages/"+run.String()+"/previews/"+ids.New().String()+"/content"); response.StatusCode != http.StatusNotFound {
		t.Fatalf("a preview of another 3MF answered %d", response.StatusCode)
	}

	// A real preview id of another run never opens through this run's page, for the recipient or for staff.
	otherJob := f.job(&recipientPerson, nil, &operator, "Second print")
	otherRun := f.run(&otherJob)
	_, _, _, otherPreviewID := f.files(otherRun)
	foreign := "/print-pages/" + run.String() + "/previews/" + otherPreviewID.String() + "/content"
	for label, session := range map[string]staffSession{"recipient": recipient, "staff": staff} {
		if response, body := g.rawGet(session.client, foreign); response.StatusCode != http.StatusNotFound {
			t.Fatalf("%s opened another run's real preview through this run: %d %d bytes", label, response.StatusCode, len(body))
		}
	}
	if response, _ := g.rawGet(recipient.client, "/print-pages/"+otherRun.String()+"/previews/"+otherPreviewID.String()+"/content"); response.StatusCode != http.StatusOK {
		t.Fatalf("the preview through its own run answered %d", response.StatusCode)
	}

	// Without a session every print page path answers 401.
	anonymous := newCookieClient(t)
	for _, path := range paths {
		if response, body := g.rawGet(anonymous, path); response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("anonymous GET %s = %d %s, want 401", path, response.StatusCode, body)
		}
	}

	// Another signed-in person gets the same 404 as for a run that does not exist.
	g.expectPrintPageHidden(other, run, previewID, "other person")
	g.expectPrintPageHidden(other, ids.New(), previewID, "unknown run")

	// Staff with machine_jobs.read may open it.
	shown := g.expect(g.as(staff, http.MethodGet, "/print-pages/"+run.String(), nil), http.StatusOK)
	if shown["viewerIsStaff"] != true {
		t.Fatalf("staff page = %v", shown)
	}
	if response, body := g.rawGet(staff.client, paths[2]); response.StatusCode != http.StatusOK || !bytes.Equal(body, threeMF) {
		t.Fatalf("staff file = %d", response.StatusCode)
	}

	// A job whose recipient is an organization: staff only.
	organization := ids.New()
	f.exec(`INSERT INTO organizations (id, name, kind, contact_email) VALUES ($1, 'Print Page Org', 'other', 'pp-org@example.test')`, organization)
	orgRun := f.run(func() *uuid.UUID { id := f.job(nil, &organization, nil, ""); return &id }())
	g.expectPrintPageHidden(recipient, orgRun, previewID, "organization job, person without permission")
	orgPage := g.expect(g.as(staff, http.MethodGet, "/print-pages/"+orgRun.String(), nil), http.StatusOK)
	if orgPage["title"] != "printer-name.gcode.3mf" || orgPage["artifact"] != nil || orgPage["timelapse"] != nil {
		t.Fatalf("organization job page = %v", orgPage)
	}

	// Runs without a job, and runs or jobs in the recycle bin, exist for nobody.
	manual := ids.New()
	f.exec(`INSERT INTO machine_runs (id, display_id, machine_id, source, job_id, started_at, ended_at, history_complete)
		VALUES ($1, 'R-2031-900000777', $2, 'manual', $3, now() - interval '2 hours', now() - interval '1 hour', true)`,
		manual, f.machine, job)
	g.expectPrintPageHidden(recipient, manual, previewID, "manual run, recipient")
	g.expectPrintPageHidden(staff, manual, previewID, "manual run, staff")
	unassigned := f.run(nil)
	g.expectPrintPageHidden(staff, unassigned, previewID, "run without job")
	f.exec(`UPDATE machine_runs SET deleted_at = now(), former_job_id = job_id, job_id = NULL WHERE id = $1`, run)
	g.expectPrintPageHidden(recipient, run, previewID, "deleted run, recipient")
	g.expectPrintPageHidden(staff, run, previewID, "deleted run, staff")
	f.exec(`UPDATE machine_runs SET deleted_at = NULL, job_id = former_job_id, former_job_id = NULL WHERE id = $1`, run)
	f.exec(`UPDATE machine_jobs SET deleted_at = now() WHERE id = $1`, job)
	g.expectPrintPageHidden(recipient, run, previewID, "deleted job")
	f.exec(`UPDATE machine_jobs SET deleted_at = NULL WHERE id = $1`, job)

	// Once somebody else becomes the recipient, the former recipient loses the page.
	otherPerson := other.account.personID
	f.exec(`UPDATE machine_jobs SET customer_person_id = $2 WHERE id = $1`, job, otherPerson)
	g.expectPrintPageHidden(recipient, run, previewID, "former recipient")
	g.expect(g.as(other, http.MethodGet, "/print-pages/"+run.String(), nil), http.StatusOK)
}

// TestTimelapseReadyLinksThePrintPageOnlyForPasswordHolders raises timelapse_ready for runs whose jobs go to a person
// who can sign in with a password, a person who cannot, and an organization: only the first gets the print page in
// the e-mail. Rules limited to other machines stay quiet.
func TestTimelapseReadyLinksThePrintPageOnlyForPasswordHolders(t *testing.T) {
	g := newConnectorEnv(t)
	ctx := testContext(t)
	suffix := uuid.NewString()[:8]
	f := &printPageFixture{
		g: g, machine: g.bambu("Timelapse printer", "bambu_h2d", "192.168.1.96", "30000006"),
		store: files.NewService(g.pool, g.fixture.store),
	}
	otherPrinter := g.bambu("Other printer", "bambu_h2d", "192.168.1.97", "30000007")
	withPassword := g.staff("tl-password-" + suffix).account.personID
	withoutPassword := g.staff("tl-nopassword-" + suffix).account.personID
	f.exec(`DELETE FROM password_credentials pc USING auth_identities i, accounts a
		WHERE pc.auth_identity_id = i.id AND i.account_id = a.id AND a.person_id = $1`, withoutPassword)
	disabledAccount := g.staff("tl-disabled-" + suffix).account.personID
	f.exec(`UPDATE accounts SET status = 'disabled' WHERE person_id = $1`, disabledAccount)
	disabledPassword := g.staff("tl-disabledpw-" + suffix).account.personID
	f.exec(`UPDATE auth_identities i SET disabled_at = now() FROM accounts a
		WHERE i.account_id = a.id AND a.person_id = $1 AND i.kind = 'password'`, disabledPassword)
	organization := ids.New()
	f.exec(`INSERT INTO organizations (id, name, kind, contact_email) VALUES ($1, 'Timelapse Org', 'other', 'tl-org@example.test')`, organization)
	f.exec(`UPDATE mail_configuration SET enabled = true`)
	var category uuid.UUID
	if err := g.pool.QueryRow(ctx, `SELECT id FROM notification_categories WHERE key = 'service'`).Scan(&category); err != nil {
		t.Fatal(err)
	}
	rules := notifyrules.NewService(g.pool)
	newRule := func(name string, machines ...uuid.UUID) uuid.UUID {
		t.Helper()
		rule, err := rules.CreateRule(ctx, g.fixture.admin, notifyrules.RuleInput{
			Name: name, Enabled: true, CategoryID: &category,
			Definition: notifyrules.Definition{
				Trigger:    notifyrules.TriggerDef{Type: notifyrules.TriggerEvent, Event: "timelapse_ready", Machines: machines},
				Conditions: notifyrules.ConditionSet{Mode: notifyrules.ModeAll},
				Actions: []notifyrules.Action{
					{Channel: notifyrules.ChannelInApp, Recipients: []string{"recipient"}, Title: "Timelapse of {title}", Body: "{printPage}"},
					{Channel: notifyrules.ChannelEmail, Recipients: []string{"recipient"}, Title: "Timelapse of {title}", Body: "Watch it: {printPage}"},
				},
			},
		}, nil)
		if err != nil {
			t.Fatalf("create rule: %v", err)
		}
		return rule.ID
	}
	everywhere := newRule("Every printer")
	scoped := newRule("This printer", f.machine)
	elsewhere := newRule("Other printer only", otherPrinter)
	if _, err := rules.CreateRule(ctx, g.fixture.admin, notifyrules.RuleInput{
		Name: "Machine scope on a trigger without a machine", Enabled: true, CategoryID: &category,
		Definition: notifyrules.Definition{
			Trigger:    notifyrules.TriggerDef{Type: notifyrules.TriggerEvent, Event: "check_in", Machines: []uuid.UUID{f.machine}},
			Conditions: notifyrules.ConditionSet{Mode: notifyrules.ModeAll},
			Actions:    []notifyrules.Action{{Channel: notifyrules.ChannelInApp, Recipients: []string{"self"}, Title: "Hi"}},
		},
	}, nil); reasonOf(err) != "trigger.machines: this event is not about a machine" {
		t.Fatalf("machine scope on check_in: %v", err)
	}

	events := notifyrules.NewSystemEvents(notifyrules.NewDispatcher(g.pool, nil).WithPublicBaseURL(g.origin))
	raise := func(run uuid.UUID) {
		t.Helper()
		tx, err := g.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if err = events.TimelapseReady(ctx, tx, run); err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	type mail struct {
		body string
		link *string
	}
	mailOf := func(rule uuid.UUID, column string, id uuid.UUID) mail {
		t.Helper()
		var m mail
		if err := g.pool.QueryRow(ctx, `SELECT m.body, m.link FROM notification_mail_outbox m
			JOIN notification_firings f ON f.id = m.firing_id WHERE f.rule_id = $1 AND m.`+column+` = $2`, rule, id).
			Scan(&m.body, &m.link); err != nil {
			t.Fatalf("mail of rule to %s: %v", column, err)
		}
		return m
	}

	passwordRun := f.run(func() *uuid.UUID { id := f.job(&withPassword, nil, nil, "Lamp shade"); return &id }())
	raise(passwordRun)
	address := strings.TrimRight(g.origin, "/") + "/prints/" + passwordRun.String()
	for _, rule := range []uuid.UUID{everywhere, scoped} {
		got := mailOf(rule, "person_id", withPassword)
		if got.body != "Watch it: "+address || got.link == nil || *got.link != "/prints/"+passwordRun.String() {
			t.Fatalf("password holder mail = %q %v", got.body, got.link)
		}
		var link string
		if err := g.pool.QueryRow(ctx, `SELECT link FROM inbox_notifications WHERE rule_id = $1`, rule).Scan(&link); err != nil ||
			link != "/prints/"+passwordRun.String() {
			t.Fatalf("in-app link = %q (%v)", link, err)
		}
	}
	assertCount(t, g.pool, `SELECT count(*) FROM notification_firings WHERE rule_id = $1`, 0, elsewhere)

	noPasswordRun := f.run(func() *uuid.UUID { id := f.job(&withoutPassword, nil, nil, "Phone stand"); return &id }())
	raise(noPasswordRun)
	if got := mailOf(everywhere, "person_id", withoutPassword); got.body != "Watch it:" || got.link != nil {
		t.Fatalf("mail without password = %q %v", got.body, got.link)
	}

	// A disabled account and a disabled password identity get no print page link either, if they get a mail at all.
	for name, person := range map[string]uuid.UUID{"disabled account": disabledAccount, "disabled password identity": disabledPassword} {
		person := person
		run := f.run(func() *uuid.UUID { id := f.job(&person, nil, nil, "Stand "+name); return &id }())
		raise(run)
		var body string
		var link *string
		err := g.pool.QueryRow(ctx, `SELECT m.body, m.link FROM notification_mail_outbox m
			JOIN notification_firings f ON f.id = m.firing_id WHERE f.rule_id = $1 AND m.person_id = $2`, everywhere, person).Scan(&body, &link)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		if link != nil || strings.Contains(body, "/prints/") || strings.Contains(body, run.String()) {
			t.Fatalf("mail to %s = %q %v", name, body, link)
		}
	}

	orgRun := f.run(func() *uuid.UUID { id := f.job(nil, &organization, nil, ""); return &id }())
	raise(orgRun)
	if got := mailOf(everywhere, "organization_id", organization); got.body != "Watch it:" || got.link != nil {
		t.Fatalf("organization mail = %q %v", got.body, got.link)
	}

	// A run on another printer reaches only the rules without a machine list; a run without a job raises nothing.
	other := &printPageFixture{g: g, machine: otherPrinter, store: f.store, jobs: 100}
	otherRun := other.run(func() *uuid.UUID { id := other.job(&withPassword, nil, nil, "Elsewhere"); return &id }())
	raise(otherRun)
	raise(f.run(nil))
	assertCount(t, g.pool, `SELECT count(*) FROM notification_firings WHERE rule_id = $1`, 6, everywhere)
	assertCount(t, g.pool, `SELECT count(*) FROM notification_firings WHERE rule_id = $1`, 5, scoped)
	assertCount(t, g.pool, `SELECT count(*) FROM notification_firings WHERE rule_id = $1`, 1, elsewhere)
}

func reasonOf(err error) string {
	var app *apperror.Error
	if !errors.As(err, &app) {
		return fmt.Sprint(err)
	}
	text, _ := app.Details["reason"].(string)
	return text
}

// TestPersonalTimelapseReadyRuleNeedsMachineJobsRead refuses a personal timelapse_ready rule for an owner without
// machine_jobs.read, and accepts it for one with the permission.
func TestPersonalTimelapseReadyRuleNeedsMachineJobsRead(t *testing.T) {
	g := newConnectorEnv(t)
	ctx := testContext(t)
	suffix := uuid.NewString()[:8]
	plain := g.staff("tl-sub-plain-" + suffix)
	staff := g.staff("tl-sub-staff-"+suffix, authorization.MachineJobsRead)
	rules := notifyrules.NewService(g.pool)
	input := notifyrules.RuleInput{
		Name: "My timelapses", Enabled: true,
		Definition: notifyrules.Definition{
			Trigger:    notifyrules.TriggerDef{Type: notifyrules.TriggerEvent, Event: "timelapse_ready"},
			Conditions: notifyrules.ConditionSet{Mode: notifyrules.ModeAll},
			Actions:    []notifyrules.Action{{Channel: notifyrules.ChannelInApp, Recipients: []string{"me"}, Title: "Ready", Body: "{printPage}"}},
		},
	}
	if _, err := rules.CreateSubscription(ctx, plain.principal, input, nil); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("an owner without machine_jobs.read subscribed to timelapse_ready: %v", err)
	}
	if _, err := rules.CreateSubscription(ctx, staff.principal, input, nil); err != nil {
		t.Fatalf("an owner with machine_jobs.read was refused: %v", err)
	}
}
