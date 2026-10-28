package privacy

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	privacydb "github.com/Basmatireis/Makerspace-Core/backend/internal/privacy/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Policy statuses.
const (
	PolicyDraft    = "draft"
	PolicyApproved = "approved"
	PolicyActive   = "active"
	PolicyRetired  = "retired"
)

// Policy is one version of a category's retention decision.
type Policy struct {
	ID             uuid.UUID
	Category       CategoryID
	Version        int32
	Trigger        Trigger
	PeriodDays     int32
	Action         Action
	Purpose        string
	LegalBasis     string
	Reason         string
	Status         string
	SourceTemplate *string
	CreatedAt      time.Time
	UpdatedAt      time.Time
	ApprovedAt     *time.Time
	ActivatedAt    *time.Time
	RetiredAt      *time.Time
	CreatedBy      *uuid.UUID
	ApprovedBy     *uuid.UUID
	ActivatedBy    *uuid.UUID
}

// PolicyInput creates or edits a draft.
type PolicyInput struct {
	Category   CategoryID
	Trigger    Trigger
	PeriodDays int32
	Action     Action
	Purpose    string
	LegalBasis string
	Reason     string
}

// Hold suspends retention for a category or a person.
type Hold struct {
	ID         uuid.UUID
	Category   *CategoryID
	PersonID   *uuid.UUID
	Reason     string
	CreatedAt  time.Time
	CreatedBy  *uuid.UUID
	ReleasedAt *time.Time
	ReleasedBy *uuid.UUID
}

func policyFrom(row privacydb.PrivacyPolicyVersion) Policy {
	policy := Policy{
		ID: row.ID, Category: CategoryID(row.CategoryID), Version: row.Version, Trigger: Trigger(row.Trigger),
		PeriodDays: row.PeriodDays, Action: Action(row.Action), Purpose: row.Purpose, LegalBasis: row.LegalBasis,
		Reason: row.Reason, Status: row.Status, SourceTemplate: row.SourceTemplate, CreatedAt: row.CreatedAt,
		UpdatedAt: row.UpdatedAt, CreatedBy: row.CreatedByAccountID, ApprovedBy: row.ApprovedByAccountID,
		ActivatedBy: row.ActivatedByAccountID,
	}
	if row.ApprovedAt.Valid {
		at := row.ApprovedAt.Time
		policy.ApprovedAt = &at
	}
	if row.ActivatedAt.Valid {
		at := row.ActivatedAt.Time
		policy.ActivatedAt = &at
	}
	if row.RetiredAt.Valid {
		at := row.RetiredAt.Time
		policy.RetiredAt = &at
	}
	return policy
}

func holdFrom(row privacydb.PrivacyRetentionHold) Hold {
	hold := Hold{
		ID: row.ID, PersonID: row.SubjectPersonID, Reason: row.Reason, CreatedAt: row.CreatedAt,
		CreatedBy: row.CreatedByAccountID, ReleasedBy: row.ReleasedByAccountID,
	}
	if row.CategoryID != nil {
		category := CategoryID(*row.CategoryID)
		hold.Category = &category
	}
	if row.ReleasedAt.Valid {
		at := row.ReleasedAt.Time
		hold.ReleasedAt = &at
	}
	return hold
}

// ListPolicies returns every policy version (privacy.read).
func (s *Service) ListPolicies(ctx context.Context, p authorization.Principal) ([]Policy, error) {
	if !p.Has(authorization.PrivacyRead) {
		return nil, apperror.PermissionDenied
	}
	if err := s.EnsurePolicyDrafts(ctx); err != nil {
		return nil, err
	}
	rows, err := privacydb.New(s.pool).ListPolicies(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]Policy, 0, len(rows))
	for _, row := range rows {
		result = append(result, policyFrom(row))
	}
	return result, nil
}

func (s *Service) validatePolicyInput(input PolicyInput) (Definition, error) {
	definition, known := s.catalog.Lookup(input.Category)
	if !known {
		return Definition{}, apperror.InvalidField("unknown category")
	}
	if !definition.Supports(input.Trigger, input.Action) {
		return Definition{}, apperror.InvalidField("the category does not support this trigger and action")
	}
	if input.PeriodDays < 0 || input.PeriodDays > 36500 {
		return Definition{}, apperror.InvalidField("periodDays must be between 0 and 36500")
	}
	if len(input.Purpose) > 1000 || len(input.LegalBasis) > 500 || len(input.Reason) > 2000 {
		return Definition{}, apperror.InvalidField("purpose, legalBasis or reason is too long")
	}
	return definition, nil
}

