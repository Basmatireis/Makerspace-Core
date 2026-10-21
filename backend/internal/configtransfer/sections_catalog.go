package configtransfer

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	configtransferdb "github.com/Basmatireis/Makerspace-Core/backend/internal/configtransfer/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
)

// Machine types ("machine processes" in the UI): natural key name. They have no delete path, so an overwrite
// deactivates machine types missing from the file.

type machineTypeEntry struct {
	Name    string `json:"name"`
	Process string `json:"process"`
	Active  bool   `json:"active"`
}

func machineTypesSection() section {
	return define(
		SectionMachineTypes,
		permissions(authorization.MachinesRead),
		permissions(authorization.MachinesManage),
		func(ctx context.Context, q *configtransferdb.Queries) ([]machineTypeEntry, error) {
			rows, err := q.ListMachineTypes(ctx)
			if err != nil {
				return nil, err
			}
			items := make([]machineTypeEntry, 0, len(rows))
			for _, row := range rows {
				items = append(items, machineTypeEntry{Name: row.Name, Process: row.Process, Active: row.Active})
			}
			return items, nil
		},
		func(items *[]machineTypeEntry) error {
			names := make([]*string, len(*items))
			for i := range *items {
				names[i] = &(*items)[i].Name
			}
			return checkNames("machine type", names, 120)
		},
		applyMachineTypes,
	)
}

func applyMachineTypes(r *run, items *[]machineTypeEntry) (func() error, error) {
	rows, err := r.q.ListMachineTypes(r.ctx)
	if err != nil {
		return nil, err
	}
	existing := map[string]configtransferdb.ListMachineTypesRow{}
	for _, row := range rows {
		existing[nameKey(row.Name)] = row
	}
	inFile := map[string]bool{}
	for _, item := range *items {
		inFile[nameKey(item.Name)] = true
		current, found := existing[nameKey(item.Name)]
		switch {
		case !found:
			_, err = r.attempt(item.Name, ActionCreate, "", func(tx pgx.Tx) error {
				created, err := r.svc.MachineLogbook.CreateMachineTypeTx(r.ctx, tx, r.p, item.Name, item.Process, r.requestID)
				if err != nil || item.Active {
					return err
				}
				_, err = r.svc.MachineLogbook.UpdateMachineTypeTx(
					r.ctx, tx, r.p, created.ID, created.Version, nil, ptr(false), nil, r.requestID,
				)
				return err
			})
		case r.mode == ModeInsert:
			r.skip(item.Name, reasonExists)
		case current.Name == item.Name && current.Process == item.Process && current.Active == item.Active:
			r.skip(item.Name, reasonUnchanged)
		default:
			_, err = r.attempt(item.Name, ActionUpdate, "", func(tx pgx.Tx) error {
				_, err := r.svc.MachineLogbook.UpdateMachineTypeTx(
					r.ctx, tx, r.p, current.ID, current.Version, &item.Name, &item.Active, &item.Process, r.requestID,
				)
				return err
			})
		}
		if err != nil {
			return nil, err
		}
	}
	return func() error {
		for _, row := range rows {
			if inFile[nameKey(row.Name)] {
				continue
			}
			if !row.Active {
				r.keep(row.Name, "Machine types cannot be deleted; it stays inactive.")
				continue
			}
			if _, err := r.attempt(row.Name, ActionDeactivate, "Machine types cannot be deleted.", func(tx pgx.Tx) error {
				_, err := r.svc.MachineLogbook.UpdateMachineTypeTx(
					r.ctx, tx, r.p, row.ID, row.Version, nil, ptr(false), nil, r.requestID,
				)
				return err
			}); err != nil {
				return err
			}
		}
		return nil
	}, nil
}

// Material types: natural key name.

type materialTypeEntry struct {
	Name      string   `json:"name"`
	Kind      string   `json:"kind"`
	Unit      string   `json:"unit"`
	Processes []string `json:"processes"`
	Active    bool     `json:"active"`
}

