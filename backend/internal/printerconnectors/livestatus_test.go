package printerconnectors

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

func liveStatusSnapshot(state string) json.RawMessage {
	return json.RawMessage(
		`{"state":"` + state + `","job":null,"temperatures":{"extruders":[],"bedC":null,"bedTargetC":null,"chamberC":null},"nozzles":[],"units":[],"activeTray":null,"errors":[],"firmwareVersion":null,"wifiSignalDbm":-39}`,
	)
}

func (h *ingestHarness) liveReport(observedAt time.Time, state string) LiveStatusReport {
	return LiveStatusReport{
		AssignmentID:         h.assignment.ID,
		ProtocolVersion:      1,
		ConfigurationVersion: h.assignment.ConfigurationVersion,
		ObservedAt:           observedAt,
		Snapshot:             liveStatusSnapshot(state),
	}
}

func TestLiveStatusRequiresMachinesRead(t *testing.T) {
	service, err := NewService(nil, inbox.NewEmitter(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.LiveStatus(t.Context(), authorization.Principal{}, ids.New()); !apperror.IsCode(
		err,
		"permission_denied",
	) {
		t.Fatalf("expected permission_denied, got %v", err)
	}
}

func TestLiveStatusReportAndRead(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Millisecond)

	if _, err := h.service.LiveStatus(ctx, h.principal, h.machine.ID); !apperror.IsCode(err, "not_found") {
		t.Fatalf("no snapshot yet must be not_found, got %v", err)
	}
	if err := h.service.ReportLiveStatus(ctx, h.connector, h.liveReport(now, "idle")); err != nil {
		t.Fatal(err)
	}
	status, err := h.service.LiveStatus(ctx, h.principal, h.machine.ID)
	if err != nil || status.AssignmentID != h.assignment.ID || !status.ObservedAt.Equal(now) {
		t.Fatalf("status=%+v err=%v", status, err)
	}
	var snapshot map[string]any
	if err = json.Unmarshal(status.Snapshot, &snapshot); err != nil || snapshot["state"] != "idle" {
		t.Fatalf("snapshot=%s err=%v", status.Snapshot, err)
	}
	// The principal needs machines.read to see the snapshot.
	if _, err = h.service.LiveStatus(
		ctx,
		authorization.Principal{AccountID: h.principal.AccountID},
		h.machine.ID,
	); !apperror.IsCode(
		err,
		"permission_denied",
	) {
		t.Fatalf("expected permission_denied, got %v", err)
	}

	// A newer snapshot replaces it, an older one is ignored, and only one row exists.
	if err = h.service.ReportLiveStatus(
		ctx,
		h.connector,
		h.liveReport(now.Add(10*time.Second), "printing"),
	); err != nil {
		t.Fatal(err)
	}
	if err = h.service.ReportLiveStatus(ctx, h.connector, h.liveReport(now.Add(5*time.Second), "paused")); err != nil {
		t.Fatalf("an older snapshot is ignored, not an error: %v", err)
	}
	status, err = h.service.LiveStatus(ctx, h.principal, h.machine.ID)
	if err != nil || !status.ObservedAt.Equal(now.Add(10*time.Second)) ||
		!strings.Contains(string(status.Snapshot), `"printing"`) {
		t.Fatalf("status=%+v err=%v", status, err)
	}
	var rows int
	if err = h.pool.QueryRow(
		ctx,
		`SELECT count(*) FROM printer_live_statuses WHERE assignment_id = $1`,
		h.assignment.ID,
	).Scan(&rows); err != nil ||
		rows != 1 {
		t.Fatalf("rows=%d err=%v", rows, err)
	}
	var audits int
	if err = h.pool.QueryRow(
		ctx,
		`SELECT count(*) FROM audit_events WHERE resource_id = $1 AND action LIKE '%live%'`,
		h.assignment.ID,
	).Scan(&audits); err != nil ||
		audits != 0 {
		t.Fatalf("live status must not be audited: %d err=%v", audits, err)
	}
}

func TestLiveStatusReportRejections(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	now := time.Now().UTC()

	other := h.connector
	other.ID = ids.New()
	if err := h.service.ReportLiveStatus(ctx, other, h.liveReport(now, "idle")); !apperror.IsCode(err, "not_found") {
		t.Fatalf("another connector's assignment must be not_found, got %v", err)
	}
	unknown := h.liveReport(now, "idle")
	unknown.AssignmentID = ids.New()
	if err := h.service.ReportLiveStatus(ctx, h.connector, unknown); !apperror.IsCode(err, "not_found") {
		t.Fatalf("unknown assignment must be not_found, got %v", err)
	}
	stale := h.liveReport(now, "idle")
	stale.ConfigurationVersion = h.assignment.ConfigurationVersion + 1
	if err := h.service.ReportLiveStatus(ctx, h.connector, stale); !apperror.IsCode(
		err,
		"configuration_version_mismatch",
	) {
		t.Fatalf("a wrong configuration version must be a conflict, got %v", err)
	}
	inactive := h.connector
	inactive.Lifecycle = "disabled"
	if err := h.service.ReportLiveStatus(ctx, inactive, h.liveReport(now, "idle")); !apperror.IsCode(
		err,
		"printer_connector_inactive",
	) {
		t.Fatalf("a disabled connector must be refused, got %v", err)
	}
	future := h.liveReport(now.Add(time.Hour), "idle")
	if err := h.service.ReportLiveStatus(ctx, h.connector, future); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("a snapshot from the future must be invalid, got %v", err)
	}
	huge := h.liveReport(now, "idle")
	huge.Snapshot = json.RawMessage(`{"padding":"` + strings.Repeat("x", maximumLiveStatusBytes) + `"}`)
	if err := h.service.ReportLiveStatus(ctx, h.connector, huge); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("an oversized snapshot must be invalid, got %v", err)
	}
	notObject := h.liveReport(now, "idle")
	notObject.Snapshot = json.RawMessage(`[1]`)
	if err := h.service.ReportLiveStatus(ctx, h.connector, notObject); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("a non-object snapshot must be invalid, got %v", err)
	}
	var rows int
	if err := h.pool.QueryRow(
		ctx,
		`SELECT count(*) FROM printer_live_statuses WHERE assignment_id = $1`,
		h.assignment.ID,
	).Scan(&rows); err != nil ||
		rows != 0 {
		t.Fatalf("rejected reports must not store anything: rows=%d err=%v", rows, err)
	}

	// Ending the assignment hides its snapshot and refuses further reports.
	if err := h.service.ReportLiveStatus(ctx, h.connector, h.liveReport(now, "idle")); err != nil {
		t.Fatal(err)
	}
	if _, err := h.service.UpdateAssignment(
		ctx,
		h.principal,
		h.connector.ID,
		h.assignment.ID,
		AssignmentUpdate{
			AdapterKind:          h.assignment.AdapterKind,
			AdapterSchemaVersion: h.assignment.AdapterSchemaVersion,
			Settings:             h.assignment.Settings,
			Enabled:              false,
			End:                  true,
			ExpectedVersion:      h.assignment.Version,
		},
		nil,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := h.service.LiveStatus(ctx, h.principal, h.machine.ID); !apperror.IsCode(err, "not_found") {
		t.Fatalf("an ended assignment has no live status, got %v", err)
	}
	if err := h.service.ReportLiveStatus(
		ctx,
		h.connector,
		h.liveReport(now.Add(time.Second), "idle"),
	); !apperror.IsCode(
		err,
		"not_found",
	) {
		t.Fatalf("an ended assignment must be not_found, got %v", err)
	}
}