// CreatePolicy adds a draft version for a category (privacy.policies.manage).
func (s *Service) CreatePolicy(ctx context.Context, p authorization.Principal, input PolicyInput, requestID *uuid.UUID) (result Policy, err error) {
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.CreatePolicyTx(ctx, tx, p, input, requestID)
		return err
	})
	return result, err
}

// CreatePolicyTx is CreatePolicy inside the caller's transaction.
func (s *Service) CreatePolicyTx(
	ctx context.Context, tx pgx.Tx, p authorization.Principal, input PolicyInput, requestID *uuid.UUID,
) (Policy, error) {
	if !p.Has(authorization.PrivacyPoliciesManage) {
		return Policy{}, apperror.PermissionDenied
	}
	if _, err := s.validatePolicyInput(input); err != nil {
		return Policy{}, err
	}
	q := privacydb.New(tx)
	if _, err := q.LockCategoryPolicies(ctx, string(input.Category)); err != nil {
		return Policy{}, err
	}
	version, err := q.NextPolicyVersion(ctx, string(input.Category))
	if err != nil {
		return Policy{}, err
	}
	row, err := q.InsertPolicy(ctx, privacydb.InsertPolicyParams{
		ID: ids.New(), CategoryID: string(input.Category), Version: version,
		Trigger: string(input.Trigger), PeriodDays: input.PeriodDays, Action: string(input.Action),
		Purpose: strings.TrimSpace(input.Purpose), LegalBasis: strings.TrimSpace(input.LegalBasis),
		Reason: strings.TrimSpace(input.Reason), CreatedByAccountID: &p.AccountID,
	})
	if err != nil {
		return Policy{}, err
	}
	if err := s.auditPolicy(ctx, tx, p, "privacy.policy_created", row.ID, requestID, "trigger", "periodDays", "action"); err != nil {
		return Policy{}, err
	}
	return policyFrom(row), nil
}

// UpdatePolicy edits a draft (privacy.policies.manage).
func (s *Service) UpdatePolicy(
	ctx context.Context, p authorization.Principal, id uuid.UUID, input PolicyInput, requestID *uuid.UUID,
) (result Policy, err error) {
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.UpdatePolicyTx(ctx, tx, p, id, input, requestID)
		return err
	})
	return result, err
}

// UpdatePolicyTx is UpdatePolicy inside the caller's transaction.
func (s *Service) UpdatePolicyTx(
	ctx context.Context, tx pgx.Tx, p authorization.Principal, id uuid.UUID, input PolicyInput, requestID *uuid.UUID,
) (Policy, error) {
	if !p.Has(authorization.PrivacyPoliciesManage) {
		return Policy{}, apperror.PermissionDenied
	}
	q := privacydb.New(tx)
	current, err := q.LockPolicy(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Policy{}, apperror.NotFound
	}
	if err != nil {
		return Policy{}, err
	}
	if current.Status != PolicyDraft {
		return Policy{}, apperror.Conflicting("policy_not_draft", "Only draft policies can be edited; create a new version instead")
	}
	input.Category = CategoryID(current.CategoryID)
	if _, err := s.validatePolicyInput(input); err != nil {
		return Policy{}, err
	}
	row, err := q.UpdateDraftPolicy(ctx, privacydb.UpdateDraftPolicyParams{
		Trigger: string(input.Trigger), PeriodDays: input.PeriodDays, Action: string(input.Action),
		Purpose: strings.TrimSpace(input.Purpose), LegalBasis: strings.TrimSpace(input.LegalBasis),
		Reason: strings.TrimSpace(input.Reason), ID: id,
	})
	if err != nil {
		return Policy{}, err
	}
	if err := s.auditPolicy(ctx, tx, p, "privacy.policy_updated", row.ID, requestID, "trigger", "periodDays", "action"); err != nil {
		return Policy{}, err
	}
	return policyFrom(row), nil
}

