package printerconnectors

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

// notifications returns the titles and bodies of one account's notifications of a kind, oldest first.
func (h *ingestHarness) notifications(accountID uuid.UUID, kind string) (titles, bodies, links []string) {
	h.t.Helper()
	rows, err := h.pool.Query(
		h.t.Context(),
		`SELECT n.title, n.body, n.link FROM inbox_recipients r JOIN inbox_notifications n ON n.id = r.notification_id
		 WHERE r.account_id = $1 AND n.kind = $2 ORDER BY n.created_at, n.id`,
		accountID, kind,
	)
	if err != nil {
		h.t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var title, body string
		var link *string
		if err := rows.Scan(&title, &body, &link); err != nil {
			h.t.Fatal(err)
		}
		titles, bodies = append(titles, title), append(bodies, body)
		if link != nil {
			links = append(links, *link)
		}
	}
	return titles, bodies, links
}

func (h *ingestHarness) cleanupNotifications(accountIDs ...uuid.UUID) {
	h.t.Cleanup(func() {
		for _, id := range accountIDs {
			_, _ = h.pool.Exec(
				context.Background(),
				`DELETE FROM inbox_notifications WHERE id IN (SELECT notification_id FROM inbox_recipients WHERE account_id = $1)`,
				id,
			)
		}
	})
}

// runWithOperator starts a recorded run and makes the harness principal the operator of its job.
func (h *ingestHarness) runWithOperator(at time.Time) uuid.UUID {
	h.t.Helper()
	runID := ids.New()
	h.accepted(runID, "progress", at, `{"state":"printing","percent":10,"remainingSeconds":3600}`)
	group, err := h.logbook.CreatePricingGroup(h.t.Context(), h.principal, "Notice pricing "+h.suffix, nil, false, nil)
	if err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.logbook.CreateJobFromRun(
		h.t.Context(),
		h.principal,
		runID,
		machinelogbook.RunJobInput{
			Customer:         machinelogbook.PartyReference{Kind: "person", ID: h.principal.PersonID},
			OperatorPersonID: h.principal.PersonID,
			PricingGroupID:   &group.ID,
		},
		nil,
	); err != nil {
		h.t.Fatal(err)
	}
	return runID
}

func TestIngestPrinterErrorNotifiesTheOperatorAndTheChosenRoleOnce(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	t0 := time.Now().UTC().Truncate(time.Second).Add(-time.Hour)
	supervisor := h.principalWith("supervisor", authorization.MachinesRead)
	reader := h.principalWith("reader", authorization.PrinterConnectorsRead)
	h.cleanupNotifications(supervisor.AccountID, reader.AccountID, h.principal.AccountID)
	var roleID uuid.UUID
	if err := h.pool.QueryRow(ctx, `SELECT role_id FROM person_roles WHERE person_id = $1`, supervisor.PersonID).Scan(&roleID); err != nil {
		t.Fatal(err)
	}
	// The chosen role is told from "serious" on; the test resets the singleton afterwards.
	if _, err := h.pool.Exec(ctx, `UPDATE printer_notification_rules SET role_id = $1, min_severity = 'serious' WHERE event = 'printer_error'`, roleID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = h.pool.Exec(context.Background(), `UPDATE printer_notification_rules SET role_id = NULL, min_severity = 'serious' WHERE event = 'printer_error'`)
	})
	if _, err := h.pool.Exec(ctx, `INSERT INTO printer_error_codes (id, source_family, code, title) VALUES ($1, 'hms', '0300-0D00-0002-0001', 'Filament ran out')
		ON CONFLICT (source_family, code) DO UPDATE SET title = EXCLUDED.title`, ids.New()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = h.pool.Exec(context.Background(), `DELETE FROM printer_error_codes WHERE code = '0300-0D00-0002-0001'`)
	})
	runID := h.runWithOperator(t0)

	appeared := `{"transition":"appeared","sourceFamily":"hms","code":"0300-0D00-0002-0001"}`
	h.accepted(runID, EventPrinterError, t0.Add(time.Minute), appeared)
	// The same open error reported again, and its clearing, say nothing new.
	h.accepted(runID, EventPrinterError, t0.Add(2*time.Minute), appeared)
	h.accepted(runID, EventPrinterError, t0.Add(3*time.Minute), `{"transition":"cleared","sourceFamily":"hms","code":"0300-0D00-0002-0001"}`)
	// A notice below the minimum severity (third group 0004 = info) stays quiet.
	h.accepted(runID, EventPrinterError, t0.Add(4*time.Minute), `{"transition":"appeared","sourceFamily":"hms","code":"0500-0100-0004-0001"}`)

	titles, bodies, links := h.notifications(supervisor.AccountID, "printer_error")
	if len(titles) != 1 || titles[0] != "Printer error on "+h.machine.Name ||
		!strings.Contains(bodies[0], "0300-0D00-0002-0001 (serious): Filament ran out") || !strings.Contains(bodies[0], "during run R-") ||
		links[0] != "/machine-logbook/machines/"+h.machine.ID.String()+"?tab=printer" {
		t.Fatalf("role holder notifications: %q %q %q", titles, bodies, links)
	}
	if operator, _, _ := h.notifications(h.principal.AccountID, "printer_error"); len(operator) != 1 {
		t.Fatalf("operator notifications = %q, want one", operator)
	}
	if other, _, _ := h.notifications(reader.AccountID, "printer_error"); len(other) != 0 {
		t.Fatalf("connector reader notifications = %q, want none", other)
	}
	// A print error has no level and is always announced; the same HMS error is told again once it reappears.
	h.accepted(runID, EventPrinterError, t0.Add(5*time.Minute), `{"transition":"appeared","sourceFamily":"print","code":"07FF8003"}`)
	h.accepted(runID, EventPrinterError, t0.Add(6*time.Minute), appeared)
	if titles, _, _ = h.notifications(supervisor.AccountID, "printer_error"); len(titles) != 3 {
		t.Fatalf("role holder notifications after new errors = %q, want three", titles)
	}
	var severity *string
	if err := h.pool.QueryRow(ctx, `SELECT severity FROM printer_error_occurrences WHERE run_id = $1 AND original_code = '0300-0D00-0002-0001' ORDER BY first_observed_at DESC LIMIT 1`, runID).Scan(&severity); err != nil || severity == nil || *severity != "serious" {
		t.Fatalf("stored severity = %v, %v", severity, err)
	}
}

