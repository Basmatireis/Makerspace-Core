package scim

import (
	"context"
	"errors"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accounts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	scimdb "github.com/Basmatireis/Makerspace-Core/backend/internal/scim/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) PreflightReconciliation(
	ctx context.Context,
	principal authorization.Principal,
	provisionalID, targetID uuid.UUID,
) (ReconciliationReport, error) {
	if !principal.Has(authorization.SCIMManage) {
		return ReconciliationReport{}, apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ReconciliationReport{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	return analyzeReconciliation(ctx, tx, principal, provisionalID, targetID)
}

func (s *Service) Reconcile(
	ctx context.Context,
	principal authorization.Principal,
	provisionalID, targetID uuid.UUID,
	requestID *uuid.UUID,
) (ReconciliationReport, error) {
	if !principal.Has(authorization.SCIMManage) {
		return ReconciliationReport{}, apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ReconciliationReport{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := scimdb.New(tx)
	report, err := analyzeReconciliation(ctx, tx, principal, provisionalID, targetID)
	if err != nil || !report.CanReconcile {
		return report, err
	}
	source, err := queries.GetReconciliationAccount(ctx, provisionalID)
	if err != nil {
		return report, err
	}
	target, err := queries.GetReconciliationAccount(ctx, targetID)
	if err != nil {
		return report, err
	}
	if err := queries.DeduplicateOpenDayAssignments(
		ctx,
		scimdb.DeduplicateOpenDayAssignmentsParams{SourcePersonID: source.PersonID, TargetPersonID: target.PersonID},
	); err != nil {
		return report, err
	}
	if err := queries.MoveOpenDayAssignments(
		ctx,
		scimdb.MoveOpenDayAssignmentsParams{TargetPersonID: target.PersonID, SourcePersonID: source.PersonID},
	); err != nil {
		return report, err
	}
	if err := queries.DeduplicatePendingLabRuleRequests(
		ctx,
		scimdb.DeduplicatePendingLabRuleRequestsParams{
			SourcePersonID: source.PersonID,
			TargetPersonID: target.PersonID,
		},
	); err != nil {
		return report, err
	}
	if err := queries.MoveLabRuleRequests(
		ctx,
		scimdb.MoveLabRuleRequestsParams{TargetPersonID: target.PersonID, SourcePersonID: source.PersonID},
	); err != nil {
		return report, err
	}
	if err := queries.TransferProfileImage(
		ctx,
		scimdb.TransferProfileImageParams{TargetPersonID: target.PersonID, SourcePersonID: source.PersonID},
	); err != nil {
		return report, err
	}
	if err := queries.TransferExternalIdentities(
		ctx,
		scimdb.TransferExternalIdentitiesParams{TargetAccountID: targetID, SourceAccountID: provisionalID},
	); err != nil {
		return report, err
	}
	if err := queries.TransferPersonRoles(
		ctx,
		scimdb.TransferPersonRolesParams{
			TargetPersonID:      target.PersonID,
			SourcePersonID:      source.PersonID,
			AssignedByAccountID: &principal.AccountID,
		},
	); err != nil {
		return report, err
	}
	if err := queries.BumpReconciledPersonVersion(ctx, target.PersonID); err != nil {
		return report, err
	}
	if err := accounts.ProtectProvisionedAccountDeactivation(ctx, tx, provisionalID); err != nil {
		if apperror.IsCode(err, "last_master_required") {
			report.CanReconcile = false
			report.Conflicts = append(
				report.Conflicts,
				Conflict{Code: "last_master", Message: "Reconciliation must retain an enabled master Account."},
			)
			return report, nil
		}
		return report, err
	}
	if err := queries.BumpReconciledAccountVersion(ctx, targetID); err != nil {
		return report, err
	}
	if err := queries.TransferSCIMMappings(
		ctx,
		scimdb.TransferSCIMMappingsParams{
			TargetAccountID: targetID,
			TargetPersonID:  target.PersonID,
			SourceAccountID: provisionalID,
		},
	); err != nil {
		return report, err
	}
	if err := queries.RevokeProvisionalSessions(ctx, provisionalID); err != nil {
		return report, err
	}
	if err := queries.DeleteReconciledAccount(ctx, provisionalID); err != nil {
		return report, err
	}
	if err := queries.DeleteReconciledPerson(ctx, source.PersonID); err != nil {
		return report, err
	}
	actor := principal.AccountID
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "scim.account_reconciled",
			ResourceType:   "account",
			ResourceID:     &targetID,
			RequestID:      requestID,
			ChangedFields:  []string{"externalIdentities", "roles", "scimMapping", "domainRelations"},
		},
	); err != nil {
		return report, err
	}
	if err := tx.Commit(ctx); err != nil {
		return report, err
	}
	report.Completed = true
	return report, nil
}

func analyzeReconciliation(
	ctx context.Context,
	tx pgx.Tx,
	principal authorization.Principal,
	provisionalID, targetID uuid.UUID,
) (ReconciliationReport, error) {
	report := ReconciliationReport{
		ProvisionalAccountID: provisionalID,
		TargetAccountID:      targetID,
		Conflicts:            []Conflict{},
	}
	if provisionalID == targetID {
		return report, apperror.Validation
	}
	queries := scimdb.New(tx)
	// Match Person deletion's person -> master invariant -> account lock order.
	if err := queries.LockReconciliationPeople(
		ctx,
		scimdb.LockReconciliationPeopleParams{SourceAccountID: provisionalID, TargetAccountID: targetID},
	); err != nil {
		return report, err
	}
	for _, id := range []uuid.UUID{provisionalID, targetID} {
		if err := accounts.LockProvisionedAccount(ctx, tx, id); errors.Is(err, pgx.ErrNoRows) {
			return report, apperror.NotFound
		} else if err != nil {
			return report, err
		}
	}
	source, err := queries.GetReconciliationAccount(ctx, provisionalID)
	if errors.Is(err, pgx.ErrNoRows) {
		return report, apperror.NotFound
	}
	if err != nil {
		return report, err
	}
	target, err := queries.GetReconciliationAccount(ctx, targetID)
	if errors.Is(err, pgx.ErrNoRows) {
		return report, apperror.NotFound
	}
	if err != nil {
		return report, err
	}
	if source.ProvisioningSource != "scim" || source.FirstAuthenticatedAt.Valid {
		report.Conflicts = append(
			report.Conflicts,
			Conflict{
				Code:    "source_not_provisional",
				Message: "Only a SCIM Account that has never authenticated can be reconciled.",
			},
		)
	}
	if err := people.ValidateProvisionedRoleTransfer(ctx, tx, principal, source.PersonID); err != nil {
		if apperror.IsCode(err, "master_role_transfer") {
			report.Conflicts = append(
				report.Conflicts,
				Conflict{
					Code:    "master_role_transfer",
					Message: "The master role must never be transferred by SCIM reconciliation.",
				},
			)
		} else if apperror.IsCode(err, "permission_denied") {
			report.Conflicts = append(
				report.Conflicts,
				Conflict{
					Code:    "role_transfer_forbidden",
					Message: "Role transfer requires people.roles.assign and authority to delegate every source role.",
				},
			)
		} else {
			return report, err
		}
	}
	mappings, err := queries.CountSCIMMappingsForAccount(ctx, provisionalID)
	if err != nil {
		return report, err
	}
	if mappings == 0 {
		report.Conflicts = append(
			report.Conflicts,
			Conflict{Code: "source_mapping_missing", Message: "The source Account has no SCIM mapping."},
		)
	}
	locals, err := queries.CountLocalIdentitiesForAccount(ctx, provisionalID)
	if err != nil {
		return report, err
	}
	if locals > 0 {
		report.Conflicts = append(
			report.Conflicts,
			Conflict{
				Code:    "source_local_authentication",
				Message: "The provisional Account has local password or PIN methods that cannot be transferred safely.",
			},
		)
	}
	if source.ProfileImageFileID != nil && target.ProfileImageFileID != nil &&
		*source.ProfileImageFileID != *target.ProfileImageFileID {
		report.Conflicts = append(
			report.Conflicts,
			Conflict{
				Code:       "profile_image_conflict",
				ResourceID: source.ProfileImageFileID,
				Message:    "Both People have different profile images.",
			},
		)
	}
	connectorConflicts, err := queries.ListSCIMMappingConnectorConflicts(
		ctx,
		scimdb.ListSCIMMappingConnectorConflictsParams{SourceAccountID: provisionalID, TargetAccountID: targetID},
	)
	if err != nil {
		return report, err
	}
	for _, id := range connectorConflicts {
		id := id
		report.Conflicts = append(
			report.Conflicts,
			Conflict{
				Code:       "connector_mapping_conflict",
				ResourceID: &id,
				Message:    "Both Accounts have a mapping for the same SCIM connector.",
			},
		)
	}
	openDays, err := queries.ListOpenDayReconciliationConflicts(
		ctx,
		scimdb.ListOpenDayReconciliationConflictsParams{
			SourcePersonID: source.PersonID,
			TargetPersonID: target.PersonID,
		},
	)
	if err != nil {
		return report, err
	}
	for _, id := range openDays {
		id := id
		report.Conflicts = append(
			report.Conflicts,
			Conflict{
				Code:       "open_day_assignment_conflict",
				ResourceID: &id,
				Message:    "The People hold different positions on the same Open Day.",
			},
		)
	}
	labRules, err := queries.ListPendingLabRuleConflicts(
		ctx,
		scimdb.ListPendingLabRuleConflictsParams{SourcePersonID: source.PersonID, TargetPersonID: target.PersonID},
	)
	if err != nil {
		return report, err
	}
	for _, id := range labRules {
		id := id
		report.Conflicts = append(
			report.Conflicts,
			Conflict{
				Code:       "lab_rules_request_conflict",
				ResourceID: &id,
				Message:    "The People have pending requests for different Lab Rules versions.",
			},
		)
	}
	report.CanReconcile = len(report.Conflicts) == 0
	return report, nil
}