// TransitionPolicy approves, activates or retires a version (privacy.policies.manage).
// Activation requires purpose, legal basis and reason, retires the previously
// active version of the category, and is refused for retain_with_review
// policies without a reason.
func (s *Service) TransitionPolicy(ctx context.Context, p authorization.Principal, id uuid.UUID, target string, requestID *uuid.UUID) (Policy, error) {
	if !p.Has(authorization.PrivacyPoliciesManage) {
		return Policy{}, apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Policy{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := privacydb.New(tx)
	current, err := q.LockPolicy(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Policy{}, apperror.NotFound
	}
	if err != nil {
		return Policy{}, err
	}
	var row privacydb.PrivacyPolicyVersion
	var action string
	switch target {
	case PolicyApproved:
		if current.Status != PolicyDraft {
			return Policy{}, apperror.Conflicting("policy_state_invalid", "Only drafts can be approved")
		}
		if strings.TrimSpace(current.Purpose) == "" || strings.TrimSpace(current.LegalBasis) == "" || strings.TrimSpace(current.Reason) == "" {
			return Policy{}, apperror.Conflicting("policy_incomplete", "Purpose, legal basis and reason are required before approval")
		}
		row, err = q.ApprovePolicy(ctx, privacydb.ApprovePolicyParams{ApprovedByAccountID: &p.AccountID, ID: id})
		action = "privacy.policy_approved"
	case PolicyActive:
		if current.Status != PolicyApproved {
			return Policy{}, apperror.Conflicting("policy_state_invalid", "Only approved policies can be activated")
		}
		if current.ApprovedByAccountID != nil && *current.ApprovedByAccountID == p.AccountID && !p.Master {
			return Policy{}, apperror.Conflicting("policy_four_eyes", "The person who approved a policy cannot also activate it")
		}
		siblings, lockErr := q.LockCategoryPolicies(ctx, current.CategoryID)
		if lockErr != nil {
			return Policy{}, lockErr
		}
		for _, sibling := range siblings {
			if sibling.Status == PolicyActive {
				if _, err := q.RetirePolicy(ctx, sibling.ID); err != nil {
					return Policy{}, err
				}
			}
		}
		row, err = q.ActivatePolicy(ctx, privacydb.ActivatePolicyParams{ActivatedByAccountID: &p.AccountID, ID: id})
		action = "privacy.policy_activated"
	case PolicyRetired:
		if current.Status == PolicyRetired {
			return Policy{}, apperror.Conflicting("policy_state_invalid", "The policy is already retired")
		}
		row, err = q.RetirePolicy(ctx, id)
		action = "privacy.policy_retired"
	default:
		return Policy{}, apperror.InvalidField("unknown policy transition")
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return Policy{}, apperror.StaleWrite
	}
	if err != nil {
		return Policy{}, err
	}
	if err := s.auditPolicy(ctx, tx, p, action, row.ID, requestID, "status"); err != nil {
		return Policy{}, err
	}
	return policyFrom(row), tx.Commit(ctx)
}

func (s *Service) auditPolicy(
	ctx context.Context, tx pgx.Tx, p authorization.Principal, action string, id uuid.UUID, requestID *uuid.UUID, fields ...string,
) error {
	return audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &p.AccountID,
		Action:         action,
		ResourceType:   "privacy_policy",
		ResourceID:     &id,
		RequestID:      requestID,
		ChangedFields:  fields,
	})
}

// EnsurePolicyDrafts seeds one draft per category with a legacy default so the
// operator reviews what the installation did before, instead of starting from
// nothing. A legacy opt-out (a configured 0) becomes retain_with_review. It
// runs once per process.
func (s *Service) EnsurePolicyDrafts(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.drafts {
		return nil
	}
	q := privacydb.New(s.pool)
	for _, definition := range s.catalog.Definitions() {
		if definition.Legacy == nil {
			continue
		}
		count, err := q.CountPoliciesForCategory(ctx, string(definition.ID))
		if err != nil {
			return err
		}
		if count > 0 {
			continue
		}
		period, disabled, err := s.legacyPeriod(ctx, definition)
		if err != nil {
			return err
		}
		action := definition.Legacy.Action
		reason := "Seeded from the installation's previous behaviour (" + definition.Legacy.Source + "); review before approval."
		if disabled {
			action = ActionRetainWithReview
			reason = "The installation opted out of automatic deletion (" + definition.Legacy.Source + " = 0); confirm the justification."
			if !definition.Supports(definition.Legacy.Trigger, action) {
				continue
			}
		}
		source := "legacy:" + definition.Legacy.Source
		if _, err := q.InsertPolicy(ctx, privacydb.InsertPolicyParams{
			ID: ids.New(), CategoryID: string(definition.ID), Version: 1, Trigger: string(definition.Legacy.Trigger),
			PeriodDays: int32(period.Hours() / 24), //nolint:gosec // bounded periods
			Action:     string(action), Purpose: "", LegalBasis: "", Reason: reason, SourceTemplate: &source,
		}); err != nil {
			return err
		}
	}
	s.drafts = true
	return nil
}

