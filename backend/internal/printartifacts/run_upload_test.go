package printartifacts

import (
	"archive/zip"
	"bytes"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/testdb"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/runrecordings"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type uploadHarness struct {
	pool       *pgxpool.Pool
	service    *Service
	recordings *runrecordings.Service
	logbook    *machinelogbook.Service
	master     authorization.Principal
	connector  printerconnectors.Context
	assignment uuid.UUID
	machine    uuid.UUID
}

func newUploadHarness(t *testing.T) *uploadHarness {
	t.Helper()
	pool := testdb.Pool(t)
	ctx := t.Context()
	store, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fileService := files.NewService(pool, store)
	logbook := machinelogbook.NewService(pool, inbox.NewEmitter())
	h := &uploadHarness{pool: pool, logbook: logbook, recordings: runrecordings.NewService(pool, fileService, logbook, 1<<20)}
	h.service = NewService(pool, fileService, logbook, h.recordings)
	personID, accountID := ids.New(), ids.New()
	suffix := strings.ReplaceAll(personID.String(), "-", "")[:12]
	mustExec(t, pool, `INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Up', 'Loader', $2)`, personID, "up-"+suffix+"@example.test")
	mustExec(t, pool, `INSERT INTO accounts (id, person_id, status) VALUES ($1, $2, 'enabled')`, accountID, personID)
	h.master = authorization.Principal{AccountID: accountID, PersonID: personID, Master: true}
	machineType, err := logbook.CreateMachineType(ctx, h.master, "Upload printer "+suffix, "fdm_printing", nil)
	if err != nil {
		t.Fatal(err)
	}
	machine, err := logbook.CreateMachine(ctx, h.master, machineType.ID, "Upload machine "+suffix, "active", nil, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.machine = machine.ID
	h.connector = printerconnectors.Context{ID: ids.New(), Lifecycle: printerconnectors.LifecycleActive}
	h.assignment = ids.New()
	mustExec(t, pool, `INSERT INTO printer_connectors (id, name, lifecycle) VALUES ($1, $2, 'active')`, h.connector.ID, "Up "+suffix)
	mustExec(t, pool, `INSERT INTO printer_profiles (machine_id) VALUES ($1) ON CONFLICT DO NOTHING`, h.machine)
	mustExec(t, pool, `INSERT INTO printer_connector_assignments (id, connector_id, machine_id, adapter_kind) VALUES ($1, $2, $3, 'bambu_x1c')`,
		h.assignment, h.connector.ID, h.machine)
	return h
}

func mustExec(t *testing.T, pool *pgxpool.Pool, statement string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), statement, args...); err != nil {
		t.Fatal(err)
	}
}

// recordedRun stores a recorded run printed from internal storage: its print name is fileName.
func (h *uploadHarness) recordedRun(t *testing.T, state, fileName string) uuid.UUID {
	t.Helper()
	id := ids.New()
	seen := time.Now().UTC().Add(-3 * time.Hour)
	var endedAt any = seen.Add(time.Hour)
	if state == "running" {
		endedAt = nil
	}
	mustExec(t, h.pool, `INSERT INTO machine_runs (id, display_id, source, assignment_id, machine_id, state, file_name, first_observed_at, last_observed_at, started_at, ended_at)
		VALUES ($1, 'R-2031-' || lpad((('x' || substr(replace($1::uuid::text, '-', ''), 17, 7))::bit(28)::int)::text, 9, '0'), 'recorded', $2, $3, $4, $5, $6, $6, $6, $7)`,
		id, h.assignment, h.machine, state, fileName, seen, endedAt)
	return id
}

