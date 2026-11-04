package printerconnectors

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

// autoDetect turns on automatic spool detection for the harness's assignment.
func (h *ingestHarness) autoDetect() {
	h.t.Helper()
	if _, err := h.pool.Exec(
		h.t.Context(),
		`UPDATE printer_connector_assignments SET adapter_kind='bambu_h2d',settings=$2::jsonb WHERE id=$1`,
		h.assignment.ID,
		`{"ipAddress":"192.168.1.42","serialNumber":"01P00A123456789","autoDetectSpools":true}`,
	); err != nil {
		h.t.Fatal(err)
	}
}

// observeBambuSlot sends a slot observation with the given JSON fields besides the slot's address.
func (h *ingestHarness) observeBambuSlot(name, slotExternal string, at time.Time, fields string) {
	h.t.Helper()
	h.sequence++
	receipt := h.sendEvent(EventInput{
		EventID:              ids.New(),
		AssignmentID:         h.assignment.ID,
		ConfigurationVersion: h.assignment.ConfigurationVersion,
		Sequence:             h.sequence,
		OccurredAt:           at,
		Kind:                 "slot_observation",
		Payload: json.RawMessage(fmt.Sprintf(
			`{"inputUnitExternalId":%q,"slotExternalId":%q,%s}`, h.unitExternal(name), slotExternal, fields,
		)),
	})
	if receipt.Status != "accepted" {
		h.t.Fatalf("slot observation receipt = %+v", receipt)
	}
}

// openMountSpool is the spool open in the slot of the named unit, or uuid.Nil.
func (h *ingestHarness) openMountSpool(slotExternal string) uuid.UUID {
	h.t.Helper()
	var spoolID uuid.UUID
	err := h.pool.QueryRow(
		h.t.Context(),
		`SELECT a.spool_id FROM printer_spool_assignments a JOIN printer_slots s ON s.id=a.slot_id
		 JOIN printer_input_units u ON u.id=s.input_unit_id
		 WHERE u.machine_id=$1 AND s.external_identifier=$2 AND a.unmounted_at IS NULL`,
		h.machine.ID,
		slotExternal,
	).Scan(&spoolID)
	if err != nil {
		return uuid.Nil
	}
	return spoolID
}

// unmountSpool closes the open mounts of the spool so that an observation has to mount it again.
func (h *ingestHarness) unmountSpool(spoolID uuid.UUID, at time.Time) {
	h.t.Helper()
	if _, err := h.pool.Exec(
		h.t.Context(),
		`UPDATE printer_spool_assignments SET unmounted_at=$2 WHERE spool_id=$1 AND unmounted_at IS NULL`,
		spoolID,
		at,
	); err != nil {
		h.t.Fatal(err)
	}
}

func TestIngestAutoMountsASpoolByTrayUUIDWhicheverChipIsRead(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	at := time.Now().UTC().Truncate(time.Second).Add(-10 * time.Minute)
	slotExternal := "tray-uuid-" + h.suffix
	spoolID := h.mountSpool("TrayUUID", &slotExternal, at.Add(-time.Hour))
	h.unmountSpool(spoolID, at.Add(-30*time.Minute))
	trayUUID := strings.ToUpper(strings.ReplaceAll(uuid.NewString(), "-", ""))
	// The printer reports upper case, the stored identifier may use lower case.
	if _, err := h.logbook.AddFilamentSpoolIdentifier(
		ctx, h.principal, spoolID, "bambu_tray_uuid", strings.ToLower(trayUUID), nil,
	); err != nil {
		t.Fatal(err)
	}
	h.autoDetect()

	chipA, chipB := "CAD2E2DC"+strings.ToUpper(h.suffix[:8]), "7A99DCDC"+strings.ToUpper(h.suffix[:8])
	h.observeBambuSlot("TrayUUID", slotExternal, at, `"tagUid":"`+chipA+`","trayUuid":"`+trayUUID+`"`)
	if got := h.openMountSpool(slotExternal); got != spoolID {
		t.Fatalf("first chip mounted %s, want %s", got, spoolID)
	}
	h.unmountSpool(spoolID, at.Add(time.Minute))
	h.observeBambuSlot("TrayUUID", slotExternal, at.Add(2*time.Minute),
		`"tagUid":"`+chipB+`","trayUuid":"`+trayUUID+`"`)
	if got := h.openMountSpool(slotExternal); got != spoolID {
		t.Fatalf("second chip mounted %s, want %s", got, spoolID)
	}
	// The tray UUID alone, without a readable chip UID, identifies the spool too.
	h.unmountSpool(spoolID, at.Add(3*time.Minute))
	h.observeBambuSlot("TrayUUID", slotExternal, at.Add(4*time.Minute), `"trayUuid":"`+trayUUID+`"`)
	if got := h.openMountSpool(slotExternal); got != spoolID {
		t.Fatalf("tray UUID alone mounted %s, want %s", got, spoolID)
	}
	// A slot may not carry both an empty marker and an identity.
	h.unmountSpool(spoolID, at.Add(5*time.Minute))
	h.observeBambuSlot("TrayUUID", slotExternal, at.Add(6*time.Minute), `"empty":true,"trayUuid":"`+trayUUID+`"`)
	if got := h.openMountSpool(slotExternal); got != uuid.Nil {
		t.Fatalf("an empty slot with an identity must be ignored, mounted %s", got)
	}
}

