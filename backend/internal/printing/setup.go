package printing

import (
	"context"
	"errors"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	printerconnectorsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors/db"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/printing/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	maxSetupUnits         = 32
	maxSetupSlotsPerUnit  = 16
	maxSetupIdentifierLen = 200
	maxSetupNameLen       = 120
)

// SetupSlotInput is one desired spool slot. A nil ID creates the slot.
type SetupSlotInput struct {
	ID                 *uuid.UUID
	Name, Status       string
	ExternalIdentifier *string
}

// SetupUnitInput is one desired spool input unit. A nil ID creates the unit.
type SetupUnitInput struct {
	ID                 *uuid.UUID
	Name               string
	Nozzle             *string
	ExternalIdentifier *string
	Slots              []SetupSlotInput
}

// SetupInput is the complete desired printer setup of one machine.
// ExpectedVersion is the profile version being edited, or 0 when the machine
// has no printer profile yet.
type SetupInput struct {
	ExpectedVersion int64
	Enabled         bool
	Model           *string
	InputUnits      []SetupUnitInput
}

func duplicateIdentifier(message string) error {
	return apperror.New(422, "duplicate_external_identifier", message)
}

func validModel(model string) bool {
	switch model {
	case "bambu_h2d", "bambu_x1c", "prusa_core_one", "generic":
		return true
	}
	return false
}

func validSetupName(name string) bool {
	return name != "" && len(name) <= maxSetupNameLen && name == strings.TrimSpace(name)
}

// normalizeSetup trims and validates the request without touching the
// database, so malformed input never opens a transaction.
func normalizeSetup(input SetupInput) (SetupInput, error) {
	if input.ExpectedVersion < 0 || len(input.InputUnits) > maxSetupUnits {
		return SetupInput{}, validation("invalid printer setup")
	}
	input.Model = clean(input.Model)
	if input.Model != nil && !validModel(*input.Model) {
		return SetupInput{}, validation("invalid printer model")
	}
	units := make([]SetupUnitInput, len(input.InputUnits))
	seenUnitIDs := map[uuid.UUID]bool{}
	seenSlotIDs := map[uuid.UUID]bool{}
	seenUnitExternal := map[string]bool{}
	for i, unit := range input.InputUnits {
		unit.Name = strings.TrimSpace(unit.Name)
		unit.ExternalIdentifier = clean(unit.ExternalIdentifier)
		unit.Nozzle = clean(unit.Nozzle)
		if !validSetupName(unit.Name) || (unit.Nozzle != nil && *unit.Nozzle != "left" && *unit.Nozzle != "right") ||
			(unit.ExternalIdentifier != nil && len(*unit.ExternalIdentifier) > maxSetupIdentifierLen) || len(unit.Slots) > maxSetupSlotsPerUnit {
			return SetupInput{}, validation("invalid spool input unit")
		}
		if unit.ID != nil {
			if *unit.ID == uuid.Nil || seenUnitIDs[*unit.ID] {
				return SetupInput{}, validation("spool input unit IDs must be unique")
			}
			seenUnitIDs[*unit.ID] = true
		}
		if unit.ExternalIdentifier != nil {
			if seenUnitExternal[*unit.ExternalIdentifier] {
				return SetupInput{}, duplicateIdentifier("Two spool input units use the same printer identifier")
			}
			seenUnitExternal[*unit.ExternalIdentifier] = true
		}
		slots := make([]SetupSlotInput, len(unit.Slots))
		seenSlotExternal := map[string]bool{}
		for j, slot := range unit.Slots {
			slot.Name = strings.TrimSpace(slot.Name)
			slot.ExternalIdentifier = clean(slot.ExternalIdentifier)
			if !validSetupName(slot.Name) || (slot.Status != "available" && slot.Status != "unavailable") ||
				(slot.ExternalIdentifier != nil && len(*slot.ExternalIdentifier) > maxSetupIdentifierLen) {
				return SetupInput{}, validation("invalid printer slot")
			}
			if slot.ID != nil {
				if *slot.ID == uuid.Nil || seenSlotIDs[*slot.ID] {
					return SetupInput{}, validation("printer slot IDs must be unique")
				}
				seenSlotIDs[*slot.ID] = true
			}
			if slot.ExternalIdentifier != nil {
				if seenSlotExternal[*slot.ExternalIdentifier] {
					return SetupInput{}, duplicateIdentifier(
						"Two slots of one spool input unit use the same printer identifier",
					)
				}
				seenSlotExternal[*slot.ExternalIdentifier] = true
			}
			slots[j] = slot
		}
		unit.Slots = slots
		units[i] = unit
	}
	input.InputUnits = units
	return input, nil
}

