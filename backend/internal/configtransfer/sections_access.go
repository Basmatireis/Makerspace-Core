package configtransfer

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	configtransferdb "github.com/Basmatireis/Makerspace-Core/backend/internal/configtransfer/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Device types: natural key name.

type deviceTypeEntry struct {
	Name        string  `json:"name"`
	Description *string `json:"description"`
}

func deviceTypesSection() section {
	return define(
		SectionDeviceTypes,
		permissions(authorization.ManagedDevicesRead),
		permissions(authorization.ManagedDevicesManage),
		exportDeviceTypes,
		func(items *[]deviceTypeEntry) error {
			names := make([]*string, len(*items))
			for i := range *items {
				names[i] = &(*items)[i].Name
				(*items)[i].Description = trimmed((*items)[i].Description)
			}
			return checkNames("device type", names, 100)
		},
		applyDeviceTypes,
	)
}

func exportDeviceTypes(ctx context.Context, q *configtransferdb.Queries) ([]deviceTypeEntry, error) {
	rows, err := q.ListDeviceTypes(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]deviceTypeEntry, 0, len(rows))
	for _, row := range rows {
		items = append(items, deviceTypeEntry{Name: row.Name, Description: row.Description})
	}
	return items, nil
}

func applyDeviceTypes(r *run, items *[]deviceTypeEntry) (func() error, error) {
	rows, err := r.q.ListDeviceTypes(r.ctx)
	if err != nil {
		return nil, err
	}
	existing := map[string]configtransferdb.ListDeviceTypesRow{}
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
				_, err := r.svc.ManagedDevices.CreateTypeTx(r.ctx, tx, r.p, item.Name, item.Description, r.requestID)
				return err
			})
		case r.mode == ModeInsert:
			r.skip(item.Name, reasonExists)
		case current.Name == item.Name && sameText(current.Description, item.Description):
			r.skip(item.Name, reasonUnchanged)
		default:
			_, err = r.attempt(item.Name, ActionUpdate, "", func(tx pgx.Tx) error {
				_, err := r.svc.ManagedDevices.UpdateTypeTx(
					r.ctx, tx, r.p, current.ID, current.Version, item.Name, item.Description, r.requestID,
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
			inUse, err := r.q.DeviceTypeInUse(r.ctx, row.ID)
			if err != nil {
				return err
			}
			if inUse {
				r.keep(row.Name, "Managed devices, role permissions or visitor enrollment use this device type.")
				continue
			}
			if _, err := r.attempt(row.Name, ActionDelete, "", func(tx pgx.Tx) error {
				return r.svc.ManagedDevices.DeleteTypeTx(r.ctx, tx, r.p, row.ID, row.Version, r.requestID)
			}); err != nil {
				return err
			}
		}
		return nil
	}, nil
}

// Session policies: natural key name. They have no delete path, so an overwrite keeps policies missing from the file.

type sessionPolicyEntry struct {
	Name                    string `json:"name"`
	IdleTimeoutSeconds      int32  `json:"idleTimeoutSeconds"`
	AbsoluteLifetimeSeconds int32  `json:"absoluteLifetimeSeconds"`
	PostSessionDestination  string `json:"postSessionDestination"`
	IsDefault               bool   `json:"isDefault"`
}

func sessionPoliciesSection() section {
	return define(
		SectionSessionPolicies,
		permissions(authorization.ManagedDevicesRead),
		permissions(authorization.SessionPoliciesManage),
		exportSessionPolicies,
		func(items *[]sessionPolicyEntry) error {
			names := make([]*string, len(*items))
			defaults := 0
			for i := range *items {
				names[i] = &(*items)[i].Name
				if (*items)[i].IsDefault {
					defaults++
				}
			}
			if defaults > 1 {
				return errors.New("at most one session policy can be the default")
			}
			return checkNames("session policy", names, 120)
		},
		applySessionPolicies,
	)
}

func exportSessionPolicies(ctx context.Context, q *configtransferdb.Queries) ([]sessionPolicyEntry, error) {
	rows, err := q.ListSessionPolicies(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]sessionPolicyEntry, 0, len(rows))
	for _, row := range rows {
		items = append(items, sessionPolicyEntry{
			Name:                    row.Name,
			IdleTimeoutSeconds:      row.IdleTimeoutSeconds,
			AbsoluteLifetimeSeconds: row.AbsoluteLifetimeSeconds,
			PostSessionDestination:  row.PostSessionDestination,
			IsDefault:               row.IsDefault,
		})
	}
	return items, nil
}