func TestIngestAutoMountFallsBackToTheChipUIDAsNFC(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	at := time.Now().UTC().Truncate(time.Second).Add(-10 * time.Minute)
	slotExternal := "tray-nfc-fallback-" + h.suffix
	spoolID := h.mountSpool("NFCFallback", &slotExternal, at.Add(-time.Hour))
	h.unmountSpool(spoolID, at.Add(-30*time.Minute))
	chip := "95AF7205" + strings.ToUpper(h.suffix[:8])
	if _, err := h.logbook.AddFilamentSpoolIdentifier(ctx, h.principal, spoolID, "nfc", chip, nil); err != nil {
		t.Fatal(err)
	}
	h.autoDetect()

	// A spool registered with its chip UID keeps matching when the printer also reports a tray UUID no spool carries,
	// and when it reports none.
	h.observeBambuSlot("NFCFallback", slotExternal, at,
		`"tagUid":"`+chip+`","trayUuid":"00112233445566778899AABBCCDDEEFF"`)
	if got := h.openMountSpool(slotExternal); got != spoolID {
		t.Fatalf("fallback mounted %s, want %s", got, spoolID)
	}
	h.unmountSpool(spoolID, at.Add(time.Minute))
	h.observeBambuSlot("NFCFallback", slotExternal, at.Add(2*time.Minute), `"tagUid":"`+chip+`"`)
	if got := h.openMountSpool(slotExternal); got != spoolID {
		t.Fatalf("chip UID alone mounted %s, want %s", got, spoolID)
	}
}

