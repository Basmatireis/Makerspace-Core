package printerconnectors

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// observedSlot is what one slot observation says, read before the mounts are reconciled so the change
// can be told apart from the state Core already had.
type observedSlot struct {
	slotID   uuid.UUID
	name     string
	tagUID   string
	trayUUID string
	empty    bool
	material string
	// before is the spool mounted in the slot when the observation arrived.
	before *uuid.UUID
}

// observeSlot resolves the slot of a Bambu slot observation and the spool mounted in it. An unknown
// slot or a malformed payload yields nil and no error: there is nothing to tell.
func observeSlot(ctx context.Context, q *db.Queries, machineID uuid.UUID, payload json.RawMessage) (*observedSlot, error) {
	var value struct {
		InputUnitExternalID string `json:"inputUnitExternalId"`
		SlotExternalID      string `json:"slotExternalId"`
		TagUID              string `json:"tagUid"`
		TrayUUID            string `json:"trayUuid"`
		Empty               bool   `json:"empty"`
		TrayType            string `json:"trayType"`
		ProductName         string `json:"productName"`
		Color               string `json:"color"`
	}
	if json.Unmarshal(payload, &value) != nil {
		return nil, nil //nolint:nilerr // a malformed connector payload is ignored
	}
	value.InputUnitExternalID = strings.TrimSpace(value.InputUnitExternalID)
	value.SlotExternalID = strings.TrimSpace(value.SlotExternalID)
	if value.InputUnitExternalID == "" || value.SlotExternalID == "" {
		return nil, nil
	}
	slot, err := q.GetSlotByExternalIDs(ctx, db.GetSlotByExternalIDsParams{
		MachineID: machineID, InputUnitExternalID: value.InputUnitExternalID, SlotExternalID: value.SlotExternalID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	observed := &observedSlot{
		slotID:   slot.ID,
		name:     slot.UnitName + " · " + slot.SlotName,
		tagUID:   strings.TrimSpace(value.TagUID),
		trayUUID: strings.TrimSpace(value.TrayUUID),
		empty:    value.Empty,
		material: trayMaterial(value.TrayType, value.ProductName, value.Color),
	}
	before, err := q.GetOpenMountSpoolForSlot(ctx, slot.ID)
	if err == nil {
		observed.before = &before
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	return observed, nil
}

// trayMaterial words what the printer read from the tray: the material type and, if the printer sent a
// Bambu colour (RRGGBBAA), its hex value.
func trayMaterial(trayType, productName, color string) string {
	material := strings.TrimSpace(productName)
	if material == "" {
		material = strings.TrimSpace(trayType)
	}
	color = strings.TrimSpace(color)
	if material != "" && len(color) >= 6 {
		material += " #" + strings.ToUpper(color[:6])
	}
	return material
}

// notifyFilamentChange tells the operator of the running print what changed in a slot, after the
// mounts were reconciled:
//   - a known spool (by RFID tag) that was not in the slot before: loaded;
//   - an empty tray that held a spool: unloaded;
//   - a tag no spool carries: new material without a spool;
//   - material without a readable tag: a spool must be loaded by hand.
//
// The emitter itself decides whether anyone is told.
func notifyFilamentChange(
	ctx context.Context,
	tx pgx.Tx,
	emitter NotificationEmitter,
	machineID uuid.UUID,
	slot *observedSlot,
) error {
	if emitter == nil {
		return nil
	}
	q := db.New(tx)
	change := notifyrules.FilamentChange{Slot: slot.name, Material: slot.material}
	switch {
	case slot.tagUID != "" || slot.trayUUID != "":
		known, err := findActiveSpoolByTag(ctx, q, slot.trayUUID, slot.tagUID)
		if errors.Is(err, pgx.ErrNoRows) {
			change.Kind = notifyrules.FilamentUnknownTag
		} else if err != nil {
			return err
		} else {
			if slot.before != nil && *slot.before == known {
				return nil
			}
			change.Kind, change.SpoolID = notifyrules.FilamentLoaded, &known
		}
	case slot.empty && slot.material != "":
		if slot.before != nil {
			// A manual mount stays in Core; the printer only cannot read the tag of what is in the tray.
			return nil
		}
		change.Kind = notifyrules.FilamentNoTag
	case slot.empty:
		if slot.before == nil {
			return nil
		}
		change.Kind, change.SpoolID = notifyrules.FilamentUnloaded, slot.before
	default:
		return nil
	}
	return emitter.FilamentChange(ctx, tx, machineID, change)
}

// findActiveSpoolByTag is lockActiveSpoolByTag without the lock.
func findActiveSpoolByTag(ctx context.Context, q *db.Queries, trayUUID, tagUID string) (uuid.UUID, error) {
	if trayUUID != "" {
		id, err := q.FindActiveSpoolByTrayUUID(ctx, trayUUID)
		if !errors.Is(err, pgx.ErrNoRows) {
			return id, err
		}
	}
	if tagUID == "" {
		return uuid.Nil, pgx.ErrNoRows
	}
	return q.FindActiveSpoolByNFCTag(ctx, tagUID)
}