func applySessionPolicies(r *run, items *[]sessionPolicyEntry) (func() error, error) {
	rows, err := r.q.ListSessionPolicies(r.ctx)
	if err != nil {
		return nil, err
	}
	fileHasDefault := slices.ContainsFunc(*items, func(item sessionPolicyEntry) bool { return item.IsDefault })
	// The default policy goes first: the service only lets a policy stop being the default by making another one the
	// default.
	ordered := slices.Clone(*items)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].IsDefault && !ordered[j].IsDefault })
	inFile := map[string]bool{}
	for _, item := range ordered {
		inFile[nameKey(item.Name)] = true
		// Policies are re-read for every entry: making one the default clears the flag of the previous default.
		fresh, err := r.q.ListSessionPolicies(r.ctx)
		if err != nil {
			return nil, err
		}
		var current configtransferdb.ListSessionPoliciesRow
		found := false
		for _, row := range fresh {
			if nameKey(row.Name) == nameKey(item.Name) {
				current, found = row, true
			}
		}
		input := manageddevices.SessionPolicyInput{
			Name:                    item.Name,
			IdleTimeoutSeconds:      item.IdleTimeoutSeconds,
			AbsoluteLifetimeSeconds: item.AbsoluteLifetimeSeconds,
			PostSessionDestination:  manageddevices.Destination(item.PostSessionDestination),
			IsDefault:               item.IsDefault,
		}
		if found && !fileHasDefault {
			// A file without a default leaves the current default where it is.
			input.IsDefault = current.IsDefault
		}
		switch {
		case !found:
			_, err = r.attempt(item.Name, ActionCreate, "", func(tx pgx.Tx) error {
				_, err := r.svc.ManagedDevices.CreateSessionPolicyTx(r.ctx, tx, r.p, input, r.requestID)
				return err
			})
		case r.mode == ModeInsert:
			r.skip(item.Name, reasonExists)
		case current.Name == input.Name && current.IdleTimeoutSeconds == input.IdleTimeoutSeconds &&
			current.AbsoluteLifetimeSeconds == input.AbsoluteLifetimeSeconds &&
			current.PostSessionDestination == string(input.PostSessionDestination) &&
			current.IsDefault == input.IsDefault:
			r.skip(item.Name, reasonUnchanged)
		default:
			input.ExpectedVersion = current.Version
			_, err = r.attempt(item.Name, ActionUpdate, "Sessions using this policy are signed out.", func(tx pgx.Tx) error {
				_, err := r.svc.ManagedDevices.UpdateSessionPolicyTx(r.ctx, tx, r.p, current.ID, input, r.requestID)
				return err
			})
		}
		if err != nil {
			return nil, err
		}
	}
	return func() error {
		for _, row := range rows {
			if !inFile[nameKey(row.Name)] {
				r.keep(row.Name, "Session policies cannot be deleted.")
			}
		}
		return nil
	}, nil
}

// Roles: natural key name. The system role master is never exported, imported, changed or deleted. Grants name
// device types by name.

type permissionGrantEntry struct {
	Permission       string `json:"permission"`
	Scope            string `json:"scope"`
	MinimumAssurance string `json:"minimumAssurance"`
	// ReauthWithinMinutes is absent in files exported before grants could require a fresh sign-in; absent means
	// none.
	ReauthWithinMinutes *int     `json:"reauthWithinMinutes,omitempty"`
	DeviceTypes         []string `json:"deviceTypes"`
}

type roleEntry struct {
	Name                 string  `json:"name"`
	Description          *string `json:"description"`
	ProfileImageRequired bool    `json:"profileImageRequired"`
	LabRulesMode         string  `json:"labRulesMode"`
	StaffingLevel        *string `json:"staffingLevel"`
	// MinOpenDaysPerSemester is absent in files exported before roles could override the minimum; absent means the
	// general minimum.
	MinOpenDaysPerSemester *int                   `json:"minOpenDaysPerSemester"`
	Permissions            []permissionGrantEntry `json:"permissions"`
}

func rolesSection() section {
	return define(
		SectionRoles,
		permissions(authorization.RolesRead),
		permissions(authorization.RolesManage),
		exportRoles,
		validateRoles,
		applyRoles,
	)
}

func validateRoles(items *[]roleEntry) error {
	names := make([]*string, len(*items))
	for i := range *items {
		item := &(*items)[i]
		names[i] = &item.Name
		if strings.EqualFold(strings.TrimSpace(item.Name), string(authorization.SystemKeyMaster)) {
			return errors.New("the system role master cannot be imported")
		}
		item.Description = trimmed(item.Description)
		if item.MinOpenDaysPerSemester != nil {
			if *item.MinOpenDaysPerSemester < 0 || *item.MinOpenDaysPerSemester > roles.MaxMinOpenDaysPerSemester {
				return fmt.Errorf("role %q: minOpenDaysPerSemester must be between 0 and 20", item.Name)
			}
			if item.StaffingLevel == nil {
				return fmt.Errorf("role %q: minOpenDaysPerSemester requires a staffing level", item.Name)
			}
		}
		if len(item.Permissions) > 1000 {
			return fmt.Errorf("role %q has too many permissions", item.Name)
		}
		for j := range item.Permissions {
			grant := &item.Permissions[j]
			if grant.Scope == "" {
				grant.Scope = string(authorization.GrantEverywhere)
			}
			if grant.MinimumAssurance == "" {
				grant.MinimumAssurance = string(authorization.AssuranceLow)
			}
			if !authorization.ValidReauthWindow(grant.ReauthWithinMinutes) {
				return fmt.Errorf("role %q: reauthWithinMinutes must be between 1 and 1440", item.Name)
			}
			if grant.DeviceTypes == nil {
				grant.DeviceTypes = []string{}
			}
			for k := range grant.DeviceTypes {
				grant.DeviceTypes[k] = strings.TrimSpace(grant.DeviceTypes[k])
			}
		}
	}
	return checkNames("role", names, 100)
}