func materialTypesSection() section {
	return define(
		SectionMaterialTypes,
		permissions(authorization.InventoryRead),
		permissions(authorization.InventoryManage),
		func(ctx context.Context, q *configtransferdb.Queries) ([]materialTypeEntry, error) {
			rows, err := q.ListMaterialTypes(ctx)
			if err != nil {
				return nil, err
			}
			items := make([]materialTypeEntry, 0, len(rows))
			for _, row := range rows {
				items = append(items, materialTypeEntry{
					Name:      row.Name,
					Kind:      row.Kind,
					Unit:      row.Unit,
					Processes: sortedStrings(row.Processes),
					Active:    row.Active,
				})
			}
			return items, nil
		},
		func(items *[]materialTypeEntry) error {
			names := make([]*string, len(*items))
			for i := range *items {
				names[i] = &(*items)[i].Name
				(*items)[i].Processes = sortedStrings((*items)[i].Processes)
			}
			return checkNames("material type", names, 120)
		},
		applyMaterialTypes,
	)
}

func sortedStrings(values []string) []string {
	result := slices.Clone(values)
	if result == nil {
		result = []string{}
	}
	sort.Strings(result)
	return slices.Compact(result)
}

func applyMaterialTypes(r *run, items *[]materialTypeEntry) (func() error, error) {
	rows, err := r.q.ListMaterialTypes(r.ctx)
	if err != nil {
		return nil, err
	}
	existing := map[string]configtransferdb.ListMaterialTypesRow{}
	for _, row := range rows {
		existing[nameKey(row.Name)] = row
	}
	inFile := map[string]bool{}
	for _, item := range *items {
		inFile[nameKey(item.Name)] = true
		current, found := existing[nameKey(item.Name)]
		kind := machinelogbook.MaterialKind(item.Kind)
		switch {
		case !found:
			_, err = r.attempt(item.Name, ActionCreate, "", func(tx pgx.Tx) error {
				created, err := r.svc.MachineLogbook.CreateMaterialTypeTx(
					r.ctx, tx, r.p, item.Name, kind, item.Unit, item.Processes, r.requestID,
				)
				if err != nil || item.Active {
					return err
				}
				_, err = r.svc.MachineLogbook.UpdateMaterialTypeTx(
					r.ctx, tx, r.p, created.ID, created.Version, created.Name, kind, created.Unit, nil, false, r.requestID,
				)
				return err
			})
		case r.mode == ModeInsert:
			r.skip(item.Name, reasonExists)
		case current.Name == item.Name && current.Kind == item.Kind && current.Unit == item.Unit &&
			current.Active == item.Active && slices.Equal(sortedStrings(current.Processes), item.Processes):
			r.skip(item.Name, reasonUnchanged)
		default:
			_, err = r.attempt(item.Name, ActionUpdate, "", func(tx pgx.Tx) error {
				_, err := r.svc.MachineLogbook.UpdateMaterialTypeTx(
					r.ctx, tx, r.p, current.ID, current.Version, item.Name, kind, item.Unit, item.Processes,
					item.Active, r.requestID,
				)
				return err
			})
		}
		if err != nil {
			return nil, err
		}
	}
	return func() error {
		for _, row := range rows {
			if inFile[nameKey(row.Name)] {
				continue
			}
			deleted, err := r.try(row.Name, func(tx pgx.Tx) error {
				return r.svc.MachineLogbook.DeleteMaterialTypeTx(r.ctx, tx, r.p, row.ID, row.Version, r.requestID)
			})
			if err != nil {
				return err
			}
			if deleted {
				r.record(row.Name, ActionDelete, "")
				continue
			}
			// try recorded the refusal as a conflict; an in-use type is deactivated instead.
			if !r.retractInUseConflict(row.Name, "material_type_in_use") {
				continue
			}
			if !row.Active {
				r.keep(row.Name, "Articles or pricing rules use this material type; it stays inactive.")
				continue
			}
			if _, err := r.attempt(
				row.Name,
				ActionDeactivate,
				"Articles or pricing rules use this material type.",
				func(tx pgx.Tx) error {
					_, err := r.svc.MachineLogbook.UpdateMaterialTypeTx(
						r.ctx, tx, r.p, row.ID, row.Version, row.Name, machinelogbook.MaterialKind(row.Kind), row.Unit,
						nil, false, r.requestID,
					)
					return err
				},
			); err != nil {
				return err
			}
		}
		return nil
	}, nil
}