// ListHolds returns every hold (privacy.read).
func (s *Service) ListHolds(ctx context.Context, p authorization.Principal) ([]Hold, error) {
	if !p.Has(authorization.PrivacyRead) {
		return nil, apperror.PermissionDenied
	}
	rows, err := privacydb.New(s.pool).ListHolds(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]Hold, 0, len(rows))
	for _, row := range rows {
		result = append(result, holdFrom(row))
	}
	return result, nil
}

// CreateHold places a hold (privacy.policies.manage).
func (s *Service) CreateHold(
	ctx context.Context, p authorization.Principal, category *CategoryID, personID *uuid.UUID, reason string, requestID *uuid.UUID,
) (Hold, error) {
	if !p.Has(authorization.PrivacyPoliciesManage) {
		return Hold{}, apperror.PermissionDenied
	}
	reason = strings.TrimSpace(reason)
	if reason == "" || len(reason) > 1000 {
		return Hold{}, apperror.InvalidField("reason is required (up to 1000 characters)")
	}
	if category == nil && personID == nil {
		return Hold{}, apperror.InvalidField("a hold names a category or a person")
	}
	var categoryID *string
	if category != nil {
		if _, known := s.catalog.Lookup(*category); !known {
			return Hold{}, apperror.InvalidField("unknown category")
		}
		value := string(*category)
		categoryID = &value
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Hold{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row, err := privacydb.New(tx).InsertHold(ctx, privacydb.InsertHoldParams{
		ID: ids.New(), CategoryID: categoryID, SubjectPersonID: personID, Reason: reason, CreatedByAccountID: &p.AccountID,
	})
	if err != nil {
		return Hold{}, err
	}
	metadata := map[string]any{}
	if personID != nil {
		metadata["personId"] = personID.String()
	}
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &p.AccountID, Action: "privacy.hold_created", ResourceType: "privacy_hold", ResourceID: &row.ID,
		RequestID: requestID, ChangedFields: []string{"reason"}, Metadata: metadata,
	}); err != nil {
		return Hold{}, err
	}
	return holdFrom(row), tx.Commit(ctx)
}

// ReleaseHold ends a hold (privacy.policies.manage).
func (s *Service) ReleaseHold(ctx context.Context, p authorization.Principal, id uuid.UUID, requestID *uuid.UUID) (Hold, error) {
	if !p.Has(authorization.PrivacyPoliciesManage) {
		return Hold{}, apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Hold{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row, err := privacydb.New(tx).ReleaseHold(ctx, privacydb.ReleaseHoldParams{ReleasedByAccountID: &p.AccountID, ID: id})
	if errors.Is(err, pgx.ErrNoRows) {
		return Hold{}, apperror.Conflicting("hold_not_open", "The hold does not exist or was already released")
	}
	if err != nil {
		return Hold{}, err
	}
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &p.AccountID, Action: "privacy.hold_released", ResourceType: "privacy_hold", ResourceID: &row.ID,
		RequestID: requestID, ChangedFields: []string{"releasedAt"},
	}); err != nil {
		return Hold{}, err
	}
	return holdFrom(row), tx.Commit(ctx)
}

// OpenHoldForPerson reports whether a person-level hold blocks changes to that person's data.
func (s *Service) OpenHoldForPerson(ctx context.Context, personID uuid.UUID) (bool, error) {
	rows, err := privacydb.New(s.pool).ListOpenHolds(ctx)
	if err != nil {
		return false, err
	}
	for _, row := range rows {
		if row.SubjectPersonID != nil && *row.SubjectPersonID == personID {
			return true, nil
		}
	}
	return false, nil
}
