package printerconnectors

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
)

// principalWith builds a principal that holds exactly the given permissions through a stored role.
func (h *ingestHarness) principalWith(name string, permissions ...authorization.Permission) authorization.Principal {
	h.t.Helper()
	ctx := h.t.Context()
	personID, accountID, roleID := ids.New(), ids.New(), ids.New()
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{
			`INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Tag', 'Reader', $2)`,
			[]any{personID, name + "-" + h.suffix + "@example.test"},
		},
		{`INSERT INTO accounts (id, person_id, status) VALUES ($1, $2, 'enabled')`, []any{accountID, personID}},
		{`INSERT INTO roles (id, name) VALUES ($1, $2)`, []any{roleID, "Tags " + name + " " + h.suffix}},
		{`INSERT INTO person_roles (person_id, role_id) VALUES ($1, $2)`, []any{personID, roleID}},
	} {
		if _, err := h.pool.Exec(ctx, statement.sql, statement.args...); err != nil {
			h.t.Fatal(err)
		}
	}
	for _, permission := range permissions {
		if _, err := h.pool.Exec(
			ctx,
			`INSERT INTO role_permission_grants (id, role_id, permission_id) VALUES ($1, $2, $3)`,
			ids.New(),
			roleID,
			string(permission),
		); err != nil {
			h.t.Fatal(err)
		}
	}
	principal, err := authorization.LoadPermissionsFrom(
		ctx,
		h.pool,
		authorization.Principal{AccountID: accountID, PersonID: personID},
	)
	if err != nil {
		h.t.Fatal(err)
	}
	return principal
}

func (h *ingestHarness) reportSnapshot(observedAt time.Time, snapshot string) {
	h.t.Helper()
	report := h.liveReport(observedAt, "idle")
	report.Snapshot = json.RawMessage(snapshot)
	if err := h.service.ReportLiveStatus(h.t.Context(), h.connector, report); err != nil {
		h.t.Fatal(err)
	}
}

func (h *ingestHarness) detectedFor(principal authorization.Principal) map[string]DetectedSpoolTag {
	h.t.Helper()
	items, err := h.service.ListDetectedSpoolTags(h.t.Context(), principal)
	if err != nil {
		h.t.Fatal(err)
	}
	result := map[string]DetectedSpoolTag{}
	for _, item := range items {
		if item.MachineID == h.machine.ID {
			result[item.TrayExternalID] = item
		}
	}
	return result
}

func tagSnapshot(unitExternal string, trays ...string) string {
	return fmt.Sprintf(
		`{"state":"idle","job":null,"temperatures":{"extruders":[],"bedC":null,"bedTargetC":null,"chamberC":null},`+
			`"nozzles":[],"units":[{"externalId":%q,"kind":"ams","label":"AMS 0","humidityPercent":null,`+
			`"temperatureC":null,"trays":[%s]}],"activeTray":null,"errors":[],"firmwareVersion":null,"wifiSignalDbm":null}`,
		unitExternal,
		strings.Join(trays, ","),
	)
}

func TestListDetectedSpoolTagsRequiresMachinesAndInventoryRead(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	for name, principal := range map[string]authorization.Principal{
		"nothing":        {},
		"machines only":  h.principalWith("machines", authorization.MachinesRead),
		"inventory only": h.principalWith("inventory", authorization.InventoryRead),
	} {
		if _, err := h.service.ListDetectedSpoolTags(ctx, principal); !apperror.IsCode(err, "permission_denied") {
			t.Fatalf("%s: expected permission_denied, got %v", name, err)
		}
	}
	both := h.principalWith("both", authorization.MachinesRead, authorization.InventoryRead)
	if _, err := h.service.ListDetectedSpoolTags(ctx, both); err != nil {
		t.Fatalf("both permissions: %v", err)
	}
}