func TestListDetectedSpoolTagsReportsTrayUUIDs(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Millisecond)
	slotExternal := "tray-detected-" + h.suffix
	spoolID := h.mountSpool("Detected", &slotExternal, now.Add(-time.Hour))
	trayUUID := strings.ToUpper(strings.ReplaceAll(uuid.NewString(), "-", ""))
	if _, err := h.logbook.AddFilamentSpoolIdentifier(
		ctx, h.principal, spoolID, "bambu_tray_uuid", strings.ToLower(trayUUID), nil,
	); err != nil {
		t.Fatal(err)
	}
	nfcSpool := h.mountSpool("DetectedNFC", nil, now.Add(-time.Hour))
	chip := "12424729" + strings.ToUpper(h.suffix[:8])
	if _, err := h.logbook.AddFilamentSpoolIdentifier(ctx, h.principal, nfcSpool, "nfc", chip, nil); err != nil {
		t.Fatal(err)
	}
	h.reportSnapshot(now, tagSnapshot(
		h.unitExternal("Detected"),
		// A tray with a chip UID and the tray UUID of a registered spool.
		fmt.Sprintf(`{"externalId":%q,"materialType":"PLA","subBrand":null,"colorHex":null,"remainPercent":null,`+
			`"rfid":true,"tagUid":"CAD2E2DC0000010%s","trayUuid":%q,"empty":false}`, slotExternal, "0", trayUUID),
		// A tray with only a tray UUID.
		`{"externalId":"6","materialType":"PETG","subBrand":null,"colorHex":null,"remainPercent":null,`+
			`"rfid":true,"trayUuid":"AAAA`+strings.ToUpper(h.suffix)+`","empty":false}`,
		// A tray whose tray UUID is unknown but whose chip UID is a registered nfc identifier.
		fmt.Sprintf(`{"externalId":"7","materialType":"PLA","subBrand":null,"colorHex":null,"remainPercent":null,`+
			`"rfid":true,"tagUid":%q,"trayUuid":"BBBB%s","empty":false}`, chip, strings.ToUpper(h.suffix)),
		// The same physical spool in a second tray, observed through its other chip.
		fmt.Sprintf(`{"externalId":"8","materialType":"PLA","subBrand":null,"colorHex":null,"remainPercent":null,`+
			`"rfid":true,"tagUid":"7A99DCDC00000100","trayUuid":%q,"empty":false}`, "aaaa"+strings.ToUpper(h.suffix)),
		// Neither identity: not listed.
		`{"externalId":"9","materialType":"PLA","subBrand":null,"colorHex":null,"remainPercent":null,`+
			`"rfid":true,"empty":false}`,
	))
	reader := h.principalWith("traydetect", authorization.MachinesRead, authorization.InventoryRead)
	found := h.detectedFor(reader)
	if len(found) != 3 {
		t.Fatalf("expected three trays (one repeated spool dropped), got %+v", found)
	}
	mapped := found[slotExternal]
	if mapped.TagUID == nil || *mapped.TagUID != "CAD2E2DC00000100" || mapped.TrayUUID == nil ||
		*mapped.TrayUUID != trayUUID || mapped.Spool == nil || mapped.Spool.ID != spoolID {
		t.Fatalf("tray UUID match = %+v", mapped)
	}
	onlyUUID := found["6"]
	if onlyUUID.TagUID != nil || onlyUUID.TrayUUID == nil || onlyUUID.Spool != nil {
		t.Fatalf("tray with only a tray UUID = %+v", onlyUUID)
	}
	fallback := found["7"]
	if fallback.Spool == nil || fallback.Spool.ID != nfcSpool {
		t.Fatalf("nfc fallback = %+v", fallback.Spool)
	}
	// 6 and 8 carry the same tray UUID in different case; one of them is dropped, the newest observation wins and
	// the observation times are equal, so the first remains.
	if _, repeated := found["8"]; repeated {
		t.Fatalf("the same spool was listed twice: %+v", found)
	}
}

func TestIngestResolvesTheReportedSpoolByTrayUUIDAtTheReportedTime(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	t0 := time.Now().UTC().Truncate(time.Second).Add(-2 * time.Hour)
	spoolID := h.mountSpool("Hist", nil, t0.Add(-time.Hour))
	trayUUID := strings.ToUpper(strings.ReplaceAll(uuid.NewString(), "-", ""))
	chip := "95AF7205" + strings.ToUpper(h.suffix[:8])
	for kind, value := range map[string]string{"bambu_tray_uuid": trayUUID, "nfc": chip} {
		if _, err := h.logbook.AddFilamentSpoolIdentifier(ctx, h.principal, spoolID, machinelogbook.IdentifierKind(kind), value, nil); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.pool.Exec(ctx, `UPDATE filament_spool_identifiers SET created_at=$2 WHERE spool_id=$1`,
		spoolID, t0.Add(-30*time.Minute)); err != nil {
		t.Fatal(err)
	}
	for name, fields := range map[string]string{
		"tray UUID":                     `"trayUuid":"` + strings.ToLower(trayUUID) + `"`,
		"other chip, same tray UUID":    `"tagUid":"7A99DCDC00000100","trayUuid":"` + trayUUID + `"`,
		"unknown tray UUID, known chip": `"tagUid":"` + chip + `","trayUuid":"00112233445566778899AABBCCDDEEFF"`,
		"chip only":                     `"tagUid":"` + chip + `"`,
	} {
		runID := ids.New()
		h.accepted(runID, "progress", t0, `{"percent":10}`)
		h.report(runID, t0.Add(time.Minute), `{"quantityGrams":"5","quantityBasis":"actual",`+fields+`}`, 1)
		if run := h.run(runID); run.spoolID == nil || *run.spoolID != spoolID {
			t.Fatalf("%s resolved to %v, want %s", name, run.spoolID, spoolID)
		}
	}
	// Before the identifiers existed, nothing resolves.
	early := ids.New()
	h.accepted(early, "progress", t0.Add(-2*time.Hour), `{"percent":10}`)
	h.report(early, t0.Add(-time.Hour), `{"quantityGrams":"5","quantityBasis":"actual","trayUuid":"`+trayUUID+`"}`, 1)
	if run := h.run(early); run.spoolID != nil {
		t.Fatalf("a spool resolved before its identifier existed: %+v", run)
	}
}