// retractInUseConflict removes the conflict try just recorded for name when its code is the expected "in use"
// refusal, so the caller can fall back to deactivating. It reports whether it did.
func (r *run) retractInUseConflict(name, code string) bool {
	last := len(r.report.Items) - 1
	if last < 0 {
		return false
	}
	item := r.report.Items[last]
	if item.Name != name || item.Action != ActionConflict || item.Code != code {
		return false
	}
	r.report.Items = r.report.Items[:last]
	r.report.Counts.Conflict--
	return true
}

// Machines: natural key name; the machine type is referenced by name. The printer setup (model, input units and
// slots) is part of the machine; units and slots are matched by name. A machine without printer in the file keeps
// any printer setup it has. Connector assignments, identities, live status and mounted spools are runtime data and
// never transferred.

type printerSlotEntry struct {
	Name               string  `json:"name"`
	Status             string  `json:"status"`
	ExternalIdentifier *string `json:"externalIdentifier"`
}

type printerUnitEntry struct {
	Name               string             `json:"name"`
	Nozzle             *string            `json:"nozzle"`
	ExternalIdentifier *string            `json:"externalIdentifier"`
	Slots              []printerSlotEntry `json:"slots"`
}

type printerEntry struct {
	Enabled    bool               `json:"enabled"`
	Model      *string            `json:"model"`
	InputUnits []printerUnitEntry `json:"inputUnits"`
}

type machineEntry struct {
	Name                       string        `json:"name"`
	MachineType                string        `json:"machineType"`
	Status                     string        `json:"status"`
	ExternalIdentifier         *string       `json:"externalIdentifier"`
	AutomaticCollectionEnabled bool          `json:"automaticCollectionEnabled"`
	Printer                    *printerEntry `json:"printer"`
}

func machinesSection() section {
	return define(
		SectionMachines,
		permissions(authorization.MachinesRead),
		permissions(authorization.MachinesManage),
		exportMachines,
		func(items *[]machineEntry) error {
			names := make([]*string, len(*items))
			for i := range *items {
				item := &(*items)[i]
				names[i] = &item.Name
				item.MachineType = strings.TrimSpace(item.MachineType)
				item.ExternalIdentifier = trimmed(item.ExternalIdentifier)
				if item.Printer != nil {
					normalizePrinter(item.Printer)
				}
			}
			return checkNames("machine", names, 150)
		},
		applyMachines,
	)
}

func normalizePrinter(printer *printerEntry) {
	printer.Model = trimmed(printer.Model)
	if printer.InputUnits == nil {
		printer.InputUnits = []printerUnitEntry{}
	}
	for i := range printer.InputUnits {
		unit := &printer.InputUnits[i]
		unit.Name = strings.TrimSpace(unit.Name)
		unit.Nozzle = trimmed(unit.Nozzle)
		unit.ExternalIdentifier = trimmed(unit.ExternalIdentifier)
		if unit.Slots == nil {
			unit.Slots = []printerSlotEntry{}
		}
		for j := range unit.Slots {
			unit.Slots[j].Name = strings.TrimSpace(unit.Slots[j].Name)
			unit.Slots[j].ExternalIdentifier = trimmed(unit.Slots[j].ExternalIdentifier)
		}
	}
}