func grantKey(grant permissionGrantEntry) string {
	types := make([]string, 0, len(grant.DeviceTypes))
	for _, name := range grant.DeviceTypes {
		types = append(types, nameKey(name))
	}
	sort.Strings(types)
	reauth := ""
	if grant.ReauthWithinMinutes != nil {
		reauth = strconv.Itoa(*grant.ReauthWithinMinutes)
	}
	return grant.Permission + "\x00" + grant.Scope + "\x00" + grant.MinimumAssurance + "\x00" + reauth + "\x00" +
		strings.Join(types, "\x01")
}

func sameGrants(a, b []permissionGrantEntry) bool {
	if len(a) != len(b) {
		return false
	}
	left, right := make([]string, len(a)), make([]string, len(b))
	for i := range a {
		left[i], right[i] = grantKey(a[i]), grantKey(b[i])
	}
	sort.Strings(left)
	sort.Strings(right)
	return slices.Equal(left, right)
}

// storedRole is a configurable role with its grants as they are exported.
type storedRole struct {
	row   configtransferdb.ListRolesRow
	entry roleEntry
}

func loadRoles(ctx context.Context, q *configtransferdb.Queries) ([]storedRole, error) {
	rows, err := q.ListRoles(ctx)
	if err != nil {
		return nil, err
	}
	grantRows, err := q.ListRolePermissionGrants(ctx)
	if err != nil {
		return nil, err
	}
	grants := map[uuid.UUID][]permissionGrantEntry{}
	index := map[uuid.UUID]int{}
	for _, row := range grantRows {
		position, seen := index[row.ID]
		if !seen {
			grants[row.RoleID] = append(grants[row.RoleID], permissionGrantEntry{
				Permission:          row.PermissionID,
				Scope:               row.Scope,
				MinimumAssurance:    row.MinimumAssurance,
				ReauthWithinMinutes: authorization.ReauthWindowFromDB(row.ReauthWithinMinutes),
				DeviceTypes:         []string{},
			})
			position = len(grants[row.RoleID]) - 1
			index[row.ID] = position
		}
		if row.DeviceTypeName != nil {
			list := grants[row.RoleID]
			list[position].DeviceTypes = append(list[position].DeviceTypes, *row.DeviceTypeName)
		}
	}
	result := make([]storedRole, 0, len(rows))
	for _, row := range rows {
		if row.SystemKey != nil {
			continue
		}
		roleGrants := grants[row.ID]
		if roleGrants == nil {
			roleGrants = []permissionGrantEntry{}
		}
		sort.SliceStable(roleGrants, func(i, j int) bool { return grantKey(roleGrants[i]) < grantKey(roleGrants[j]) })
		result = append(result, storedRole{row: row, entry: roleEntry{
			Name:                   row.Name,
			Description:            row.Description,
			ProfileImageRequired:   row.ProfileImageRequired,
			LabRulesMode:           row.LaborordnungMode,
			StaffingLevel:          row.StaffingLevel,
			MinOpenDaysPerSemester: intFromInt32(row.MinOpenDaysPerSemester),
			Permissions:            roleGrants,
		}})
	}
	return result, nil
}

func exportRoles(ctx context.Context, q *configtransferdb.Queries) ([]roleEntry, error) {
	stored, err := loadRoles(ctx, q)
	if err != nil {
		return nil, err
	}
	items := make([]roleEntry, 0, len(stored))
	for _, role := range stored {
		items = append(items, role.entry)
	}
	return items, nil
}

