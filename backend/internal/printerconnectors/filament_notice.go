package printerconnectors

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
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
	emitter InboxEmitter,
	machineID uuid.UUID,
	slot *observedSlot,
) error {
	if emitter == nil {
		return nil
	}
	q := db.New(tx)
	change := inbox.FilamentChange{Slot: slot.name, Material: slot.material}
	switch {
	case slot.tagUID != "":
		known, err := q.FindActiveSpoolByNFCTag(ctx, slot.tagUID)
		if errors.Is(err, pgx.ErrNoRows) {
			change.Kind = inbox.FilamentUnknownTag
		} else if err != nil {
			return err
		} else {
			if slot.before != nil && *slot.before == known {
				return nil
			}
			change.Kind, change.SpoolID = inbox.FilamentLoaded, &known
		}
	case slot.empty && slot.material != "":
		if slot.before != nil {
			// A manual mount stays in Core; the printer only cannot read the tag of what is in the tray.
			return nil
		}
		change.Kind = inbox.FilamentNoTag
	case slot.empty:
		if slot.before == nil {
			return nil
		}
		change.Kind, change.SpoolID = inbox.FilamentUnloaded, slot.before
	default:
		return nil
	}
	return emitter.FilamentChange(ctx, tx, machineID, change)
}