// storedPrinter is the current setup of one machine with the IDs needed to update it.
type storedPrinter struct {
	version int64
	entry   printerEntry
	units   []storedUnit
}

type storedUnit struct {
	id    uuid.UUID
	name  string
	slots []storedSlot
}

type storedSlot struct {
	id   uuid.UUID
	name string
}

func loadPrinters(ctx context.Context, q *configtransferdb.Queries) (map[uuid.UUID]*storedPrinter, error) {
	profiles, err := q.ListPrinterProfiles(ctx)
	if err != nil {
		return nil, err
	}
	units, err := q.ListPrinterInputUnits(ctx)
	if err != nil {
		return nil, err
	}
	slots, err := q.ListPrinterSlots(ctx)
	if err != nil {
		return nil, err
	}
	printers := map[uuid.UUID]*storedPrinter{}
	for _, profile := range profiles {
		printers[profile.MachineID] = &storedPrinter{
			version: profile.Version,
			entry:   printerEntry{Enabled: profile.Enabled, Model: profile.Model, InputUnits: []printerUnitEntry{}},
		}
	}
	slotsByUnit := map[uuid.UUID][]configtransferdb.ListPrinterSlotsRow{}
	for _, slot := range slots {
		slotsByUnit[slot.InputUnitID] = append(slotsByUnit[slot.InputUnitID], slot)
	}
	for _, unit := range units {
		printer := printers[unit.MachineID]
		if printer == nil || !unit.Enabled {
			continue // disabled units are what removed units become
		}
		entry := printerUnitEntry{
			Name:               unit.Name,
			Nozzle:             unit.Nozzle,
			ExternalIdentifier: unit.ExternalIdentifier,
			Slots:              []printerSlotEntry{},
		}
		stored := storedUnit{id: unit.ID, name: unit.Name}
		for _, slot := range slotsByUnit[unit.ID] {
			if printing.SlotStatus(slot.Status) == printing.SlotRetired {
				continue // retired slots are what removed slots become
			}
			entry.Slots = append(entry.Slots, printerSlotEntry{
				Name:               slot.Name,
				Status:             slot.Status,
				ExternalIdentifier: slot.ExternalIdentifier,
			})
			stored.slots = append(stored.slots, storedSlot{id: slot.ID, name: slot.Name})
		}
		printer.entry.InputUnits = append(printer.entry.InputUnits, entry)
		printer.units = append(printer.units, stored)
	}
	return printers, nil
}

func exportMachines(ctx context.Context, q *configtransferdb.Queries) ([]machineEntry, error) {
	rows, err := q.ListMachines(ctx)
	if err != nil {
		return nil, err
	}
	printers, err := loadPrinters(ctx, q)
	if err != nil {
		return nil, err
	}
	items := make([]machineEntry, 0, len(rows))
	for _, row := range rows {
		item := machineEntry{
			Name:                       row.Name,
			MachineType:                row.MachineTypeName,
			Status:                     row.Status,
			ExternalIdentifier:         row.ExternalIdentifier,
			AutomaticCollectionEnabled: row.AutomaticCollectionEnabled,
		}
		if printer := printers[row.ID]; printer != nil {
			entry := printer.entry
			item.Printer = &entry
		}
		items = append(items, item)
	}
	return items, nil
}

func samePrinter(a, b printerEntry) bool {
	if a.Enabled != b.Enabled || !sameText(a.Model, b.Model) || len(a.InputUnits) != len(b.InputUnits) {
		return false
	}
	for i := range a.InputUnits {
		left, right := a.InputUnits[i], b.InputUnits[i]
		if left.Name != right.Name || !sameText(left.Nozzle, right.Nozzle) ||
			!sameText(left.ExternalIdentifier, right.ExternalIdentifier) || len(left.Slots) != len(right.Slots) {
			return false
		}
		for j := range left.Slots {
			if left.Slots[j].Name != right.Slots[j].Name || left.Slots[j].Status != right.Slots[j].Status ||
				!sameText(left.Slots[j].ExternalIdentifier, right.Slots[j].ExternalIdentifier) {
				return false
			}
		}
	}
	return true
}

