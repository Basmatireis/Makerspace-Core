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
	TagUID         string
	MaterialType   *string
	SubBrand       *string
	ColorHex       *string
	RemainPercent  *int
	ObservedAt     time.Time
	Spool          *DetectedSpoolTagSpool
}

// DetectedSpoolTagSpool is the spool whose open fill already carries a detected tag.
type DetectedSpoolTagSpool struct {
	ID        uuid.UUID
	DisplayID string
}

// detectedSnapshot reads only the live status fields this feature needs. Snapshots of connectors that predate
// tagUid simply have no tag and are skipped.
type detectedSnapshot struct {
	Units []struct {
		ExternalID string `json:"externalId"`
		Label      string `json:"label"`
		Trays      []struct {
			ExternalID    string  `json:"externalId"`
			MaterialType  *string `json:"materialType"`
			SubBrand      *string `json:"subBrand"`
			ColorHex      *string `json:"colorHex"`
			RemainPercent *int    `json:"remainPercent"`
			TagUID        *string `json:"tagUid"`
			Empty         bool    `json:"empty"`
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
				if tray.Empty || tray.TagUID == nil {
					continue
				}
				tag := strings.TrimSpace(*tray.TagUID)
				if tag == "" || utf8.RuneCountInString(tag) > maximumDetectedTagLength {
					continue
				}
				items = append(items, DetectedSpoolTag{
					MachineID:      status.MachineID,
					MachineName:    status.MachineName,
					UnitExternalID: unit.ExternalID,
					UnitLabel:      unit.Label,
					TrayExternalID: tray.ExternalID,
					TagUID:         tag,
					MaterialType:   tray.MaterialType,
					SubBrand:       tray.SubBrand,
					ColorHex:       tray.ColorHex,
					RemainPercent:  tray.RemainPercent,
					ObservedAt:     status.ObservedAt,
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
	tags := make([]string, 0, len(items))
	for _, item := range items {
		tags = append(tags, strings.ToLower(item.TagUID))
	}
	spools, err := q.ListActiveSpoolsByNFCTags(ctx, tags)
	if err != nil {
		return fmt.Errorf("list spools by nfc tag: %w", err)
	}
	spoolByTag := make(map[string]DetectedSpoolTagSpool, len(spools))
	for _, spool := range spools {
		spoolByTag[spool.TagUid] = DetectedSpoolTagSpool{ID: spool.SpoolID, DisplayID: spool.DisplayID}
	}
	for i := range items {
		item := &items[i]
		if slot, ok := slotByKey[slotKey{item.MachineID, item.UnitExternalID, item.TrayExternalID}]; ok {
			item.SlotID, item.SlotName, item.InputUnitName = &slot.SlotID, &slot.SlotName, &slot.InputUnitName
		}
		if spool, ok := spoolByTag[strings.ToLower(item.TagUID)]; ok {
			item.Spool = &spool
		}
	}
	return nil
}