func TestPrinterErrorsAreListedDescribedAndCleared(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	t0 := time.Now().UTC().Truncate(time.Second).Add(-time.Hour)
	runID := h.runWithOperator(t0)
	h.cleanupNotifications(h.principal.AccountID)
	h.accepted(runID, EventPrinterError, t0.Add(time.Minute), `{"transition":"appeared","sourceFamily":"hms","code":"0300-0D00-0001-0001"}`)
	h.accepted(runID, EventPrinterError, t0.Add(2*time.Minute), `{"transition":"appeared","sourceFamily":"print","code":"07FF8003"}`)
	h.accepted(runID, EventPrinterError, t0.Add(3*time.Minute), `{"transition":"cleared","sourceFamily":"print","code":"07FF8003"}`)

	reader := h.principalWith("lister", authorization.MachinesRead)
	errorsListed, err := h.service.ListPrinterErrors(ctx, reader, h.machine.ID)
	if err != nil || len(errorsListed) != 2 {
		t.Fatalf("listed errors = %+v, %v", errorsListed, err)
	}
	open, resolved := errorsListed[0], errorsListed[1]
	if open.Code != "0300-0D00-0001-0001" || open.ResolvedAt != nil || open.Severity == nil || *open.Severity != "fatal" ||
		open.Link == nil || *open.Link != "https://wiki.bambulab.com/en/x1/troubleshooting/hmscode/0300_0D00_0001_0001" ||
		open.Title != nil || open.RunID == nil || *open.RunID != runID {
		t.Fatalf("open error = %+v", open)
	}
	if resolved.Code != "07FF8003" || resolved.ResolvedAt == nil || resolved.Severity != nil || resolved.Link != nil {
		t.Fatalf("resolved error = %+v", resolved)
	}
	if _, err = h.service.ListPrinterErrors(ctx, reader, ids.New()); !apperror.IsCode(err, "not_found") {
		t.Fatalf("unknown machine: %v", err)
	}
	if _, err = h.service.PutErrorCode(ctx, reader, "hms", "0300-0D00-0001-0001", ErrorCodeInput{Title: "x"}, nil); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("catalog without manage: %v", err)
	}
	custom := "https://example.org/help"
	code, err := h.service.PutErrorCode(ctx, h.principal, "hms", "0300-0D00-0001-0001", ErrorCodeInput{
		Title: "  AMS  motor stalled ", Description: "Open the AMS lid and free the spool.", Link: &custom,
	}, nil)
	if err != nil || code.Title != "AMS motor stalled" || code.Link == nil || *code.Link != custom {
		t.Fatalf("saved code = %+v, %v", code, err)
	}
	t.Cleanup(func() {
		_, _ = h.pool.Exec(context.Background(), `DELETE FROM printer_error_codes WHERE code = '0300-0D00-0001-0001'`)
	})
	bad := "http://insecure.example"
	if _, err = h.service.PutErrorCode(ctx, h.principal, "hms", "0300-0D00-0001-0001", ErrorCodeInput{Title: "x", Link: &bad}, nil); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("insecure link: %v", err)
	}
	errorsListed, err = h.service.ListPrinterErrors(ctx, reader, h.machine.ID)
	if err != nil || errorsListed[0].Title == nil || *errorsListed[0].Title != "AMS motor stalled" || *errorsListed[0].Link != custom {
		t.Fatalf("described error = %+v, %v", errorsListed[0], err)
	}
	facts, err := h.service.ErrorFacts(ctx, [][2]string{{"hms", "0300-0D00-0001-0001"}, {"hms", "0501-0400-0003-0002"}})
	if err != nil || *facts["hms:0300-0D00-0001-0001"].Title != "AMS motor stalled" || *facts["hms:0501-0400-0003-0002"].Severity != "common" ||
		facts["hms:0501-0400-0003-0002"].Title != nil {
		t.Fatalf("facts = %+v, %v", facts, err)
	}

	if err = h.service.ClearPrinterErrors(ctx, reader, h.machine.ID, nil); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("clear without manage: %v", err)
	}
	if err = h.service.ClearPrinterErrors(ctx, h.principal, h.machine.ID, nil); err != nil {
		t.Fatal(err)
	}
	var remaining int
	if err = h.pool.QueryRow(ctx, `SELECT count(*) FROM printer_error_occurrences WHERE machine_id = $1`, h.machine.ID).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("occurrences after clearing = %d, %v", remaining, err)
	}
	var audited int
	if err = h.pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action = 'printer_errors.cleared' AND resource_id = $1`, h.machine.ID).Scan(&audited); err != nil || audited != 1 {
		t.Fatalf("clear audit events = %d, %v", audited, err)
	}

	fatal := "fatal"
	errorRule := NotificationRule{Event: NotifyPrinterError, NotifyOperator: true, MinSeverity: &fatal}
	settings, err := h.service.UpdateNotificationSettings(ctx, h.principal, NotificationSettingsInput{Events: []NotificationRule{errorRule}, ExpectedVersion: 1}, nil)
	if err != nil || len(settings.Events) != 3 || settings.Events[0].MinSeverity == nil || *settings.Events[0].MinSeverity != "fatal" ||
		settings.Events[0].RoleID != nil || settings.Version != 2 {
		t.Fatalf("settings = %+v, %v", settings, err)
	}
	t.Cleanup(func() {
		_, _ = h.pool.Exec(context.Background(), `UPDATE printer_notification_rules SET role_id = NULL, min_severity = 'serious', notify_operator = true, notify_recipient = false, email = false`)
		_, _ = h.pool.Exec(context.Background(), `UPDATE printer_notification_rules SET min_severity = NULL WHERE event <> 'printer_error'`)
		_, _ = h.pool.Exec(context.Background(), `UPDATE printer_notification_settings SET version = 1`)
	})
	if _, err = h.service.UpdateNotificationSettings(ctx, h.principal, NotificationSettingsInput{Events: []NotificationRule{errorRule}, ExpectedVersion: 1}, nil); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale settings write: %v", err)
	}
	unknown := ids.New()
	if _, err = h.service.UpdateNotificationSettings(ctx, h.principal, NotificationSettingsInput{
		Events: []NotificationRule{{Event: NotifyRunFinished, RoleID: &unknown}}, ExpectedVersion: 2,
	}, nil); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("unknown role: %v", err)
	}
	// A minimum severity only filters printer errors, and every event appears at most once.
	for name, events := range map[string][]NotificationRule{
		"severity on run_finished": {{Event: NotifyRunFinished, MinSeverity: &fatal}},
		"repeated event":           {{Event: NotifyFilamentChange}, {Event: NotifyFilamentChange}},
		"unknown event":            {{Event: "door_opened"}},
		"empty":                    {},
	} {
		if _, err = h.service.UpdateNotificationSettings(ctx, h.principal, NotificationSettingsInput{Events: events, ExpectedVersion: 2}, nil); !apperror.IsCode(err, "validation_failed") {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if _, err = h.service.UpdateNotificationSettings(ctx, authorization.Principal{AccountID: h.principal.AccountID}, NotificationSettingsInput{
		Events: []NotificationRule{errorRule}, ExpectedVersion: 2,
	}, nil); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("update without machines.manage: %v", err)
	}
	if _, err = h.service.NotificationSettings(ctx, authorization.Principal{AccountID: h.principal.AccountID}); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("read without machines.read: %v", err)
	}
	if err = h.service.DeleteErrorCode(ctx, h.principal, "hms", "0300-0D00-0001-0001", nil); err != nil {
		t.Fatal(err)
	}
	if err = h.service.DeleteErrorCode(ctx, h.principal, "hms", "0300-0D00-0001-0001", nil); !apperror.IsCode(err, "not_found") {
		t.Fatalf("second delete: %v", err)
	}
}

func TestIngestSlotObservationsTellTheOperatorAboutFilamentChanges(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	t0 := time.Now().UTC().Truncate(time.Second).Add(-time.Hour)
	slot := "tray-f-" + h.suffix
	mounted := h.mountSpool("F", &slot, t0.Add(-time.Hour))
	otherSlot := "tray-g-" + h.suffix
	known := h.mountSpool("G", &otherSlot, t0.Add(-time.Hour))
	tag := "A1B2C3D4" + strings.ToUpper(h.suffix[:8])
	if _, err := h.logbook.AddFilamentSpoolIdentifier(ctx, h.principal, known, "nfc", tag, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(
		ctx,
		`UPDATE printer_connector_assignments SET adapter_kind='bambu_h2d',settings=$2::jsonb WHERE id=$1`,
		h.assignment.ID,
		`{"ipAddress":"192.168.1.42","serialNumber":"01P00A123456789"}`,
	); err != nil {
		t.Fatal(err)
	}
	h.cleanupNotifications(h.principal.AccountID)
	observe := func(at time.Time, historyComplete bool, payload string) {
		t.Helper()
		h.sequence++
		receipt := h.sendEvent(EventInput{
			EventID:              ids.New(),
			AssignmentID:         h.assignment.ID,
			HistoryComplete:      historyComplete,
			ConfigurationVersion: h.assignment.ConfigurationVersion,
			Sequence:             h.sequence,
			OccurredAt:           at,
			Kind:                 "slot_observation",
			Payload: json.RawMessage(
				`{"inputUnitExternalId":"` + h.unitExternal("F") + `","slotExternalId":"` + slot + `",` + payload + `}`,
			),
		})
		if receipt.Status != "accepted" {
			t.Fatalf("slot observation receipt = %+v %s", receipt, *receipt.ReasonCode)
		}
	}

	// Without a running print nobody is told.
	observe(t0.Add(-30*time.Minute), true, `"empty":true`)
	h.runWithOperator(t0)
	// A connector that is still catching up after a start does not announce old changes.
	observe(t0.Add(time.Minute), false, `"tagUid":"FFFFFFFF","trayType":"PLA"`)
	if titles, _, _ := h.notifications(h.principal.AccountID, "filament_change"); len(titles) != 0 {
		t.Fatalf("notifications before any live change = %q", titles)
	}

	observe(t0.Add(2*time.Minute), true, `"empty":true`)
	observe(t0.Add(3*time.Minute), true, `"tagUid":"0123456789ABCDEF","trayType":"PLA","color":"FF0000FF"`)
	observe(t0.Add(4*time.Minute), true, `"tagUid":"`+tag+`"`)
	if _, err := h.pool.Exec(
		ctx, `UPDATE printer_spool_assignments SET unmounted_at=$2 WHERE spool_id=$1 AND unmounted_at IS NULL`,
		mounted, t0.Add(5*time.Minute),
	); err != nil {
		t.Fatal(err)
	}
	observe(t0.Add(6*time.Minute), true, `"empty":true,"trayType":"PETG","productName":"PETG Basic"`)

	titles, bodies, links := h.notifications(h.principal.AccountID, "filament_change")
	want := []string{
		"Spool removed from " + h.machine.Name,
		"New material on " + h.machine.Name,
		"Spool loaded on " + h.machine.Name,
		"Material without tag on " + h.machine.Name,
	}
	if strings.Join(titles, "|") != strings.Join(want, "|") {
		t.Fatalf("filament notifications = %q, want %q", titles, want)
	}
	var mountedDisplay, knownDisplay string
	if err := h.pool.QueryRow(ctx, `SELECT display_id FROM filament_spools WHERE id=$1`, mounted).Scan(&mountedDisplay); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(ctx, `SELECT display_id FROM filament_spools WHERE id=$1`, known).Scan(&knownDisplay); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(bodies[0], mountedDisplay) || !strings.Contains(bodies[0], "Unit F · Slot F") ||
		!strings.Contains(bodies[1], "PLA #FF0000") || !strings.Contains(bodies[1], "belongs to no spool") ||
		!strings.Contains(bodies[2], knownDisplay) ||
		!strings.Contains(bodies[3], "(PETG Basic)") || !strings.Contains(bodies[3], "by hand") {
		t.Fatalf("filament notification bodies = %q", bodies)
	}
	for _, link := range links {
		if link != "/machine-logbook/machines/"+h.machine.ID.String()+"?tab=printer" {
			t.Fatalf("filament notification link = %q", link)
		}
	}
}