// setupInput maps the file setup onto the stored one: units and slots with the same name keep their identity, so
// spool history and mounts stay attached.
func setupInput(desired printerEntry, current *storedPrinter) printing.SetupInput {
	input := printing.SetupInput{
		Enabled:    desired.Enabled,
		Model:      (*printing.PrinterModel)(desired.Model),
		InputUnits: make([]printing.SetupUnitInput, 0, len(desired.InputUnits)),
	}
	usedUnits := map[uuid.UUID]bool{}
	for _, unit := range desired.InputUnits {
		unitInput := printing.SetupUnitInput{
			Name:               unit.Name,
			Nozzle:             (*printing.Nozzle)(unit.Nozzle),
			ExternalIdentifier: unit.ExternalIdentifier,
		}
		var match *storedUnit
		if current != nil {
			for i := range current.units {
				candidate := &current.units[i]
				if !usedUnits[candidate.id] && nameKey(candidate.name) == nameKey(unit.Name) {
					match = candidate
					usedUnits[candidate.id] = true
					unitInput.ID = ptr(candidate.id)
					break
				}
			}
		}
		usedSlots := map[uuid.UUID]bool{}
		for _, slot := range unit.Slots {
			slotInput := printing.SetupSlotInput{
				Name:               slot.Name,
				Status:             printing.SlotStatus(slot.Status),
				ExternalIdentifier: slot.ExternalIdentifier,
			}
			if match != nil {
				for _, candidate := range match.slots {
					if !usedSlots[candidate.id] && nameKey(candidate.name) == nameKey(slot.Name) {
						usedSlots[candidate.id] = true
						slotInput.ID = ptr(candidate.id)
						break
					}
				}
			}
			unitInput.Slots = append(unitInput.Slots, slotInput)
		}
		input.InputUnits = append(input.InputUnits, unitInput)
	}
	if current != nil {
		input.ExpectedVersion = current.version
	}
	return input
}

func machineTypeIDs(ctx context.Context, q *configtransferdb.Queries) (map[string]uuid.UUID, error) {
	rows, err := q.ListMachineTypes(ctx)
	if err != nil {
		return nil, err
	}
	result := make(map[string]uuid.UUID, len(rows))
	for _, row := range rows {
		result[nameKey(row.Name)] = row.ID
	}
	return result, nil
}

