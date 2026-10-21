package configtransfer

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	configtransferdb "github.com/Basmatireis/Makerspace-Core/backend/internal/configtransfer/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Pricing: groups by name; their active rules by kind and target (machine type or material type by name, and the
// measure); the role mapping by role name, pointing at a group by name. Groups and rules have no delete path: an
// overwrite deactivates groups and rules missing from the file.

type pricingRuleEntry struct {
	Kind         string  `json:"kind"`
	MachineType  *string `json:"machineType"`
	MaterialType *string `json:"materialType"`
	Measure      *string `json:"measure"`
	Rate         string  `json:"rate"`
}

type pricingGroupEntry struct {
	Name        string             `json:"name"`
	Description *string            `json:"description"`
	Active      bool               `json:"active"`
	IsDefault   bool               `json:"isDefault"`
	Rules       []pricingRuleEntry `json:"rules"`
}

type rolePricingEntry struct {
	Role         string `json:"role"`
	PricingGroup string `json:"pricingGroup"`
	Priority     int32  `json:"priority"`
}

type pricingData struct {
	Groups            []pricingGroupEntry `json:"groups"`
	RolePricingGroups []rolePricingEntry  `json:"rolePricingGroups"`
}

func pricingSection() section {
	return define(
		SectionPricing,
		permissions(authorization.PricingRead),
		permissions(authorization.PricingManage),
		exportPricing,
		validatePricing,
		applyPricing,
	)
}

func ruleKey(rule pricingRuleEntry) string {
	target := ""
	if rule.MachineType != nil {
		target = nameKey(*rule.MachineType)
	}
	material := ""
	if rule.MaterialType != nil {
		material = nameKey(*rule.MaterialType)
	}
	measure := ""
	if rule.Measure != nil {
		measure = *rule.Measure
	}
	return rule.Kind + "\x00" + target + "\x00" + material + "\x00" + measure
}

func validatePricing(data *pricingData) error {
	if data.Groups == nil {
		data.Groups = []pricingGroupEntry{}
	}
	if data.RolePricingGroups == nil {
		data.RolePricingGroups = []rolePricingEntry{}
	}
	names := make([]*string, len(data.Groups))
	defaults := 0
	for i := range data.Groups {
		group := &data.Groups[i]
		names[i] = &group.Name
		group.Description = trimmed(group.Description)
		if group.IsDefault {
			defaults++
			if !group.Active {
				return fmt.Errorf("the default pricing group %q must be active", group.Name)
			}
		}
		if group.Rules == nil {
			group.Rules = []pricingRuleEntry{}
		}
		if len(group.Rules) > maxEntriesPerSection {
			return fmt.Errorf("pricing group %q has too many rules", group.Name)
		}
		seen := map[string]bool{}
		for j := range group.Rules {
			rule := &group.Rules[j]
			rule.MachineType, rule.MaterialType, rule.Measure = trimmed(rule.MachineType), trimmed(rule.MaterialType),
				trimmed(rule.Measure)
			rate, err := normalizeDecimal(&rule.Rate)
			if err != nil || rate == nil {
				return fmt.Errorf("a rule of pricing group %q has an invalid rate", group.Name)
			}
			rule.Rate = *rate
			if seen[ruleKey(*rule)] {
				return fmt.Errorf("pricing group %q prices the same target twice", group.Name)
			}
			seen[ruleKey(*rule)] = true
		}
	}
	if defaults > 1 {
		return errors.New("at most one pricing group can be the default")
	}
	if err := checkNames("pricing group", names, 120); err != nil {
		return err
	}
	roles, priorities := map[string]bool{}, map[int32]bool{}
	for i := range data.RolePricingGroups {
		entry := &data.RolePricingGroups[i]
		entry.Role, entry.PricingGroup = strings.TrimSpace(entry.Role), strings.TrimSpace(entry.PricingGroup)
		if roles[nameKey(entry.Role)] || priorities[entry.Priority] {
			return errors.New("each role and each priority can appear once in the role pricing groups")
		}
		roles[nameKey(entry.Role)], priorities[entry.Priority] = true, true
	}
	return nil
}

type storedGroup struct {
	row   configtransferdb.ListPricingGroupsRow
	rules []configtransferdb.ListActivePricingRulesRow
}

func loadPricing(ctx context.Context, q *configtransferdb.Queries) ([]storedGroup, error) {
	groups, err := q.ListPricingGroups(ctx)
	if err != nil {
		return nil, err
	}
	rules, err := q.ListActivePricingRules(ctx)
	if err != nil {
		return nil, err
	}
	byGroup := map[uuid.UUID][]configtransferdb.ListActivePricingRulesRow{}
	for _, rule := range rules {
		byGroup[rule.PricingGroupID] = append(byGroup[rule.PricingGroupID], rule)
	}
	result := make([]storedGroup, 0, len(groups))
	for _, group := range groups {
		result = append(result, storedGroup{row: group, rules: byGroup[group.ID]})
	}
	return result, nil
}

