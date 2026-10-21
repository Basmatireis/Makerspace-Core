package printerconnectors

import (
	"errors"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
)

func TestIngestedEventsGoToTheActivityLogNotTheAuditLog(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	t0 := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	runID := ids.New()
	h.accepted(runID, "progress", t0, `{"percent":10}`)
	h.accepted(runID, "progress", t0.Add(time.Minute), `{"percent":20}`)

	page, err := h.service.ListActivity(ctx, h.principal, h.connector.ID, 1, 25)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 2 || len(page.Items) != 2 {
		t.Fatalf("activity page: %+v", page)
	}
	newest := page.Items[0]
	if newest.Kind != ActivityEventIngested || newest.EventKind == nil || *newest.EventKind != "progress" ||
		newest.MachineID == nil || *newest.MachineID != h.machine.ID ||
		newest.MachineName == nil || *newest.MachineName != h.machine.Name || newest.ResourceID == nil ||
		page.Items[1].OccurredAt.After(newest.OccurredAt) {
		t.Fatalf("newest entry: %+v", newest)
	}
	var audited int
	if err = h.pool.QueryRow(
		ctx,
		`SELECT count(*) FROM audit_events WHERE resource_id = $1 OR action = 'printer_event.ingested'`,
		*newest.ResourceID,
	).Scan(&audited); err != nil || audited != 0 {
		t.Fatalf("ingested events were audited: %d %v", audited, err)
	}

	second, err := h.service.ListActivity(ctx, h.principal, h.connector.ID, 2, 1)
	if err != nil || len(second.Items) != 1 || second.Items[0].ID != page.Items[1].ID || second.Total != 2 {
		t.Fatalf("second page: %+v %v", second, err)
	}
}

func TestActivityLogNeedsConnectorReadPermission(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	reader := principalWith(t, ids.New(), authorization.PrinterConnectorsRead)
	if _, err := h.service.ListActivity(ctx, reader, h.connector.ID, 1, 25); err != nil {
		t.Fatalf("reader: %v", err)
	}
	outsider := principalWith(t, ids.New(), authorization.MachinesRead)
	if _, err := h.service.ListActivity(ctx, outsider, h.connector.ID, 1, 25); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("outsider: %v", err)
	}
	if _, err := h.service.ListActivity(ctx, reader, ids.New(), 1, 25); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("unknown connector: %v", err)
	}
	if _, err := h.service.ListActivity(ctx, reader, h.connector.ID, 1, ActivityMaxPageSize+1); !apperror.IsCode(
		err,
		"validation_failed",
	) {
		t.Fatalf("oversized page: %v", err)
	}
}

func TestHeartbeatPrunesOldActivity(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	h.accepted(ids.New(), "progress", time.Now().UTC().Add(-time.Minute), `{"percent":10}`)
	if _, err := h.pool.Exec(
		ctx,
		`INSERT INTO printer_connector_activity (id, connector_id, kind, occurred_at) VALUES ($1, $2, 'event_ingested', $3)`,
		ids.New(),
		h.connector.ID,
		time.Now().UTC().Add(-ActivityRetention-time.Hour),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := h.service.Heartbeat(ctx, h.connector, Heartbeat{
		SoftwareVersion: "test",
		ProtocolVersion: 1,
		HealthState:     HealthConnected,
	}); err != nil {
		t.Fatal(err)
	}
	page, err := h.service.ListActivity(ctx, h.principal, h.connector.ID, 1, 25)
	if err != nil || page.Total != 1 || page.Items[0].EventKind == nil {
		t.Fatalf("after pruning: %+v %v", page, err)
	}
	// The count limit keeps the newest entries.
	q := h.pool
	if _, err = q.Exec(
		ctx,
		`INSERT INTO printer_connector_activity (id, connector_id, kind, occurred_at)
		 SELECT gen_random_uuid(), $1, 'event_ingested', now() - make_interval(secs => g) FROM generate_series(1, $2::int) g`,
		h.connector.ID,
		ActivityLimitPerConnector+5,
	); err != nil {
		t.Fatal(err)
	}
	if _, err = h.service.Heartbeat(ctx, h.connector, Heartbeat{
		SoftwareVersion: "test",
		ProtocolVersion: 1,
		HealthState:     HealthConnected,
	}); err != nil {
		t.Fatal(err)
	}
	page, err = h.service.ListActivity(ctx, h.principal, h.connector.ID, 1, 1)
	if err != nil || page.Total != ActivityLimitPerConnector || page.Items[0].EventKind == nil {
		t.Fatalf("after the count limit: total=%d %v", page.Total, err)
	}
}