// resolveGrants turns file grants into service grants; an unknown device type name is a conflict of the role.
func resolveGrants(
	entries []permissionGrantEntry,
	deviceTypes map[string]uuid.UUID,
) ([]authorization.PermissionGrant, string) {
	grants := make([]authorization.PermissionGrant, 0, len(entries))
	for _, entry := range entries {
		grant := authorization.PermissionGrant{
			PermissionID:        authorization.Permission(entry.Permission),
			Scope:               authorization.GrantScope(entry.Scope),
			MinimumAssurance:    authorization.Assurance(entry.MinimumAssurance),
			ReauthWithinMinutes: entry.ReauthWithinMinutes,
		}
		for _, name := range entry.DeviceTypes {
			id, ok := deviceTypes[nameKey(name)]
			if !ok {
				return nil, fmt.Sprintf("The device type %q does not exist.", name)
			}
			grant.DeviceTypeIDs = append(grant.DeviceTypeIDs, id)
		}
		grants = append(grants, grant)
	}
	return grants, ""
}

func deviceTypeIDs(ctx context.Context, q *configtransferdb.Queries) (map[string]uuid.UUID, error) {
	rows, err := q.ListDeviceTypes(ctx)
	if err != nil {
		return nil, err
	}
	result := make(map[string]uuid.UUID, len(rows))
	for _, row := range rows {
		result[nameKey(row.Name)] = row.ID
	}
	return result, nil
}

func applyRoles(r *run, items *[]roleEntry) (func() error, error) {
	stored, err := loadRoles(r.ctx, r.q)
	if err != nil {
		return nil, err
	}
	existing := map[string]storedRole{}
	for _, role := range stored {
		existing[nameKey(role.row.Name)] = role
	}
	deviceTypes, err := deviceTypeIDs(r.ctx, r.q)
	if err != nil {
		return nil, err
	}
	inFile := map[string]bool{}
	for _, item := range *items {
		inFile[nameKey(item.Name)] = true
		current, found := existing[nameKey(item.Name)]
		if found && r.mode == ModeInsert {
			r.skip(item.Name, reasonExists)
			continue
		}
		if found && roleUnchanged(current.entry, item) {
			r.skip(item.Name, reasonUnchanged)
			continue
		}
		grants, problem := resolveGrants(item.Permissions, deviceTypes)
		if problem != "" {
			r.conflict(item.Name, "device_type_missing", problem)
			continue
		}
		mode := laborordnung.Mode(item.LabRulesMode)
		level := (*roles.StaffingLevel)(item.StaffingLevel)
		if !found {
			_, err = r.attempt(item.Name, ActionCreate, "", func(tx pgx.Tx) error {
				_, err := r.svc.Roles.CreateWithBehaviorsTx(
					r.ctx, tx, r.p, item.Name, item.Description, grants, item.ProfileImageRequired, mode, level,
					item.MinOpenDaysPerSemester, r.requestID,
				)
				return err
			})
		} else {
			_, err = r.attempt(item.Name, ActionUpdate, "", func(tx pgx.Tx) error {
				version := current.row.Version
				if !roleBehaviorsEqual(current.entry, item) {
					updated, err := r.svc.Roles.UpdateWithBehaviorsTx(
						r.ctx, tx, r.p, current.row.ID, version, &item.Name, true, item.Description,
						&item.ProfileImageRequired, &mode, true, level, true, item.MinOpenDaysPerSemester, r.requestID,
					)
					if err != nil {
						return err
					}
					version = updated.Version
				}
				if !sameGrants(current.entry.Permissions, item.Permissions) {
					_, err := r.svc.Roles.ReplacePermissionsTx(r.ctx, tx, r.p, current.row.ID, version, grants, r.requestID)
					return err
				}
				return nil
			})
		}
		if err != nil {
			return nil, err
		}
	}
	return func() error {
		for _, role := range stored {
			if inFile[nameKey(role.row.Name)] {
				continue
			}
			inUse, err := r.q.RoleInUse(r.ctx, role.row.ID)
			if err != nil {
				return err
			}
			if inUse {
				r.keep(role.row.Name, "People, visitor enrollment or staffing requirements use this role.")
				continue
			}
			if _, err := r.attempt(role.row.Name, ActionDelete, "", func(tx pgx.Tx) error {
				return r.svc.Roles.DeleteTx(r.ctx, tx, r.p, role.row.ID, role.row.Version, r.requestID)
			}); err != nil {
				return err
			}
		}
		return nil
	}, nil
}

func roleBehaviorsEqual(current, item roleEntry) bool {
	return current.Name == item.Name && sameText(current.Description, item.Description) &&
		current.ProfileImageRequired == item.ProfileImageRequired && current.LabRulesMode == item.LabRulesMode &&
		sameText(current.StaffingLevel, item.StaffingLevel) &&
		sameOptionalInt(current.MinOpenDaysPerSemester, item.MinOpenDaysPerSemester)
}

func sameOptionalInt(a, b *int) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func intFromInt32(value *int32) *int {
	if value == nil {
		return nil
	}
	converted := int(*value)
	return &converted
}

func roleUnchanged(current, item roleEntry) bool {
	return roleBehaviorsEqual(current, item) && sameGrants(current.Permissions, item.Permissions)
}