func (h *uploadHarness) principal(t *testing.T, permissions ...authorization.Permission) authorization.Principal {
	t.Helper()
	person, account, role := ids.New(), ids.New(), ids.New()
	mustExec(t, h.pool, `INSERT INTO people(id,first_name,last_name,email) VALUES($1,'Limited','Reader',$2)`, person, "limited-"+person.String()+"@example.test")
	mustExec(t, h.pool, `INSERT INTO accounts(id,person_id,status) VALUES($1,$2,'enabled')`, account, person)
	mustExec(t, h.pool, `INSERT INTO roles(id,name) VALUES($1,$2)`, role, "limited-"+role.String())
	mustExec(t, h.pool, `INSERT INTO person_roles(person_id,role_id) VALUES($1,$2)`, person, role)
	for _, permission := range permissions {
		mustExec(t, h.pool, `INSERT INTO role_permission_grants(id,role_id,permission_id) VALUES($1,$2,$3)`, ids.New(), role, string(permission))
	}
	p, err := authorization.LoadPermissionsFrom(t.Context(), h.pool, authorization.Principal{AccountID: account, PersonID: person})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// connectorPolls marks the run's connector as receiving commands.
func (h *uploadHarness) connectorPolls(t *testing.T) {
	t.Helper()
	if _, err := h.recordings.ConnectorCommands(t.Context(), h.connector); err != nil {
		t.Fatal(err)
	}
}

// archive is a minimal valid 3MF; the marker makes the bytes (and so the artifact) distinct.
func archive(t *testing.T, marker string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	// An ordered list keeps the bytes (and so the artifact) identical for the same marker.
	entries := [][2]string{
		{"Metadata/slice_info.config", `<?xml version="1.0"?><config><plate id="1"/><filament id="0" type="PLA" used_mm="100" used_g="0.3" density="1.24" diameter="1.75" extruder="0"/></config>`},
		{"Metadata/plate_1.gcode", "M82\nG92 E0\n; layer: 0\nG1 E10\n; layer: 1\nG1 E20\n; " + marker + "\n"},
	}
	for _, item := range entries {
		entry, err := writer.Create(item[0])
		if err != nil {
			t.Fatal(err)
		}
		if _, err = entry.Write([]byte(item[1])); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestRunUploadNeedsMachineJobsEdit(t *testing.T) {
	h := newUploadHarness(t)
	run := h.recordedRun(t, "finished", "Benchy")
	for name, principal := range map[string]authorization.Principal{
		"reader":  h.principal(t, authorization.MachineJobsRead),
		"creator": h.principal(t, authorization.MachineJobsRead, authorization.MachineJobsCreate),
		"nobody":  h.principal(t),
	} {
		_, err := h.service.UploadForRun(t.Context(), principal, run, "Benchy.gcode.3mf", bytes.NewReader(archive(t, name)), nil)
		if !errors.Is(err, apperror.PermissionDenied) {
			t.Errorf("%s upload = %v, want permission denied", name, err)
		}
	}
	var linked *uuid.UUID
	if err := h.pool.QueryRow(t.Context(), `SELECT artifact_id FROM machine_runs WHERE id=$1`, run).Scan(&linked); err != nil || linked != nil {
		t.Fatalf("artifact after refused uploads = %v %v", linked, err)
	}
	editor := h.principal(t, authorization.MachineJobsEdit, authorization.MachineJobsRead)
	if _, err := h.service.UploadForRun(t.Context(), editor, run, "Benchy.gcode.3mf", bytes.NewReader(archive(t, "editor")), nil); err != nil {
		t.Fatalf("editor upload = %v", err)
	}
}

func TestRunUploadLinksParsesAuditsAndRequestsRecomputeForEndedRuns(t *testing.T) {
	h := newUploadHarness(t)
	ctx := t.Context()
	h.connectorPolls(t)
	run := h.recordedRun(t, "finished", "Benchy")
	result, err := h.service.UploadForRun(ctx, h.master, run, "Benchy.gcode.3mf", bytes.NewReader(archive(t, "ended")), nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.NameMismatch || result.Replaced || result.ConsumptionRecompute != runrecordings.RecomputeRequested ||
		result.Artifact.ParserStatus == "" || len(result.Artifact.Filaments) != 1 {
		t.Fatalf("result = %+v", result)
	}
	recording, err := h.recordings.GetRecording(ctx, h.master, run)
	if err != nil {
		t.Fatal(err)
	}
	if recording.Artifact == nil || recording.Artifact.ID != result.Artifact.ID || !recording.Artifact.UploadedManually {
		t.Fatalf("recording artifact = %+v", recording.Artifact)
	}
	if len(recording.Commands) != 1 || recording.Commands[0].Kind != runrecordings.CommandRecomputeConsumption ||
		recording.Commands[0].State != runrecordings.CommandRequested {
		t.Fatalf("commands = %+v", recording.Commands)
	}
	for _, action := range []string{"machine_run.artifact_uploaded", "print_artifact.created", "machine_run.consumption_recompute_requested"} {
		var count int
		if err = h.pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action=$1 AND actor_account_id=$2`, action, h.master.AccountID).Scan(&count); err != nil || count != 1 {
			t.Errorf("audit %s = %d %v", action, count, err)
		}
	}
	// A second upload of the same bytes neither replaces anything nor queues a second command.
	again, err := h.service.UploadForRun(ctx, h.master, run, "Benchy.gcode.3mf", bytes.NewReader(archive(t, "ended")), nil)
	if err != nil || again.Replaced || again.Artifact.ID != result.Artifact.ID ||
		again.ConsumptionRecompute != runrecordings.RecomputeAlreadyRequested {
		t.Fatalf("repeat = %+v %v", again, err)
	}
}

func TestRunUploadToARunningRunWaitsForItsEnd(t *testing.T) {
	h := newUploadHarness(t)
	ctx := t.Context()
	h.connectorPolls(t)
	run := h.recordedRun(t, "running", "Benchy")
	result, err := h.service.UploadForRun(ctx, h.master, run, "Benchy.3mf", bytes.NewReader(archive(t, "running")), nil)
	if err != nil || result.ConsumptionRecompute != runrecordings.RecomputeNotNeeded {
		t.Fatalf("running upload = %+v %v", result, err)
	}
	var commands int
	if err = h.pool.QueryRow(ctx, `SELECT count(*) FROM machine_run_commands WHERE run_id=$1`, run).Scan(&commands); err != nil || commands != 0 {
		t.Fatalf("commands for a running run = %d %v", commands, err)
	}
	var linked bool
	if err = h.pool.QueryRow(ctx, `SELECT artifact_id IS NOT NULL AND artifact_manual FROM machine_runs WHERE id=$1`, run).Scan(&linked); err != nil || !linked {
		t.Fatalf("run not linked: %v %v", linked, err)
	}
}

func TestRunUploadWithoutAConnectorThatTakesCommandsLeavesConsumptionAlone(t *testing.T) {
	h := newUploadHarness(t)
	run := h.recordedRun(t, "finished", "Benchy")
	// The connector never polled commands.
	result, err := h.service.UploadForRun(t.Context(), h.master, run, "Benchy.3mf", bytes.NewReader(archive(t, "silent")), nil)
	if err != nil || result.ConsumptionRecompute != runrecordings.RecomputeUnavailable {
		t.Fatalf("upload = %+v %v", result, err)
	}
	// An assignment that ended (connector removed) is unavailable too.
	h.connectorPolls(t)
	mustExec(t, h.pool, `UPDATE printer_connector_assignments SET ended_at = now() WHERE id=$1`, h.assignment)
	other := h.recordedRun(t, "finished", "Benchy")
	result, err = h.service.UploadForRun(t.Context(), h.master, other, "Benchy.3mf", bytes.NewReader(archive(t, "gone")), nil)
	if err != nil || result.ConsumptionRecompute != runrecordings.RecomputeUnavailable {
		t.Fatalf("upload after assignment ended = %+v %v", result, err)
	}
}

func TestRunUploadReplacementRules(t *testing.T) {
	h := newUploadHarness(t)
	ctx := t.Context()
	run := h.recordedRun(t, "finished", "Benchy")
	first, err := h.service.UploadForRun(ctx, h.master, run, "Benchy.3mf", bytes.NewReader(archive(t, "one")), nil)
	if err != nil {
		t.Fatal(err)
	}
	// A manually uploaded file can be replaced by another manual upload.
	second, err := h.service.UploadForRun(ctx, h.master, run, "Benchy.3mf", bytes.NewReader(archive(t, "two")), nil)
	if err != nil || !second.Replaced || second.Artifact.ID == first.Artifact.ID {
		t.Fatalf("replacement = %+v %v", second, err)
	}
	// The file the connector retrieved is never overwritten.
	mustExec(t, h.pool, `UPDATE machine_runs SET artifact_manual = false WHERE id=$1`, run)
	if _, err = h.service.UploadForRun(ctx, h.master, run, "Benchy.3mf", bytes.NewReader(archive(t, "three")), nil); !apperror.IsCode(err, "run_artifact_connector_retrieved") {
		t.Fatalf("overwriting a retrieved file = %v", err)
	}
	var current uuid.UUID
	if err = h.pool.QueryRow(ctx, `SELECT artifact_id FROM machine_runs WHERE id=$1`, run).Scan(&current); err != nil || current != second.Artifact.ID {
		t.Fatalf("artifact after refusal = %v %v", current, err)
	}
	// Manual runs have no print file; unknown runs do not exist.
	start := time.Now().UTC().Add(-3 * time.Hour).Truncate(time.Second)
	group, err := h.logbook.CreatePricingGroup(ctx, h.master, "Upload "+run.String(), nil, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	job, err := h.logbook.CreateManualJob(ctx, h.master, machinelogbook.JobInput{
		MachineID:        h.machine,
		StartsAt:         start,
		EndsAt:           start.Add(time.Hour),
		Customer:         machinelogbook.PartyReference{Kind: "person", ID: h.master.PersonID},
		OperatorPersonID: h.master.PersonID,
		Outcome:          "successful",
		PricingGroupID:   &group.ID,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	manual := job.Runs[0].ID
	if _, err = h.service.UploadForRun(ctx, h.master, manual, "Benchy.3mf", bytes.NewReader(archive(t, "manual")), nil); !apperror.IsCode(err, "run_not_recorded") {
		t.Fatalf("manual run upload = %v", err)
	}
	if _, err = h.service.UploadForRun(ctx, h.master, ids.New(), "Benchy.3mf", bytes.NewReader(archive(t, "unknown")), nil); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("unknown run upload = %v", err)
	}
	var invalid *apperror.Error
	if _, err = h.service.UploadForRun(ctx, h.master, h.recordedRun(t, "finished", "Benchy"), "Benchy.3mf", strings.NewReader("not a 3MF"), nil); !errors.As(err, &invalid) ||
		invalid.HTTPStatus != http.StatusUnprocessableEntity {
		t.Fatalf("invalid file = %v", err)
	}
}

func TestRunUploadFlagsANameThatDiffersFromThePrintName(t *testing.T) {
	h := newUploadHarness(t)
	ctx := t.Context()
	for name, test := range map[string]struct {
		printName, uploaded string
		mismatch            bool
	}{
		"same name":             {"Benchy", "benchy.gcode.3mf", false},
		"truncated print name":  {"A very long part na...", "A very long part name.gcode.3mf", false},
		"another model":         {"Benchy", "Vase.gcode.3mf", true},
		"truncated other model": {"A very long part na...", "Vase.3mf", true},
	} {
		run := h.recordedRun(t, "finished", test.printName)
		result, err := h.service.UploadForRun(ctx, h.master, run, test.uploaded, bytes.NewReader(archive(t, name)), nil)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if result.NameMismatch != test.mismatch || result.PrintName == nil || *result.PrintName != test.printName {
			t.Errorf("%s: mismatch=%v printName=%v, want mismatch=%v", name, result.NameMismatch, result.PrintName, test.mismatch)
		}
		// The upload succeeded either way.
		var linked bool
		if err = h.pool.QueryRow(ctx, `SELECT artifact_id IS NOT NULL FROM machine_runs WHERE id=$1`, run).Scan(&linked); err != nil || !linked {
			t.Errorf("%s: not linked (%v)", name, err)
		}
	}
}
