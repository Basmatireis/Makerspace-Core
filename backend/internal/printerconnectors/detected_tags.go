package printerconnectors

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors/db"
	"github.com/google/uuid"
)

const maximumDetectedTagLength = 255

// DetectedSpoolTag is one RFID/NFC tag a connected printer currently reads from a loaded tray.
type DetectedSpoolTag struct {
	MachineID      uuid.UUID
	MachineName    string
	UnitExternalID string
	UnitLabel      string
	TrayExternalID string
	SlotID         *uuid.UUID
	SlotName       *string
	InputUnitName  *string
	// TagUID is the chip UID the printer reads and TrayUUID the spool's own identifier, which both chips of a Bambu
	// spool report. At least one is set.
	TagUID        *string
	TrayUUID      *string
	MaterialType  *string
	SubBrand      *string
	ColorHex      *string
	RemainPercent *int
	// ProductCode is the manufacturer's product code of the filament as the printer reads it from the tag (Bambu's
	// tray_id_name, such as "A00-K0"); FilamentProfileID is its slicer profile id (tray_info_idx, "GFA00").
	ProductCode       *string
	FilamentProfileID *string
	ObservedAt        time.Time
	Spool             *DetectedSpoolTagSpool
}

// DetectedSpoolTagSpool is the active spool that already carries a detected tag or tray UUID.
type DetectedSpoolTagSpool struct {
	ID        uuid.UUID
	DisplayID string
}

// detectedSnapshot reads only the live status fields this feature needs. Snapshots of connectors that predate
// tagUid and trayUuid simply have no tag and are skipped.
type detectedSnapshot struct {
	Units []struct {
		ExternalID string `json:"externalId"`
		Label      string `json:"label"`
		Trays      []struct {
			ExternalID        string  `json:"externalId"`
			MaterialType      *string `json:"materialType"`
			SubBrand          *string `json:"subBrand"`
			ColorHex          *string `json:"colorHex"`
			RemainPercent     *int    `json:"remainPercent"`
			ProductCode       *string `json:"productCode"`
			FilamentProfileID *string `json:"filamentProfileId"`
			TagUID            *string `json:"tagUid"`
			TrayUUID          *string `json:"trayUuid"`
			Empty             bool    `json:"empty"`
		} `json:"trays"`
	} `json:"units"`
}

type slotKey struct {
	machineID  uuid.UUID
	unit, tray string
}

// ListDetectedSpoolTags lists the tags read from the trays of all collecting printers. It exposes live printer data
// together with spool identity, so both machines.read and inventory.read are required.
func (s *Service) ListDetectedSpoolTags(
	ctx context.Context,
	principal authorization.Principal,
) ([]DetectedSpoolTag, error) {
	if !principal.Has(authorization.MachinesRead) || !principal.Has(authorization.InventoryRead) {
		return nil, apperror.PermissionDenied
	}
	q := db.New(s.pool)
	statuses, err := q.ListEnabledPrinterLiveStatuses(ctx)
	if err != nil {
		return nil, fmt.Errorf("list live statuses: %w", err)
	}
	items := make([]DetectedSpoolTag, 0)
	machineIDs := make([]uuid.UUID, 0, len(statuses))
	for _, status := range statuses {
		var snapshot detectedSnapshot
		if json.Unmarshal(status.Snapshot, &snapshot) != nil {
			continue
		}
		before := len(items)
		for _, unit := range snapshot.Units {
			for _, tray := range unit.Trays {
				if tray.Empty {
					continue
				}
				tag, trayUUID := detectedIdentity(tray.TagUID), detectedIdentity(tray.TrayUUID)
				if tag == nil && trayUUID == nil {
					continue
				}
				items = append(items, DetectedSpoolTag{
					MachineID:         status.MachineID,
					MachineName:       status.MachineName,
					UnitExternalID:    unit.ExternalID,
					UnitLabel:         unit.Label,
					TrayExternalID:    tray.ExternalID,
					TagUID:            tag,
					TrayUUID:          trayUUID,
					MaterialType:      tray.MaterialType,
					SubBrand:          tray.SubBrand,
					ColorHex:          tray.ColorHex,
					RemainPercent:     tray.RemainPercent,
					ProductCode:       tray.ProductCode,
					FilamentProfileID: tray.FilamentProfileID,
					ObservedAt:        status.ObservedAt,
				})
			}
		}
		if len(items) > before {
			machineIDs = append(machineIDs, status.MachineID)
		}
	}
	if len(items) == 0 {
		return items, nil
	}
	if err = s.attachSlotsAndSpools(ctx, q, items, machineIDs); err != nil {
		return nil, err
	}
	items = dropRepeatedSpools(items)
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if a.MachineName != b.MachineName {
			return a.MachineName < b.MachineName
		}
		if a.MachineID != b.MachineID {
			return a.MachineID.String() < b.MachineID.String()
		}
		if a.UnitExternalID != b.UnitExternalID {
			return a.UnitExternalID < b.UnitExternalID
		}
		return a.TrayExternalID < b.TrayExternalID
	})
	return items, nil
}