func samePointer(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func setupDatabaseError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return conflict("duplicate_external_identifier", "A printer identifier is already used on this printer")
	}
	return dbError(err)
}

// SaveSetup replaces the printer profile, its spool input units and slots with
// the desired state in one transaction. Rows are never deleted: removed slots
// are retired and removed units are disabled, because mounts and print history
// reference them. Active rows are renumbered 0..n-1 in the given order.
func (s *Service) SaveSetup(
	ctx context.Context,
	p authorization.Principal,
	machineID uuid.UUID,
	raw SetupInput,
	requestID *uuid.UUID,
) (Profile, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return Profile{}, err
	}
	input, err := normalizeSetup(raw)
	if err != nil {
		return Profile{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Profile{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = s.applySetup(ctx, tx, machineID, input); err != nil {
		return Profile{}, err
	}
	if err = writeAudit(ctx, tx, p, "printer_profile.setup_saved", "machine", machineID, requestID, []string{"printerProfile", "model", "enabled", "inputUnits", "slots"}); err != nil {
		return Profile{}, err
	}
	profile, err := loadProfile(ctx, db.New(tx), machineID)
	if err != nil {
		return Profile{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Profile{}, err
	}
	return profile, nil
}

func (s *Service) applySetup(ctx context.Context, tx pgx.Tx, machineID uuid.UUID, input SetupInput) error {
	if err := requireFDMPrinting(ctx, tx, machineID); err != nil {
		return err
	}
	q := db.New(tx)
	profile, err := q.GetPrinterProfileForUpdate(ctx, machineID)
	enabledChanged := true
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		if input.ExpectedVersion != 0 {
			return apperror.StaleWrite
		}
		if _, err = q.CreatePrinterProfile(ctx, db.CreatePrinterProfileParams{MachineID: machineID, Enabled: input.Enabled, Model: input.Model}); err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				return apperror.StaleWrite // another request created the profile first
			}
			return setupDatabaseError(err)
		}
	case err != nil:
		return err
	default:
		if input.ExpectedVersion != profile.Version {
			return apperror.StaleWrite
		}
		enabledChanged = profile.Enabled != input.Enabled
		if _, err = q.UpdatePrinterProfileSetup(ctx, db.UpdatePrinterProfileSetupParams{MachineID: machineID, Enabled: input.Enabled, Model: input.Model}); err != nil {
			return setupDatabaseError(err)
		}
	}

	existingUnits, err := q.ListPrinterInputUnitsForUpdate(ctx, machineID)
	if err != nil {
		return err
	}
	existingSlots, err := q.ListPrinterSlotsForUpdate(ctx, machineID)
	if err != nil {
		return err
	}
	occupiedIDs, err := q.ListOpenAssignedPrinterSlotIDs(ctx, machineID)
	if err != nil {
		return err
	}
	occupied := map[uuid.UUID]bool{}
	for _, id := range occupiedIDs {
		occupied[id] = true
	}
	unitByID := map[uuid.UUID]db.PrinterInputUnit{}
	for _, unit := range existingUnits {
		unitByID[unit.ID] = unit
	}
	slotByID := map[uuid.UUID]db.PrinterSlot{}
	slotsByUnit := map[uuid.UUID][]db.PrinterSlot{}
	for _, slot := range existingSlots {
		slotByID[slot.ID] = slot
		slotsByUnit[slot.InputUnitID] = append(slotsByUnit[slot.InputUnitID], slot)
	}

	keptSlots := map[uuid.UUID]bool{}
	keptUnits := map[uuid.UUID]bool{}
	for _, unit := range input.InputUnits {
		if unit.ID != nil {
			if _, ok := unitByID[*unit.ID]; !ok {
				return validation("unknown spool input unit")
			}
			keptUnits[*unit.ID] = true
		}
		for _, slot := range unit.Slots {
			if slot.ID == nil {
				continue
			}
			existing, ok := slotByID[*slot.ID]
			if !ok || unit.ID == nil || existing.InputUnitID != *unit.ID {
				return validation("unknown printer slot")
			}
			keptSlots[*slot.ID] = true
		}
	}
	for _, slot := range existingSlots {
		if !keptSlots[slot.ID] && slot.Status != "retired" && occupied[slot.ID] {
			return conflict("slot_occupied", "Unmount the spool before removing the slot \""+slot.Name+"\"")
		}
	}

	// Rows move out of the way first so renumbering and identifier swaps never
	// collide with the unique indexes on positions and external identifiers.
	var maxPosition int32
	for _, unit := range existingUnits {
		maxPosition = max(maxPosition, unit.Position)
	}
	for _, slot := range existingSlots {
		maxPosition = max(maxPosition, slot.Position)
	}
	if maxPosition > 1_000_000_000 {
		return conflict("position_overflow", "Printer positions are too large to renumber")
	}
	offset := maxPosition + 1
	if err = q.ShiftPrinterInputUnitsForSetup(ctx, db.ShiftPrinterInputUnitsForSetupParams{MachineID: machineID, PositionOffset: offset}); err != nil {
		return err
	}
	if err = q.ShiftPrinterSlotsForSetup(ctx, db.ShiftPrinterSlotsForSetupParams{MachineID: machineID, PositionOffset: offset}); err != nil {
		return err
	}

	applySlots := func(unitID uuid.UUID, desired []SetupSlotInput) error {
		for position, slot := range desired {
			if slot.ID == nil {
				if _, err := q.CreatePrinterSlot(ctx, db.CreatePrinterSlotParams{ID: newID(), InputUnitID: unitID, Name: slot.Name, Position: int32(position), ExternalIdentifier: slot.ExternalIdentifier, Status: slot.Status}); err != nil {
					return setupDatabaseError(err)
				}
				continue
			}
			old := slotByID[*slot.ID]
			changed := old.Name != slot.Name || int(old.Position) != position || old.Status != slot.Status ||
				!samePointer(old.ExternalIdentifier, slot.ExternalIdentifier)
			if err := q.ApplyPrinterSlotSetup(ctx, db.ApplyPrinterSlotSetupParams{ID: old.ID, Name: slot.Name, Position: int32(position), ExternalIdentifier: slot.ExternalIdentifier, Status: slot.Status, Bump: changed}); err != nil {
				return setupDatabaseError(err)
			}
		}
		next := int32(len(desired))
		for _, old := range slotsByUnit[unitID] {
			if keptSlots[old.ID] {
				continue
			}
			changed := old.Status != "retired" || old.ExternalIdentifier != nil || old.Position != next
			if err := q.ApplyPrinterSlotSetup(ctx, db.ApplyPrinterSlotSetupParams{ID: old.ID, Name: old.Name, Position: next, Status: "retired", Bump: changed}); err != nil {
				return setupDatabaseError(err)
			}
			next++
		}
		return nil
	}

	for position, unit := range input.InputUnits {
		unitID := uuid.Nil
		if unit.ID == nil {
			unitID = newID()
			if _, err = q.CreatePrinterInputUnit(ctx, db.CreatePrinterInputUnitParams{ID: unitID, MachineID: machineID, Name: unit.Name, Position: int32(position), Nozzle: unit.Nozzle, ExternalIdentifier: unit.ExternalIdentifier}); err != nil {
				return setupDatabaseError(err)
			}
		} else {
			unitID = *unit.ID
			old := unitByID[unitID]
			changed := old.Name != unit.Name || int(old.Position) != position || !old.Enabled || !samePointer(old.Nozzle, unit.Nozzle) || !samePointer(old.ExternalIdentifier, unit.ExternalIdentifier)
			if err = q.ApplyPrinterInputUnitSetup(ctx, db.ApplyPrinterInputUnitSetupParams{ID: unitID, Name: unit.Name, Position: int32(position), Nozzle: unit.Nozzle, ExternalIdentifier: unit.ExternalIdentifier, Enabled: true, Bump: changed}); err != nil {
				return setupDatabaseError(err)
			}
		}
		if err = applySlots(unitID, unit.Slots); err != nil {
			return err
		}
	}
	nextUnit := int32(len(input.InputUnits))
	for _, old := range existingUnits {
		if keptUnits[old.ID] {
			continue
		}
		changed := old.Enabled || old.ExternalIdentifier != nil || old.Position != nextUnit
		if err = q.ApplyPrinterInputUnitSetup(ctx, db.ApplyPrinterInputUnitSetupParams{ID: old.ID, Name: old.Name, Position: nextUnit, Nozzle: old.Nozzle, Enabled: false, Bump: changed}); err != nil {
			return setupDatabaseError(err)
		}
		nextUnit++
		if err = applySlots(old.ID, nil); err != nil {
			return err
		}
	}
	if enabledChanged {
		// The connector configuration carries the printer's enabled flag.
		if err = printerconnectorsdb.New(tx).BumpConnectorsOfMachine(ctx, machineID); err != nil {
			return err
		}
	}
	return nil
}