func TestListDetectedSpoolTagsMapsSlotsAndSpools(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Millisecond)
	slotExternal := "tray-tag-" + h.suffix
	spoolID := h.mountSpool("Tag", &slotExternal, now.Add(-time.Hour))
	tag := "E2C92C29" + strings.ToUpper(h.suffix[:8])
	// The printer reports upper case, the stored identifier uses lower case.
	if _, err := h.logbook.AddFilamentSpoolIdentifier(ctx, h.principal, spoolID, "nfc", strings.ToLower(tag), nil); err != nil {
		t.Fatal(err)
	}
	unit := h.unitExternal("Tag")
	h.reportSnapshot(now, tagSnapshot(
		unit,
		fmt.Sprintf(
			`{"externalId":%q,"materialType":"PLA","subBrand":"PLA Basic","colorHex":"FFF144","remainPercent":55,`+
				`"rfid":true,"tagUid":%q,"empty":false}`,
			slotExternal, tag,
		),
		`{"externalId":"9","materialType":"PETG","subBrand":null,"colorHex":null,"remainPercent":null,`+
			`"rfid":true,"tagUid":"UNMAPPED-`+h.suffix+`","empty":false}`,
		`{"externalId":"8","materialType":null,"subBrand":null,"colorHex":null,"remainPercent":null,`+
			`"rfid":false,"tagUid":"EMPTY-TRAY","empty":true}`,
		`{"externalId":"7","materialType":"PLA","subBrand":null,"colorHex":null,"remainPercent":null,`+
			`"rfid":false,"empty":false}`,
	))
	reader := h.principalWith("reader", authorization.MachinesRead, authorization.InventoryRead)
	found := h.detectedFor(reader)
	if len(found) != 2 {
		t.Fatalf("expected the mapped and the unmapped tray only, got %+v", found)
	}
	mapped := found[slotExternal]
	if mapped.TagUID != tag || mapped.MachineName != h.machine.Name || mapped.UnitExternalID != unit ||
		mapped.UnitLabel != "AMS 0" || mapped.SlotID == nil || mapped.SlotName == nil || *mapped.SlotName != "Slot Tag" ||
		mapped.InputUnitName == nil || *mapped.InputUnitName != "Unit Tag" ||
		mapped.MaterialType == nil || *mapped.MaterialType != "PLA" || mapped.RemainPercent == nil ||
		*mapped.RemainPercent != 55 || !mapped.ObservedAt.Equal(now) {
		t.Fatalf("mapped tray = %+v", mapped)
	}
	if mapped.Spool == nil || mapped.Spool.ID != spoolID || !strings.HasPrefix(mapped.Spool.DisplayID, "S-") {
		t.Fatalf("spool match = %+v", mapped.Spool)
	}
	unmapped := found["9"]
	if unmapped.SlotID != nil || unmapped.SlotName != nil || unmapped.InputUnitName != nil || unmapped.Spool != nil {
		t.Fatalf("unmapped tray = %+v", unmapped)
	}

	// A retired identifier no longer matches.
	if _, err := h.pool.Exec(
		ctx,
		`UPDATE filament_spool_identifiers SET retired_at = now() WHERE spool_id = $1 AND kind = 'nfc'`,
		spoolID,
	); err != nil {
		t.Fatal(err)
	}
	if got := h.detectedFor(reader)[slotExternal]; got.Spool != nil {
		t.Fatalf("retired identifier matched: %+v", got.Spool)
	}
}

func TestListDetectedSpoolTagsSkipsDisabledAndEndedAssignments(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Millisecond)
	tray := `{"externalId":"0","materialType":"PLA","subBrand":null,"colorHex":null,"remainPercent":null,` +
		`"rfid":true,"tagUid":"SKIP-ME","empty":false}`
	for name, update := range map[string]string{
		"disabled": `UPDATE printer_connector_assignments SET enabled = false WHERE id = $1`,
		"ended":    `UPDATE printer_connector_assignments SET enabled = false, ended_at = now() WHERE id = $1`,
	} {
		t.Run(name, func(t *testing.T) {
			h := newIngestHarness(t)
			h.reportSnapshot(now, tagSnapshot("0", tray))
			reader := h.principalWith("skip", authorization.MachinesRead, authorization.InventoryRead)
			if len(h.detectedFor(reader)) != 1 {
				t.Fatal("the tag of an active assignment must be listed")
			}
			if _, err := h.pool.Exec(t.Context(), update, h.assignment.ID); err != nil {
				t.Fatal(err)
			}
			if got := h.detectedFor(reader); len(got) != 0 {
				t.Fatalf("%s assignment still listed: %+v", name, got)
			}
		})
	}
}

func TestListDetectedSpoolTagsAcceptsSnapshotsWithoutTagUID(t *testing.T) {
	h := newIngestHarness(t)
	now := time.Now().UTC().Truncate(time.Millisecond)
	// Snapshots stored by connectors before tagUid existed.
	h.reportSnapshot(now, tagSnapshot(
		"0",
		`{"externalId":"0","materialType":"PLA","subBrand":null,"colorHex":null,"remainPercent":null,`+
			`"rfid":true,"empty":false}`,
	))
	reader := h.principalWith("legacy", authorization.MachinesRead, authorization.InventoryRead)
	if got := h.detectedFor(reader); len(got) != 0 {
		t.Fatalf("a snapshot without tagUid must yield no tags: %+v", got)
	}
	if _, err := h.service.LiveStatus(t.Context(), reader, h.machine.ID); err != nil {
		t.Fatal(err)
	}
}