// detectedIdentity trims a reported tag identity and drops empty and oversized values.
func detectedIdentity(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" || utf8.RuneCountInString(trimmed) > maximumDetectedTagLength {
		return nil
	}
	return &trimmed
}

// dropRepeatedSpools keeps one tray per physical spool: the one observed last. A spool moved between printers can
// appear in a stale snapshot of its previous printer. Only a tray UUID identifies a spool across its two chips; trays
// without one are kept.
func dropRepeatedSpools(items []DetectedSpoolTag) []DetectedSpoolTag {
	newest := make(map[string]int, len(items))
	for i, item := range items {
		if item.TrayUUID == nil {
			continue
		}
		key := strings.ToLower(*item.TrayUUID)
		if j, ok := newest[key]; !ok || items[j].ObservedAt.Before(item.ObservedAt) {
			newest[key] = i
		}
	}
	result := items[:0]
	for i, item := range items {
		if item.TrayUUID != nil {
			if newest[strings.ToLower(*item.TrayUUID)] != i {
				continue
			}
		}
		result = append(result, item)
	}
	return result
}

func (*Service) attachSlotsAndSpools(
	ctx context.Context,
	q *db.Queries,
	items []DetectedSpoolTag,
	machineIDs []uuid.UUID,
) error {
	slots, err := q.ListConfiguredSlotsByExternalIDs(ctx, machineIDs)
	if err != nil {
		return fmt.Errorf("list configured slots: %w", err)
	}
	slotByKey := make(map[slotKey]db.ListConfiguredSlotsByExternalIDsRow, len(slots))
	for _, slot := range slots {
		slotByKey[slotKey{slot.MachineID, *slot.InputUnitExternalID, *slot.SlotExternalID}] = slot
	}
	tags, trayUUIDs := make([]string, 0, len(items)), make([]string, 0, len(items))
	for _, item := range items {
		if item.TagUID != nil {
			tags = append(tags, strings.ToLower(*item.TagUID))
		}
		if item.TrayUUID != nil {
			trayUUIDs = append(trayUUIDs, strings.ToLower(*item.TrayUUID))
		}
	}
	spools, err := q.ListActiveSpoolsByNFCTags(ctx, tags)
	if err != nil {
		return fmt.Errorf("list spools by nfc tag: %w", err)
	}
	spoolByTag := make(map[string]DetectedSpoolTagSpool, len(spools))
	for _, spool := range spools {
		spoolByTag[spool.TagUid] = DetectedSpoolTagSpool{ID: spool.SpoolID, DisplayID: spool.DisplayID}
	}
	traySpools, err := q.ListActiveSpoolsByTrayUUIDs(ctx, trayUUIDs)
	if err != nil {
		return fmt.Errorf("list spools by tray uuid: %w", err)
	}
	spoolByTray := make(map[string]DetectedSpoolTagSpool, len(traySpools))
	for _, spool := range traySpools {
		spoolByTray[spool.TrayUuid] = DetectedSpoolTagSpool{ID: spool.SpoolID, DisplayID: spool.DisplayID}
	}
	for i := range items {
		item := &items[i]
		if slot, ok := slotByKey[slotKey{item.MachineID, item.UnitExternalID, item.TrayExternalID}]; ok {
			item.SlotID, item.SlotName, item.InputUnitName = &slot.SlotID, &slot.SlotName, &slot.InputUnitName
		}
		// The tray UUID decides first; the chip UID only when it names no spool, like when mounts are reconciled.
		if item.TrayUUID != nil {
			if spool, ok := spoolByTray[strings.ToLower(*item.TrayUUID)]; ok {
				item.Spool = &spool
				continue
			}
		}
		if item.TagUID != nil {
			if spool, ok := spoolByTag[strings.ToLower(*item.TagUID)]; ok {
				item.Spool = &spool
			}
		}
	}
	return nil
}