func applyMachines(r *run, items *[]machineEntry) (func() error, error) {
	rows, err := r.q.ListMachines(r.ctx)
	if err != nil {
		return nil, err
	}
	printers, err := loadPrinters(r.ctx, r.q)
	if err != nil {
		return nil, err
	}
	types, err := machineTypeIDs(r.ctx, r.q)
	if err != nil {
		return nil, err
	}
	existing := map[string]configtransferdb.ListMachinesRow{}
	for _, row := range rows {
		existing[nameKey(row.Name)] = row
	}
	inFile := map[string]bool{}
	for _, item := range *items {
		inFile[nameKey(item.Name)] = true
		current, found := existing[nameKey(item.Name)]
		if found && r.mode == ModeInsert {
			r.skip(item.Name, reasonExists)
			continue
		}
		typeID, ok := types[nameKey(item.MachineType)]
		if !ok {
			r.conflict(item.Name, "machine_type_missing", fmt.Sprintf("The machine type %q does not exist.", item.MachineType))
			continue
		}
		status := machinelogbook.MachineStatus(item.Status)
		if !found {
			_, err = r.attempt(item.Name, ActionCreate, "", func(tx pgx.Tx) error {
				created, err := r.svc.MachineLogbook.CreateMachineTx(
					r.ctx, tx, r.p, typeID, item.Name, status, item.ExternalIdentifier, item.AutomaticCollectionEnabled,
					r.requestID,
				)
				if err != nil || item.Printer == nil {
					return err
				}
				_, err = r.svc.Printing.SaveSetupTx(r.ctx, tx, r.p, created.ID, setupInput(*item.Printer, nil), r.requestID)
				return err
			})
			if err != nil {
				return nil, err
			}
			continue
		}
		machineChanged := current.Name != item.Name || nameKey(current.MachineTypeName) != nameKey(item.MachineType) ||
			current.Status != item.Status || !sameText(current.ExternalIdentifier, item.ExternalIdentifier) ||
			current.AutomaticCollectionEnabled != item.AutomaticCollectionEnabled
		stored := printers[current.ID]
		printerChanged := item.Printer != nil && (stored == nil || !samePrinter(stored.entry, *item.Printer))
		if !machineChanged && !printerChanged {
			r.skip(item.Name, reasonUnchanged)
			continue
		}
		_, err = r.attempt(item.Name, ActionUpdate, "", func(tx pgx.Tx) error {
			if machineChanged {
				if _, err := r.svc.MachineLogbook.UpdateMachineTx(
					r.ctx, tx, r.p, current.ID, current.Version, typeID, item.Name, status, item.ExternalIdentifier,
					item.AutomaticCollectionEnabled, r.requestID,
				); err != nil {
					return err
				}
			}
			if printerChanged {
				_, err := r.svc.Printing.SaveSetupTx(
					r.ctx, tx, r.p, current.ID, setupInput(*item.Printer, stored), r.requestID,
				)
				return err
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return func() error {
		for _, row := range rows {
			if inFile[nameKey(row.Name)] {
				continue
			}
			inUse, err := r.q.MachineInUse(r.ctx, row.ID)
			if err != nil {
				return err
			}
			if !inUse {
				if _, err := r.attempt(row.Name, ActionDelete, "", func(tx pgx.Tx) error {
					return r.svc.MachineLogbook.DeleteMachineTx(r.ctx, tx, r.p, row.ID, row.Version, r.requestID)
				}); err != nil {
					return err
				}
				continue
			}
			if machinelogbook.MachineStatus(row.Status) == machinelogbook.MachineStatusRetired {
				r.keep(row.Name, "The machine has history or connected devices; it stays retired.")
				continue
			}
			if _, err := r.attempt(
				row.Name,
				ActionDeactivate,
				"The machine has history or connected devices, so it is retired instead of deleted.",
				func(tx pgx.Tx) error {
					typeID, ok := types[nameKey(row.MachineTypeName)]
					if !ok {
						return errors.New("machine type of a stored machine is missing")
					}
					_, err := r.svc.MachineLogbook.UpdateMachineTx(
						r.ctx, tx, r.p, row.ID, row.Version, typeID, row.Name, machinelogbook.MachineStatusRetired,
						row.ExternalIdentifier, row.AutomaticCollectionEnabled, r.requestID,
					)
					return err
				},
			); err != nil {
				return err
			}
		}
		return nil
	}, nil
}

// Inventory articles: natural key name; the material type is referenced by name. Stock, ledger, spools and fills
// are runtime data and never transferred. Decimals are strings like in the API.

type inventoryArticleEntry struct {
	Name               string  `json:"name"`
	MaterialType       string  `json:"materialType"`
	Active             bool    `json:"active"`
	LowStockThreshold  *string `json:"lowStockThreshold"`
	ColorName          *string `json:"colorName"`
	ColorHex           *string `json:"colorHex"`
	Variant            *string `json:"variant"`
	Manufacturer       *string `json:"manufacturer"`
	SalePrice          *string `json:"salePrice"`
	PackageSize        *string `json:"packageSize"`
	StorageLocation    *string `json:"storageLocation"`
	Notes              *string `json:"notes"`
	FilamentDiameterMm *string `json:"filamentDiameterMm"`
}

func inventoryArticlesSection() section {
	return define(
		SectionInventoryArticles,
		permissions(authorization.InventoryRead),
		permissions(authorization.InventoryManage),
		exportInventoryArticles,
		func(items *[]inventoryArticleEntry) error {
			names := make([]*string, len(*items))
			for i := range *items {
				item := &(*items)[i]
				names[i] = &item.Name
				item.MaterialType = strings.TrimSpace(item.MaterialType)
				for _, text := range []**string{
					&item.ColorName, &item.ColorHex, &item.Variant, &item.Manufacturer, &item.StorageLocation, &item.Notes,
				} {
					*text = trimmed(*text)
				}
				for _, number := range []**string{
					&item.LowStockThreshold, &item.SalePrice, &item.PackageSize, &item.FilamentDiameterMm,
				} {
					normalized, err := normalizeDecimal(*number)
					if err != nil {
						return fmt.Errorf("article %q has an invalid number", item.Name)
					}
					*number = normalized
				}
			}
			return checkNames("article", names, 150)
		},
		applyInventoryArticles,
	)
}

func normalizeDecimal(value *string) (*string, error) {
	value = trimmed(value)
	if value == nil {
		return nil, nil
	}
	parsed, err := decimal.NewFromString(*value)
	if err != nil {
		return nil, err
	}
	return ptr(parsed.String()), nil
}

func numericText(value pgtype.Numeric) *string {
	if !value.Valid || value.NaN || value.InfinityModifier != pgtype.Finite {
		return nil
	}
	return ptr(decimal.NewFromBigInt(value.Int, value.Exp).String())
}

func articleFromRow(row configtransferdb.ListMaterialsRow) inventoryArticleEntry {
	return inventoryArticleEntry{
		Name:               row.Name,
		MaterialType:       row.MaterialTypeName,
		Active:             row.Active,
		LowStockThreshold:  numericText(row.LowStockThreshold),
		ColorName:          row.ColorName,
		ColorHex:           row.ColorHex,
		Variant:            row.Variant,
		Manufacturer:       row.Manufacturer,
		SalePrice:          numericText(row.SalePrice),
		PackageSize:        numericText(row.PackageSize),
		StorageLocation:    row.StorageLocation,
		Notes:              row.Notes,
		FilamentDiameterMm: numericText(row.FilamentDiameterMm),
	}
}

func sameArticle(a, b inventoryArticleEntry) bool {
	if a.Name != b.Name || nameKey(a.MaterialType) != nameKey(b.MaterialType) || a.Active != b.Active {
		return false
	}
	pairs := [][2]*string{
		{a.LowStockThreshold, b.LowStockThreshold}, {a.ColorName, b.ColorName}, {a.ColorHex, b.ColorHex},
		{a.Variant, b.Variant}, {a.Manufacturer, b.Manufacturer}, {a.SalePrice, b.SalePrice},
		{a.PackageSize, b.PackageSize}, {a.StorageLocation, b.StorageLocation}, {a.Notes, b.Notes},
		{a.FilamentDiameterMm, b.FilamentDiameterMm},
	}
	for _, pair := range pairs {
		if !sameText(pair[0], pair[1]) {
			return false
		}
	}
	return true
}

func exportInventoryArticles(ctx context.Context, q *configtransferdb.Queries) ([]inventoryArticleEntry, error) {
	rows, err := q.ListMaterials(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]inventoryArticleEntry, 0, len(rows))
	for _, row := range rows {
		items = append(items, articleFromRow(row))
	}
	return items, nil
}

func materialTypeIDs(ctx context.Context, q *configtransferdb.Queries) (map[string]uuid.UUID, error) {
	rows, err := q.ListMaterialTypes(ctx)
	if err != nil {
		return nil, err
	}
	result := make(map[string]uuid.UUID, len(rows))
	for _, row := range rows {
		result[nameKey(row.Name)] = row.ID
	}
	return result, nil
}

func articleInput(item inventoryArticleEntry, typeID uuid.UUID) machinelogbook.MaterialInput {
	return machinelogbook.MaterialInput{
		Name:               item.Name,
		MaterialTypeID:     typeID,
		ColorName:          item.ColorName,
		ColorHex:           item.ColorHex,
		Variant:            item.Variant,
		Manufacturer:       item.Manufacturer,
		StorageLocation:    item.StorageLocation,
		Notes:              item.Notes,
		SalePrice:          item.SalePrice,
		PackageSize:        item.PackageSize,
		LowStockThreshold:  item.LowStockThreshold,
		FilamentDiameterMM: item.FilamentDiameterMm,
		Active:             item.Active,
	}
}

func applyInventoryArticles(r *run, items *[]inventoryArticleEntry) (func() error, error) {
	rows, err := r.q.ListMaterials(r.ctx)
	if err != nil {
		return nil, err
	}
	types, err := materialTypeIDs(r.ctx, r.q)
	if err != nil {
		return nil, err
	}
	existing := map[string]configtransferdb.ListMaterialsRow{}
	for _, row := range rows {
		existing[nameKey(row.Name)] = row
	}
	inFile := map[string]bool{}
	for _, item := range *items {
		inFile[nameKey(item.Name)] = true
		current, found := existing[nameKey(item.Name)]
		if found && r.mode == ModeInsert {
			r.skip(item.Name, reasonExists)
			continue
		}
		if found && sameArticle(articleFromRow(current), item) {
			r.skip(item.Name, reasonUnchanged)
			continue
		}
		typeID, ok := types[nameKey(item.MaterialType)]
		if !ok {
			r.conflict(item.Name, "material_type_missing",
				fmt.Sprintf("The material type %q does not exist.", item.MaterialType))
			continue
		}
		input := articleInput(item, typeID)
		if !found {
			_, err = r.attempt(item.Name, ActionCreate, "", func(tx pgx.Tx) error {
				id, err := r.svc.MachineLogbook.CreateMaterialTx(r.ctx, tx, r.p, input, r.requestID)
				if err != nil || item.Active {
					return err
				}
				input.ExpectedVersion = 1
				_, err = r.svc.MachineLogbook.UpdateMaterialTx(r.ctx, tx, r.p, id, input, r.requestID)
				return err
			})
		} else {
			input.ExpectedVersion = current.Version
			_, err = r.attempt(item.Name, ActionUpdate, "", func(tx pgx.Tx) error {
				_, err := r.svc.MachineLogbook.UpdateMaterialTx(r.ctx, tx, r.p, current.ID, input, r.requestID)
				return err
			})
		}
		if err != nil {
			return nil, err
		}
	}
	return func() error {
		for _, row := range rows {
			if inFile[nameKey(row.Name)] {
				continue
			}
			deleted, err := r.try(row.Name, func(tx pgx.Tx) error {
				return r.svc.MachineLogbook.DeleteMaterialTx(r.ctx, tx, r.p, row.ID, row.Version, r.requestID)
			})
			if err != nil {
				return err
			}
			if deleted {
				r.record(row.Name, ActionDelete, "")
				continue
			}
			if !r.retractInUseConflict(row.Name, "material_in_use") {
				continue
			}
			if !row.Active {
				r.keep(row.Name, "The article has stock history; it stays inactive.")
				continue
			}
			entry := articleFromRow(row)
			entry.Active = false
			input := articleInput(entry, types[nameKey(row.MaterialTypeName)])
			input.ExpectedVersion = row.Version
			if _, err := r.attempt(row.Name, ActionDeactivate, "The article has stock history.", func(tx pgx.Tx) error {
				_, err := r.svc.MachineLogbook.UpdateMaterialTx(r.ctx, tx, r.p, row.ID, input, r.requestID)
				return err
			}); err != nil {
				return err
			}
		}
		return nil
	}, nil
}
