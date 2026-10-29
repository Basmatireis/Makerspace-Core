package printerconnectors

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
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

func TestIngestPrinterErrorNotifiesReadersAndTheOperatorOnce(t *testing.T) {
	h := newIngestHarness(t)
	t0 := time.Now().UTC().Truncate(time.Second).Add(-time.Hour)
	reader := h.principalWith("reader", authorization.PrinterConnectorsRead)
	bystander := h.principalWith("bystander", authorization.MachineJobsRead)
	h.cleanupNotifications(reader.AccountID, bystander.AccountID, h.principal.AccountID)
	runID := h.runWithOperator(t0)

	appeared := `{"transition":"appeared","sourceFamily":"hms","code":"0300-0D00-0001-0001"}`
	h.accepted(runID, EventPrinterError, t0.Add(time.Minute), appeared)
	// The same open error reported again, and its clearing, say nothing new.
	h.accepted(runID, EventPrinterError, t0.Add(2*time.Minute), appeared)
	h.accepted(runID, EventPrinterError, t0.Add(3*time.Minute), `{"transition":"cleared","sourceFamily":"hms","code":"0300-0D00-0001-0001"}`)

	titles, bodies, links := h.notifications(reader.AccountID, "printer_error")
	if len(titles) != 1 || titles[0] != "Printer error on "+h.machine.Name ||
		!strings.Contains(bodies[0], "0300-0D00-0001-0001") || !strings.Contains(bodies[0], "during run R-") ||
		links[0] != "/machine-logbook/machines/"+h.machine.ID.String()+"?tab=printer" {
		t.Fatalf("reader notifications: %q %q %q", titles, bodies, links)
	}
	if operator, _, _ := h.notifications(h.principal.AccountID, "printer_error"); len(operator) != 1 {
		t.Fatalf("operator notifications = %q, want one", operator)
	}
	if other, _, _ := h.notifications(bystander.AccountID, "printer_error"); len(other) != 0 {
		t.Fatalf("bystander notifications = %q, want none", other)
	}
	// A different error is told again, and so is the same error once it was cleared.
	h.accepted(runID, EventPrinterError, t0.Add(4*time.Minute), `{"transition":"appeared","sourceFamily":"print_error","code":"83902465"}`)
	h.accepted(runID, EventPrinterError, t0.Add(5*time.Minute), appeared)
	if titles, _, _ = h.notifications(reader.AccountID, "printer_error"); len(titles) != 3 {
		t.Fatalf("reader notifications after new errors = %q, want three", titles)
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
