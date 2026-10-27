package roles

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	rolesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/roles/db"
	"github.com/google/uuid"
)

// masterPolicyFreshness is how recent a master's multi-factor sign-in must be to change the master policy.
const masterPolicyFreshness = 10 * time.Minute

// maxMasterPolicyEntries bounds the master fresh-sign-in policy.
const maxMasterPolicyEntries = 500

// MasterReauthenticationEntry is a permission that a master may use only after a fresh multi-factor sign-in.
type MasterReauthenticationEntry struct {
	Permission    authorization.Permission
	WithinMinutes int
}

// MasterReauthenticationPolicy lists the master role's fresh-sign-in requirements.
func (s *Service) MasterReauthenticationPolicy(
	ctx context.Context,
	principal authorization.Principal,
) ([]MasterReauthenticationEntry, error) {
	if !principal.Has(authorization.RolesRead) {
		return nil, apperror.PermissionDenied
	}
	return listMasterPolicy(ctx, rolesdb.New(s.pool))
}

func listMasterPolicy(ctx context.Context, queries *rolesdb.Queries) ([]MasterReauthenticationEntry, error) {
	rows, err := queries.ListMasterReauthenticationPolicy(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]MasterReauthenticationEntry, 0, len(rows))
	for _, row := range rows {
		permission := authorization.Permission(row.PermissionID)
		if !authorization.Known(permission) {
			continue
		}
		result = append(result, MasterReauthenticationEntry{Permission: permission, WithinMinutes: int(row.WithinMinutes)})
	}
	return result, nil
}

// ReplaceMasterReauthenticationPolicy is reserved to masters with a fresh multi-factor sign-in, because it relaxes
// or tightens what every master can do with an older session.
func (s *Service) ReplaceMasterReauthenticationPolicy(
	ctx context.Context,
	principal authorization.Principal,
	entries []MasterReauthenticationEntry,
	requestID *uuid.UUID,
) ([]MasterReauthenticationEntry, error) {
	if !principal.Master {
		return nil, apperror.PermissionDenied
	}
	if !principal.HasFreshAssurance(authorization.AssuranceStrongMFA, masterPolicyFreshness, time.Now()) {
		return nil, auth.ReauthenticationRequired(authorization.AssuranceStrongMFA, masterPolicyFreshness)
	}
	if len(entries) > maxMasterPolicyEntries {
		return nil, apperror.InvalidField("too many entries")
	}
	seen := make(map[authorization.Permission]struct{}, len(entries))
	for _, entry := range entries {
		if !authorization.Known(entry.Permission) {
			return nil, apperror.InvalidField("unknown permission: " + string(entry.Permission))
		}
		window := entry.WithinMinutes
		if !authorization.ValidReauthWindow(&window) {
			return nil, apperror.InvalidField("withinMinutes must be between 1 and 1440")
		}
		if _, duplicate := seen[entry.Permission]; duplicate {
			return nil, apperror.InvalidField("duplicate permission")
		}
		seen[entry.Permission] = struct{}{}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := rolesdb.New(tx)
	if err := queries.LockMasterReauthenticationPolicy(ctx); err != nil {
		return nil, err
	}
	if err := queries.DeleteMasterReauthenticationPolicy(ctx); err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if err := queries.InsertMasterReauthenticationPermission(ctx, rolesdb.InsertMasterReauthenticationPermissionParams{
			PermissionID:  string(entry.Permission),
			WithinMinutes: int32(entry.WithinMinutes), //nolint:gosec // validated to 1..1440 above
		}); err != nil {
			return nil, err
		}
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor, Action: "roles.master_reauthentication_policy_replaced",
		ResourceType: "master_reauthentication_policy", RequestID: requestID,
		ChangedFields: []string{"permissions"},
	}); err != nil {
		return nil, err
	}
	result, err := listMasterPolicy(ctx, queries)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}