func ruleEntry(row configtransferdb.ListActivePricingRulesRow) pricingRuleEntry {
	rate := ""
	if text := numericText(row.Rate); text != nil {
		rate = *text
	}
	return pricingRuleEntry{
		Kind:         row.Kind,
		MachineType:  row.MachineTypeName,
		MaterialType: row.MaterialTypeName,
		Measure:      row.Measure,
		Rate:         rate,
	}
}

func exportPricing(ctx context.Context, q *configtransferdb.Queries) (pricingData, error) {
	groups, err := loadPricing(ctx, q)
	if err != nil {
		return pricingData{}, err
	}
	data := pricingData{Groups: make([]pricingGroupEntry, 0, len(groups)), RolePricingGroups: []rolePricingEntry{}}
	for _, group := range groups {
		entry := pricingGroupEntry{
			Name:        group.row.Name,
			Description: group.row.Description,
			Active:      group.row.Active,
			IsDefault:   group.row.IsDefault,
			Rules:       make([]pricingRuleEntry, 0, len(group.rules)),
		}
		for _, rule := range group.rules {
			entry.Rules = append(entry.Rules, ruleEntry(rule))
		}
		data.Groups = append(data.Groups, entry)
	}
	mapping, err := q.ListRolePricingGroups(ctx)
	if err != nil {
		return pricingData{}, err
	}
	for _, row := range mapping {
		data.RolePricingGroups = append(data.RolePricingGroups, rolePricingEntry{
			Role:         row.RoleName,
			PricingGroup: row.PricingGroupName,
			Priority:     row.Priority,
		})
	}
	return data, nil
}

// ruleChange is one write needed to make a group's active rules equal the file.
type ruleChange struct {
	create     *pricingRuleEntry
	update     *configtransferdb.ListActivePricingRulesRow
	deactivate *configtransferdb.ListActivePricingRulesRow
	rate       string
}

func planRules(current []configtransferdb.ListActivePricingRulesRow, desired []pricingRuleEntry) []ruleChange {
	byKey := map[string]configtransferdb.ListActivePricingRulesRow{}
	for _, row := range current {
		byKey[ruleKey(ruleEntry(row))] = row
	}
	changes := []ruleChange{}
	wanted := map[string]bool{}
	for i := range desired {
		rule := desired[i]
		key := ruleKey(rule)
		wanted[key] = true
		row, found := byKey[key]
		switch {
		case !found:
			changes = append(changes, ruleChange{create: &rule})
		case ruleEntry(row).Rate != rule.Rate:
			changes = append(changes, ruleChange{update: &row, rate: rule.Rate})
		}
	}
	for _, row := range current {
		if !wanted[ruleKey(ruleEntry(row))] {
			changes = append(changes, ruleChange{deactivate: &row})
		}
	}
	return changes
}

func summarizeRules(changes []ruleChange) string {
	var created, updated, deactivated int
	for _, change := range changes {
		switch {
		case change.create != nil:
			created++
		case change.update != nil:
			updated++
		default:
			deactivated++
		}
	}
	if created+updated+deactivated == 0 {
		return ""
	}
	return fmt.Sprintf("Rules: %d created, %d updated, %d deactivated.", created, updated, deactivated)
}

type targetIDs struct{ machineTypes, materialTypes map[string]uuid.UUID }

func (t targetIDs) resolve(rule pricingRuleEntry) (*uuid.UUID, *uuid.UUID, string) {
	var machineTypeID, materialTypeID *uuid.UUID
	if rule.MachineType != nil {
		id, ok := t.machineTypes[nameKey(*rule.MachineType)]
		if !ok {
			return nil, nil, fmt.Sprintf("The machine type %q does not exist.", *rule.MachineType)
		}
		machineTypeID = &id
	}
	if rule.MaterialType != nil {
		id, ok := t.materialTypes[nameKey(*rule.MaterialType)]
		if !ok {
			return nil, nil, fmt.Sprintf("The material type %q does not exist.", *rule.MaterialType)
		}
		materialTypeID = &id
	}
	return machineTypeID, materialTypeID, ""
}

func pricingGroupRow(ctx context.Context, tx pgx.Tx, id uuid.UUID) (configtransferdb.ListPricingGroupsRow, error) {
	rows, err := configtransferdb.New(tx).ListPricingGroups(ctx)
	if err != nil {
		return configtransferdb.ListPricingGroupsRow{}, err
	}
	for _, row := range rows {
		if row.ID == id {
			return row, nil
		}
	}
	return configtransferdb.ListPricingGroupsRow{}, fmt.Errorf("pricing group %s disappeared", id)
}

