package runrecordings

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
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
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type harness struct {
	pool       *pgxpool.Pool
	service    *Service
	logbook    *machinelogbook.Service
	root       string
	master     authorization.Principal
	connector  printerconnectors.Context
	assignment uuid.UUID
	machine    uuid.UUID
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	pool := testdb.Pool(t)
	ctx := t.Context()
	root := t.TempDir()
	store, err := storage.NewLocal(root)
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{pool: pool, root: root, logbook: machinelogbook.NewService(pool, inbox.NewEmitter())}
	h.service = NewService(pool, files.NewService(pool, store), h.logbook, 1<<20)
	personID, accountID := ids.New(), ids.New()
	suffix := strings.ReplaceAll(personID.String(), "-", "")[:12]
	mustExec(t, pool, `INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Rec', 'Ording', $2)`, personID, "rec-"+suffix+"@example.test")
	mustExec(t, pool, `INSERT INTO accounts (id, person_id, status) VALUES ($1, $2, 'enabled')`, accountID, personID)
	h.master = authorization.Principal{AccountID: accountID, PersonID: personID, Master: true}
	machineType, err := h.logbook.CreateMachineType(ctx, h.master, "Recording printer "+suffix, "fdm_printing", nil)
	if err != nil {
		t.Fatal(err)
	}
	machine, err := h.logbook.CreateMachine(ctx, h.master, machineType.ID, "Recording machine "+suffix, "active", nil, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.machine = machine.ID
	h.connector = printerconnectors.Context{ID: ids.New(), Lifecycle: printerconnectors.LifecycleActive}
	h.assignment = ids.New()
	mustExec(t, pool, `INSERT INTO printer_connectors (id, name, lifecycle) VALUES ($1, $2, 'active')`, h.connector.ID, "Rec "+suffix)
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

func (h *harness) recordedRun(t *testing.T, state string) uuid.UUID {
	t.Helper()
	id := ids.New()
	seen := time.Now().UTC().Add(-3 * time.Hour)
	mustExec(t, h.pool, `INSERT INTO machine_runs (id, display_id, source, assignment_id, machine_id, state, first_observed_at, last_observed_at, started_at, ended_at)
		VALUES ($1, 'R-2031-' || lpad((('x' || substr(replace($1::uuid::text, '-', ''), 17, 7))::bit(28)::int)::text, 9, '0'), 'recorded', $2, $3, $4, $5, $5, $5, $6)`,
		id, h.assignment, h.machine, state, seen, seen.Add(time.Hour))
	return id
}

func TestRunCommandsAreAuthorizedIdempotentRateLimitedAndAudited(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	run := h.recordedRun(t, "finished")
	reader := h.principal(t, authorization.MachineJobsRead)
	if _, _, err := h.service.RequestCommand(ctx, reader, run, CommandRefetchArtifact, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("reader request = %v, want permission denied", err)
	}
	if _, _, err := h.service.RequestCommand(ctx, h.master, run, CommandRefetchArtifact, nil); !apperror.IsCode(err, "connector_commands_unavailable") {
		t.Fatalf("request before the connector polls = %v", err)
	}
	if _, _, err := h.service.RequestCommand(ctx, h.master, run, CommandRecomputeConsumption, nil); !apperror.IsCode(err, "run_artifact_missing") {
		t.Fatalf("recompute without artifact = %v", err)
	}
	if _, err := h.service.ConnectorCommands(ctx, h.connector); err != nil {
		t.Fatal(err)
	}
	first, created, err := h.service.RequestCommand(ctx, h.master, run, CommandRefetchArtifact, nil)
	if err != nil || !created || first.State != CommandRequested {
		t.Fatalf("first request = %+v %v %v", first, created, err)
	}
	again, created, err := h.service.RequestCommand(ctx, h.master, run, CommandRefetchArtifact, nil)
	if err != nil || created || again.ID != first.ID {
		t.Fatalf("repeated request = %+v %v %v", again, created, err)
	}
	var audited int
	if err = h.pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action='machine_run.artifact_refetch_requested' AND resource_id=$1`, run).Scan(&audited); err != nil || audited != 1 {
		t.Fatalf("audit events = %d %v", audited, err)
	}
	listed, err := h.service.ConnectorCommands(ctx, h.connector)
	if err != nil || len(listed) != 1 || listed[0].ID != first.ID {
		t.Fatalf("connector commands = %+v %v", listed, err)
	}
	other := printerconnectors.Context{ID: ids.New(), Lifecycle: printerconnectors.LifecycleActive}
	if err = h.service.ReportCommandStatus(ctx, other, first.ID, CommandRunning, nil); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("foreign connector status = %v", err)
	}
	if err = h.service.ReportCommandStatus(ctx, h.connector, first.ID, CommandRunning, nil); err != nil {
		t.Fatal(err)
	}
	reason := "artifact_path_unknown"
	if err = h.service.ReportCommandStatus(ctx, h.connector, first.ID, CommandFailed, &reason); err != nil {
		t.Fatal(err)
	}
	if err = h.service.ReportCommandStatus(ctx, h.connector, first.ID, CommandRunning, nil); !apperror.IsCode(err, "command_finished") {
		t.Fatalf("status after finish = %v", err)
	}
	recording, err := h.service.GetRecording(ctx, h.master, run)
	if err != nil || len(recording.Commands) != 1 || recording.Commands[0].State != CommandFailed ||
		*recording.Commands[0].ReasonCode != reason {
		t.Fatalf("recording commands = %+v %v", recording.Commands, err)
	}
	// Five commands per run and hour: four more are accepted, the next is throttled.
	for range 4 {
		command, _, requestErr := h.service.RequestCommand(ctx, h.master, run, CommandRefetchArtifact, nil)
		if requestErr != nil {
			t.Fatal(requestErr)
		}
		if err = h.service.ReportCommandStatus(ctx, h.connector, command.ID, CommandSucceeded, nil); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err = h.service.RequestCommand(ctx, h.master, run, CommandRefetchArtifact, nil); !apperror.IsCode(err, "run_command_rate_limited") {
		t.Fatalf("sixth request = %v", err)
	}
	// Commands for a running run or a manual run are refused.
	running := h.recordedRun(t, "running")
	if _, _, err = h.service.RequestCommand(ctx, h.master, running, CommandRefetchArtifact, nil); !apperror.IsCode(err, "run_running") {
		t.Fatalf("running run = %v", err)
	}
	// Stale commands are expired by maintenance.
	stale, _, err := h.service.RequestCommand(ctx, h.master, h.recordedRun(t, "failed"), CommandRefetchArtifact, nil)
	if err != nil {
		t.Fatal(err)
	}
	mustExec(t, h.pool, `UPDATE machine_run_commands SET requested_at = now() - interval '1 hour' WHERE id = $1`, stale.ID)
	if _, err = h.service.Maintain(ctx); err != nil {
		t.Fatal(err)
	}
	var state, code string
	if err = h.pool.QueryRow(ctx, `SELECT state, reason_code FROM machine_run_commands WHERE id=$1`, stale.ID).Scan(&state, &code); err != nil ||
		state != "failed" || code != "command_expired" {
		t.Fatalf("stale command = %s %s %v", state, code, err)
	}
}

func mp4(size int) []byte {
	return append([]byte("\x00\x00\x00\x18ftypmp42"), bytes.Repeat([]byte{7}, size)...)
}

func (h *harness) upload(t *testing.T, run uuid.UUID, video []byte) (TimelapseUploadResult, error) {
	t.Helper()
	digest := sha256.Sum256(video)
	return h.service.UploadTimelapse(t.Context(), h.connector, TimelapseUpload{
		AssignmentID: h.assignment, RunID: run, FileName: "video_1.mp4",
		SHA256: hex.EncodeToString(digest[:]), ContentLength: int64(len(video)),
	}, bytes.NewReader(video), nil)
}

func blobCount(t *testing.T, root string) int {
	t.Helper()
	count := 0
	_ = filepath.WalkDir(root, func(_ string, entry os.DirEntry, _ error) error {
		if entry != nil && !entry.IsDir() {
			count++
		}
		return nil
	})
	return count
}

func TestTimelapsesAreStoredStreamedExpiredAndDeletedWithTheirRun(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	run := h.recordedRun(t, "finished")
	video := mp4(4096)
	if _, err := h.upload(t, run, []byte("not a video at all")); !apperror.IsCode(err, "timelapse_not_mp4") {
		t.Fatalf("non-MP4 upload = %v", err)
	}
	if _, err := h.upload(t, run, mp4(2<<20)); !apperror.IsCode(err, "timelapse_too_large") {
		t.Fatalf("oversized upload = %v", err)
	}
	result, err := h.upload(t, run, video)
	if err != nil || !result.Created {
		t.Fatalf("upload = %+v %v", result, err)
	}
	if result, err = h.upload(t, run, video); err != nil || result.Created {
		t.Fatalf("repeated upload = %+v %v", result, err)
	}
	if _, err = h.upload(t, run, mp4(10)); !apperror.IsCode(err, "run_timelapse_exists") {
		t.Fatalf("different video = %v", err)
	}
	reader := h.principal(t, authorization.MachineJobsRead)
	if _, _, err = h.service.OpenRunTimelapse(ctx, authorization.Principal{}, run); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("download without machine_jobs.read = %v", err)
	}
	file, content, err := h.service.OpenRunTimelapse(ctx, reader, run)
	if err != nil {
		t.Fatal(err)
	}
	if _, seekable := content.(io.ReadSeeker); !seekable || file.SizeBytes != int64(len(video)) || !strings.HasSuffix(file.FileName, "-timelapse.mp4") {
		t.Fatalf("opened timelapse = %+v seekable=%v", file, seekable)
	}
	_ = content.Close()
	recording, err := h.service.GetRecording(ctx, h.master, run)
	if err != nil || recording.Timelapse == nil || recording.TimelapseStatus.State != TimelapseAvailable ||
		recording.Timelapse.ExpiresAt == nil || recording.ConsumptionStatus == nil {
		t.Fatalf("recording = %+v %v", recording, err)
	}
	// Retention removes old videos; the status then says expired.
	mustExec(t, h.pool, `UPDATE machine_run_timelapses SET created_at = now() - interval '91 days' WHERE run_id = $1`, run)
	if _, err = h.service.Maintain(ctx); err != nil {
		t.Fatal(err)
	}
	recording, err = h.service.GetRecording(ctx, h.master, run)
	if err != nil || recording.Timelapse != nil || recording.TimelapseStatus == nil || recording.TimelapseStatus.State != TimelapseExpired {
		t.Fatalf("expired recording = %+v %v", recording.TimelapseStatus, err)
	}
	if count := blobCount(t, h.root); count != 0 {
		t.Fatalf("expired blob kept: %d files", count)
	}
	// Deleting a run removes its timelapse in the same transaction and the blob on the next pass.
	other := h.recordedRun(t, "finished")
	if _, err = h.upload(t, other, video); err != nil {
		t.Fatal(err)
	}
	detail, err := h.logbook.GetRun(ctx, h.master, other)
	if err != nil {
		t.Fatal(err)
	}
	if err = h.logbook.DeleteRun(ctx, h.master, other, detail.Version, false, nil); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err = h.pool.QueryRow(ctx, `SELECT count(*) FROM machine_run_timelapses WHERE run_id=$1`, other).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("timelapse rows after run deletion = %d %v", rows, err)
	}
	if _, _, err = h.service.OpenRunTimelapse(ctx, reader, other); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("download after run deletion = %v", err)
	}
	if _, err = h.service.Maintain(ctx); err != nil {
		t.Fatal(err)
	}
	if count := blobCount(t, h.root); count != 0 {
		t.Fatalf("blob of deleted run kept: %d files", count)
	}
	// Disabled collection refuses uploads.
	settings, err := h.service.GetSettings(ctx, h.master)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.service.UpdateSettings(ctx, reader, SettingsInput{ExpectedVersion: settings.Version}, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("settings update without machines.manage = %v", err)
	}
	if _, err = h.service.UpdateSettings(ctx, h.master, SettingsInput{TimelapseRetentionDays: 30, ExpectedVersion: settings.Version}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err = h.upload(t, h.recordedRun(t, "finished"), video); !apperror.IsCode(err, "timelapse_disabled") {
		t.Fatalf("upload while disabled = %v", err)
	}
	mustExec(t, h.pool, `UPDATE run_recording_settings SET timelapse_enabled = true, timelapse_retention_days = 90`)
}

func TestConnectorRunReportsExplainMissingConsumption(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	run := h.recordedRun(t, "finished")
	reason, detail := "artifact_retrieval_failed", "ftps_listing_failed"
	if err := h.service.ReportRun(ctx, h.connector, h.assignment, run, RunReport{
		ProtocolVersion: 1, ObservedAt: time.Now().UTC(),
		Consumption: &RunReportSection{State: "unavailable", Reason: &reason, Detail: &detail},
	}); err != nil {
		t.Fatal(err)
	}
	// An older observation never replaces a newer one.
	older := "artifact_upload_failed"
	if err := h.service.ReportRun(ctx, h.connector, h.assignment, run, RunReport{
		ProtocolVersion: 1, ObservedAt: time.Now().UTC().Add(-time.Hour),
		Consumption: &RunReportSection{State: "pending", Reason: &older},
	}); err != nil {
		t.Fatal(err)
	}
	other := printerconnectors.Context{ID: ids.New(), Lifecycle: printerconnectors.LifecycleActive}
	if err := h.service.ReportRun(ctx, other, h.assignment, run, RunReport{ProtocolVersion: 1, ObservedAt: time.Now().UTC()}); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("foreign connector report = %v", err)
	}
	invalid := "Not A Code"
	if err := h.service.ReportRun(ctx, h.connector, h.assignment, run, RunReport{
		ProtocolVersion: 1, ObservedAt: time.Now().UTC(), Timelapse: &RunReportSection{State: "pending", Reason: &invalid},
	}); !apperror.IsCode(err, "run_report_invalid") {
		t.Fatalf("invalid report = %v", err)
	}
	detailRun, err := h.logbook.GetRun(ctx, h.master, run)
	if err != nil {
		t.Fatal(err)
	}
	status := detailRun.ConsumptionStatus
	if status == nil || status.State != machinelogbook.ConsumptionMissing || *status.Reason != machinelogbook.ReasonArtifactRetrievalFailed ||
		*status.Detail != detail {
		t.Fatalf("consumption status = %+v", status)
	}
	runs, _, err := h.logbook.ListRuns(ctx, h.master, machinelogbook.RunFilters{MachineID: &h.machine, Page: 1, PageSize: 10})
	if err != nil || len(runs) != 1 || runs[0].ConsumptionStatus == nil {
		t.Fatalf("listed runs = %+v %v", runs, err)
	}
}

// principal is an account whose only role grants permissions.
func (h *harness) principal(t *testing.T, permissions ...authorization.Permission) authorization.Principal {
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