func (r *run) applyRuleChanges(tx pgx.Tx, groupID uuid.UUID, changes []ruleChange, targets targetIDs) error {
	logbook := r.svc.MachineLogbook
	for _, change := range changes {
		var err error
		switch {
		case change.create != nil:
			machineTypeID, materialTypeID, _ := targets.resolve(*change.create)
			_, err = logbook.CreatePricingRuleTx(
				r.ctx, tx, r.p, groupID, machinelogbook.PricingRuleKind(change.create.Kind), machineTypeID,
				materialTypeID, change.create.Measure, change.create.Rate, r.requestID,
			)
		case change.update != nil:
			row := change.update
			_, err = logbook.UpdatePricingRuleTx(
				r.ctx, tx, r.p, row.ID, row.Version, machinelogbook.PricingRuleKind(row.Kind), row.MachineTypeID,
				row.MaterialTypeID, row.Measure, change.rate, true, r.requestID,
			)
		default:
			row := change.deactivate
			_, err = logbook.UpdatePricingRuleTx(
				r.ctx, tx, r.p, row.ID, row.Version, machinelogbook.PricingRuleKind(row.Kind), row.MachineTypeID,
				row.MaterialTypeID, row.Measure, ruleEntry(*row).Rate, false, r.requestID,
			)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func applyPricing(r *run, data *pricingData) (func() error, error) {
	groups, err := loadPricing(r.ctx, r.q)
	if err != nil {
		return nil, err
	}
	var targets targetIDs
	if targets.machineTypes, err = machineTypeIDs(r.ctx, r.q); err != nil {
		return nil, err
	}
	if targets.materialTypes, err = materialTypeIDs(r.ctx, r.q); err != nil {
		return nil, err
	}
	existing := map[string]storedGroup{}
	for _, group := range groups {
		existing[nameKey(group.row.Name)] = group
	}
	fileHasDefault := slices.ContainsFunc(data.Groups, func(g pricingGroupEntry) bool { return g.IsDefault })
	inFile := map[string]bool{}
	for _, item := range data.Groups {
		inFile[nameKey(item.Name)] = true
		current, found := existing[nameKey(item.Name)]
		if found && r.mode == ModeInsert {
			r.skip(item.Name, reasonExists)
			continue
		}
		problem := ""
		for _, rule := range item.Rules {
			if _, _, problem = targets.resolve(rule); problem != "" {
				break
			}
		}
		if problem != "" {
			r.conflict(item.Name, "pricing_target_missing", problem)
			continue
		}
		isDefault := item.IsDefault
		if found && !fileHasDefault {
			isDefault = current.row.IsDefault && item.Active
		}
		if !found {
			changes := planRules(nil, item.Rules)
			_, err = r.attempt(item.Name, ActionCreate, summarizeRules(changes), func(tx pgx.Tx) error {
				created, err := r.svc.MachineLogbook.CreatePricingGroupTx(
					r.ctx, tx, r.p, item.Name, item.Description, isDefault, r.requestID,
				)
				if err != nil {
					return err
				}
				if err := r.applyRuleChanges(tx, created.ID, changes, targets); err != nil {
					return err
				}
				if item.Active {
					return nil
				}
				_, err = r.svc.MachineLogbook.UpdatePricingGroupTx(
					r.ctx, tx, r.p, created.ID, created.Version, item.Name, item.Description, false, false, r.requestID,
				)
				return err
			})
			if err != nil {
				return nil, err
			}
			continue
		}
		changes := planRules(current.rules, item.Rules)
		groupChanged := current.row.Name != item.Name || !sameText(current.row.Description, item.Description) ||
			current.row.Active != item.Active || current.row.IsDefault != isDefault
		if !groupChanged && len(changes) == 0 {
			r.skip(item.Name, reasonUnchanged)
			continue
		}
		_, err = r.attempt(item.Name, ActionUpdate, summarizeRules(changes), func(tx pgx.Tx) error {
			logbook := r.svc.MachineLogbook
			if len(changes) > 0 && !current.row.Active {
				// New rules need an active group; the final state is set below.
				if _, err := logbook.UpdatePricingGroupTx(
					r.ctx, tx, r.p, current.row.ID, current.row.Version, current.row.Name, current.row.Description,
					true, false, r.requestID,
				); err != nil {
					return err
				}
			}
			if err := r.applyRuleChanges(tx, current.row.ID, changes, targets); err != nil {
				return err
			}
			fresh, err := pricingGroupRow(r.ctx, tx, current.row.ID)
			if err != nil {
				return err
			}
			if fresh.Name == item.Name && sameText(fresh.Description, item.Description) && fresh.Active == item.Active &&
				fresh.IsDefault == isDefault {
				return nil
			}
			_, err = logbook.UpdatePricingGroupTx(
				r.ctx, tx, r.p, fresh.ID, fresh.Version, item.Name, item.Description, item.Active, isDefault, r.requestID,
			)
			return err
		})
		if err != nil {
			return nil, err
		}
	}
	if err := applyRolePricingGroups(r, data.RolePricingGroups); err != nil {
		return nil, err
	}
	return func() error {
		for _, group := range groups {
			if inFile[nameKey(group.row.Name)] {
				continue
			}
			fresh, err := pricingGroupRow(r.ctx, r.tx, group.row.ID)
			if err != nil {
				return err
			}
			if !fresh.Active {
				r.keep(fresh.Name, "Pricing groups cannot be deleted; it stays inactive.")
				continue
			}
			if _, err := r.attempt(fresh.Name, ActionDeactivate, "Pricing groups cannot be deleted.", func(tx pgx.Tx) error {
				_, err := r.svc.MachineLogbook.UpdatePricingGroupTx(
					r.ctx, tx, r.p, fresh.ID, fresh.Version, fresh.Name, fresh.Description, false, false, r.requestID,
				)
				return err
			}); err != nil {
				return err
			}
		}
		return nil
	}, nil
}

const rolePricingItem = "Role pricing groups"

func applyRolePricingGroups(r *run, entries []rolePricingEntry) error {
	current, err := r.q.ListRolePricingGroups(r.ctx)
	if err != nil {
		return err
	}
	roleRows, err := r.q.ListRoles(r.ctx)
	if err != nil {
		return err
	}
	roleIDs := map[string]uuid.UUID{}
	for _, row := range roleRows {
		roleIDs[nameKey(row.Name)] = row.ID
	}
	groupRows, err := r.q.ListPricingGroups(r.ctx)
	if err != nil {
		return err
	}
	groupIDs := map[string]uuid.UUID{}
	for _, row := range groupRows {
		groupIDs[nameKey(row.Name)] = row.ID
	}
	currentByRole := map[uuid.UUID]configtransferdb.ListRolePricingGroupsRow{}
	usedPriorities := map[int32]bool{}
	desired := make([]machinelogbook.RolePricingGroupInput, 0, len(current)+len(entries))
	if r.mode == ModeInsert {
		for _, row := range current {
			currentByRole[row.RoleID] = row
			usedPriorities[row.Priority] = true
			desired = append(desired, machinelogbook.RolePricingGroupInput{
				RoleID: row.RoleID, PricingGroupID: row.PricingGroupID, Priority: row.Priority,
			})
		}
	} else {
		for _, row := range current {
			currentByRole[row.RoleID] = row
		}
	}
	items := []Item{}
	inFile := map[uuid.UUID]bool{}
	conflicts := false
	for _, entry := range entries {
		name := entry.Role + " → " + entry.PricingGroup
		roleID, roleFound := roleIDs[nameKey(entry.Role)]
		groupID, groupFound := groupIDs[nameKey(entry.PricingGroup)]
		if !roleFound || !groupFound {
			r.conflict(name, "pricing_mapping_unresolved", "The role or the pricing group does not exist.")
			conflicts = true
			continue
		}
		inFile[roleID] = true
		existing, mapped := currentByRole[roleID]
		switch {
		case r.mode == ModeInsert && mapped:
			items = append(items, Item{Name: name, Action: ActionSkip, Reason: reasonExists})
			continue
		case r.mode == ModeInsert && usedPriorities[entry.Priority]:
			r.conflict(name, "pricing_priority_taken", "Another role already uses this priority.")
			conflicts = true
			continue
		case !mapped:
			items = append(items, Item{Name: name, Action: ActionCreate})
		case existing.PricingGroupID != groupID || existing.Priority != entry.Priority:
			items = append(items, Item{Name: name, Action: ActionUpdate})
		default:
			items = append(items, Item{Name: name, Action: ActionSkip, Reason: reasonUnchanged})
		}
		desired = append(desired, machinelogbook.RolePricingGroupInput{
			RoleID: roleID, PricingGroupID: groupID, Priority: entry.Priority,
		})
	}
	if r.mode == ModeOverwrite {
		for _, row := range current {
			if !inFile[row.RoleID] {
				items = append(items, Item{Name: row.RoleName + " → " + row.PricingGroupName, Action: ActionDelete})
			}
		}
	}
	changed := slices.ContainsFunc(items, func(item Item) bool { return item.Action != ActionSkip })
	if conflicts || !changed {
		for _, item := range items {
			r.report.add(item)
		}
		return nil
	}
	ok, err := r.try(rolePricingItem, func(tx pgx.Tx) error {
		_, err := r.svc.MachineLogbook.SetRolePricingGroupsTx(r.ctx, tx, r.p, desired, r.requestID)
		return err
	})
	if err != nil || !ok {
		return err
	}
	for _, item := range items {
		r.report.add(item)
	}
	return nil
}
