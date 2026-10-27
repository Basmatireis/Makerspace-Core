package people

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	peopledb "github.com/Basmatireis/Makerspace-Core/backend/internal/people/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// MaxMergeSources bounds how many duplicates one merge folds into its target.
const MaxMergeSources = 9

// MergeField names a Person field whose surviving value the operator chooses.
type MergeField string

const (
	MergeFirstName           MergeField = "firstName"
	MergeLastName            MergeField = "lastName"
	MergeEmail               MergeField = "email"
	MergePhone               MergeField = "phone"
	MergeMatriculationNumber MergeField = "matriculationNumber"
	MergePhotoReference      MergeField = "photoReference"
	MergeProfileImage        MergeField = "profileImage"
	MergeMemberSince         MergeField = "memberSince"
)

// MergeCategory groups the records a merge moves from the source People to the target.
type MergeCategory string

const (
	MergedVisits                  MergeCategory = "visits"
	MergedAttendanceHolds         MergeCategory = "attendance_holds"
	MergedTrainingRecords         MergeCategory = "training_records"
	MergedLabRulesRequests        MergeCategory = "lab_rules_requests"
	MergedOpenDayAssignments      MergeCategory = "open_day_assignments"
	MergedEventShiftAssignments   MergeCategory = "event_shift_assignments"
	MergedEventPlanning           MergeCategory = "event_planning"
	MergedOrders                  MergeCategory = "orders"
	MergedMachineJobs             MergeCategory = "machine_jobs"
	MergedInvoiceRequests         MergeCategory = "invoice_requests"
	MergedCashMovements           MergeCategory = "cash_movements"
	MergedSurveyInvitations       MergeCategory = "survey_invitations"
	MergedSurveyResponses         MergeCategory = "survey_responses"
	MergedOrganizationMemberships MergeCategory = "organization_memberships"
	MergedNotifications           MergeCategory = "notifications"
	MergedActorReferences         MergeCategory = "actor_references"
	MergedAuthenticationMethods   MergeCategory = "authentication_methods"
	MergedAuditEvents             MergeCategory = "audit_events"
)

// mergeCategoryOrder is the stable order of categories in previews, results and audit metadata.
var mergeCategoryOrder = []MergeCategory{
	MergedVisits, MergedAttendanceHolds, MergedTrainingRecords, MergedLabRulesRequests, MergedOpenDayAssignments,
	MergedEventShiftAssignments, MergedEventPlanning, MergedOrders, MergedMachineJobs, MergedInvoiceRequests,
	MergedCashMovements, MergedSurveyInvitations, MergedSurveyResponses, MergedOrganizationMemberships,
	MergedNotifications, MergedActorReferences, MergedAuthenticationMethods, MergedAuditEvents,
}

// MergeConflictCode identifies a reason People cannot be merged as requested.
type MergeConflictCode string

const (
	ConflictSourceSCIMManaged     MergeConflictCode = "source_scim_managed"
	ConflictActorIsSource         MergeConflictCode = "actor_is_source"
	ConflictOpenVisits            MergeConflictCode = "open_visit_conflict"
	ConflictAttendanceHolds       MergeConflictCode = "attendance_hold_conflict"
	ConflictLabRulesRequests      MergeConflictCode = "lab_rules_request_conflict"
	ConflictOpenDayAssignments    MergeConflictCode = "open_day_assignment_conflict"
	ConflictPINs                  MergeConflictCode = "pin_conflict"
	ConflictTOTP                  MergeConflictCode = "totp_conflict"
	ConflictMasterMergeForbidden  MergeConflictCode = "master_merge_forbidden"
	ConflictRoleAssignmentDenied  MergeConflictCode = "role_assignment_forbidden"
	ConflictLastMasterRequired    MergeConflictCode = "last_master_required"
	mergeBlockedCode                                = "people_merge_blocked"
	mergeEmailRequiresAccountCode                   = "merge_email_requires_account"
)

// authorizationConflict reports conflicts that are missing authority rather than data problems; Merge answers them
// with 403 instead of 409.
func (code MergeConflictCode) authorizationConflict() bool {
	return code == ConflictMasterMergeForbidden || code == ConflictRoleAssignmentDenied
}

type MergeConflict struct {
	Code      MergeConflictCode
	Message   string
	PersonIDs []uuid.UUID
}

// MergeCandidateAccount summarizes an Account's state and authentication methods without secrets.
type MergeCandidateAccount struct {
	ID                 uuid.UUID
	Version            int64
	Status             authorization.AccountStatus
	ProvisioningSource string
	LoginEmail         *string
	PasswordSet        bool
	PINEnrolled        bool
	OIDCIdentities     int64
	TOTPEnrolled       bool
	Passkeys           int64
}

type MergeCandidate struct {
	// Person carries the mergeable values; MatriculationNumber is nil without people.read.matriculation.
	Person      Person
	Account     *MergeCandidateAccount
	SCIMManaged bool
}

type MergeCount struct {
	Category MergeCategory
	Count    int64
}

type MergeSelection struct {
	TargetPersonID  uuid.UUID
	SourcePersonIDs []uuid.UUID
}

type MergePreview struct {
	TargetPersonID     uuid.UUID
	People             []MergeCandidate
	ResultingRoles     []RoleSummary
	SurvivingAccountID *uuid.UUID
	History            []MergeCount
	Conflicts          []MergeConflict
}

func (p MergePreview) CanMerge() bool { return len(p.Conflicts) == 0 }

// mergeState is everything a merge decides on, read in one transaction.
type mergeState struct {
	target   uuid.UUID
	sources  []uuid.UUID
	people   map[uuid.UUID]peopledb.Person
	accounts map[uuid.UUID]peopledb.Account // by person ID
	methods  map[uuid.UUID]peopledb.ListMergeAccountMethodsRow
	facts    map[uuid.UUID]peopledb.ListMergePersonFactsRow
	roles    map[uuid.UUID][]RoleSummary
	// survivor is the Account the merged Person keeps: the target's, otherwise the first source Account.
	survivor *peopledb.Account
}

func (m mergeState) ordered() []uuid.UUID { return append([]uuid.UUID{m.target}, m.sources...) }

func (m mergeState) accountIDs() []uuid.UUID {
	ids := make([]uuid.UUID, 0, len(m.accounts))
	for _, id := range m.ordered() {
		if account, ok := m.accounts[id]; ok {
			ids = append(ids, account.ID)
		}
	}
	return ids
}

func validateMergeSelection(selection MergeSelection) error {
	if len(selection.SourcePersonIDs) == 0 || len(selection.SourcePersonIDs) > MaxMergeSources {
		return apperror.InvalidField(fmt.Sprintf("sourcePersonIds needs 1 to %d people", MaxMergeSources))
	}
	seen := map[uuid.UUID]struct{}{selection.TargetPersonID: {}}
	for _, id := range selection.SourcePersonIDs {
		if _, duplicate := seen[id]; duplicate {
			return apperror.InvalidField("sourcePersonIds must be distinct and must not contain the target")
		}
		seen[id] = struct{}{}
	}
	return nil
}

func authorizeMerge(principal authorization.Principal) error {
	// people.merge first, so a grant that only lacks a fresh sign-in is reported as reauthentication_required.
	if !principal.Has(authorization.PeopleMerge) || !principal.Has(authorization.PeopleReadAll) {
		return apperror.PermissionDenied
	}
	return nil
}

// loadMergeState reads every merged Person, Account and the facts the conflict rules need. With lock it takes the
// documented order: people in id order, the master invariant lock, then Accounts in id order.
func loadMergeState(
	ctx context.Context,
	queries *peopledb.Queries,
	selection MergeSelection,
	lock bool,
) (mergeState, error) {
	state := mergeState{
		target:   selection.TargetPersonID,
		sources:  selection.SourcePersonIDs,
		people:   map[uuid.UUID]peopledb.Person{},
		accounts: map[uuid.UUID]peopledb.Account{},
		methods:  map[uuid.UUID]peopledb.ListMergeAccountMethodsRow{},
		facts:    map[uuid.UUID]peopledb.ListMergePersonFactsRow{},
		roles:    map[uuid.UUID][]RoleSummary{},
	}
	ids := uuidStrings(state.ordered())
	var rows []peopledb.Person
	var accounts []peopledb.Account
	var err error
	if lock {
		rows, err = queries.LockPeopleForMerge(ctx, ids)
		if err == nil {
			err = queries.AcquireMasterInvariantLock(ctx)
		}
		if err == nil {
			accounts, err = queries.LockAccountsForMerge(ctx, ids)
		}
	} else {
		rows, err = queries.ListPeopleForMerge(ctx, ids)
		if err == nil {
			accounts, err = queries.ListAccountsForMerge(ctx, ids)
		}
	}
	if err != nil {
		return mergeState{}, err
	}
	if len(rows) != len(ids) {
		return mergeState{}, apperror.NotFound
	}
	for _, row := range rows {
		state.people[row.ID] = row
	}
	accountIDs := make([]uuid.UUID, 0, len(accounts))
	for _, account := range accounts {
		state.accounts[account.PersonID] = account
		accountIDs = append(accountIDs, account.ID)
	}
	for _, id := range state.ordered() {
		if account, ok := state.accounts[id]; ok {
			state.survivor = &account
			break
		}
	}
	methods, err := queries.ListMergeAccountMethods(ctx, uuidStrings(accountIDs))
	if err != nil {
		return mergeState{}, err
	}
	for _, method := range methods {
		state.methods[method.AccountID] = method
	}
	facts, err := queries.ListMergePersonFacts(ctx, ids)
	if err != nil {
		return mergeState{}, err
	}
	for _, fact := range facts {
		state.facts[fact.PersonID] = fact
	}
	roleRows, err := queries.ListPersonRolesByPeople(ctx, ids)
	if err != nil {
		return mergeState{}, err
	}
	for _, row := range roleRows {
		state.roles[row.PersonID] = append(
			state.roles[row.PersonID],
			RoleSummary{ID: row.ID, Name: row.Name, SystemKey: optional.Convert[authorization.SystemKey](row.SystemKey)},
		)
	}
	return state, nil
}

// resultingRoles is the union of every merged Person's roles, the target's first.
func (m mergeState) resultingRoles() []RoleSummary {
	result := []RoleSummary{}
	seen := map[uuid.UUID]struct{}{}
	for _, id := range m.ordered() {
		for _, role := range m.roles[id] {
			if _, ok := seen[role.ID]; !ok {
				seen[role.ID] = struct{}{}
				result = append(result, role)
			}
		}
	}
	return result
}

func isMasterRole(role RoleSummary) bool {
	return role.SystemKey != nil && *role.SystemKey == authorization.SystemKeyMaster
}

// analyzeMerge lists every reason the merge cannot run. It never writes; role checks take share locks only.
func analyzeMerge(
	ctx context.Context,
	queries *peopledb.Queries,
	principal authorization.Principal,
	state mergeState,
) ([]MergeConflict, error) {
	conflicts := []MergeConflict{}
	add := func(code MergeConflictCode, message string, people []uuid.UUID) {
		if people == nil {
			people = []uuid.UUID{}
		}
		conflicts = append(conflicts, MergeConflict{Code: code, Message: message, PersonIDs: people})
	}
	for _, id := range state.sources {
		if state.facts[id].ScimManaged {
			add(ConflictSourceSCIMManaged,
				"This person is provisioned through SCIM; merge others into them or reconcile in the identity provider.",
				[]uuid.UUID{id})
		}
		if id == principal.PersonID {
			add(ConflictActorIsSource, "You cannot merge your own person away; choose yourself as the target.",
				[]uuid.UUID{id})
		}
	}
	var openVisits, holds, pins, totps []uuid.UUID
	for _, id := range state.ordered() {
		if state.facts[id].OpenVisit {
			openVisits = append(openVisits, id)
		}
		if state.facts[id].AttendanceHold {
			holds = append(holds, id)
		}
		if account, ok := state.accounts[id]; ok {
			if state.methods[account.ID].HasPin {
				pins = append(pins, id)
			}
			if state.methods[account.ID].TotpEnrolled {
				totps = append(totps, id)
			}
		}
	}
	if len(openVisits) > 1 {
		add(ConflictOpenVisits, "Several of these people are checked in; check them out first.", openVisits)
	}
	if len(holds) > 1 {
		add(ConflictAttendanceHolds,
			"Several of these people await a Lab Rules sign-off at check-in; resolve the holds first.", holds)
	}
	if len(pins) > 1 {
		add(ConflictPINs, "Several of these accounts have a PIN; remove all but one first.", pins)
	}
	if len(totps) > 1 {
		add(ConflictTOTP, "Several of these accounts have an authenticator app; remove all but one first.", totps)
	}
	ids := uuidStrings(state.ordered())
	versions, err := queries.CountMergePendingLabRulesVersions(ctx, ids)
	if err != nil {
		return nil, err
	}
	if versions > 1 {
		add(ConflictLabRulesRequests,
			"These people have pending Lab Rules requests for different versions; settle them first.", nil)
	}
	openDays, err := queries.ListMergeOpenDayConflicts(ctx, ids)
	if err != nil {
		return nil, err
	}
	if len(openDays) > 0 {
		add(ConflictOpenDayAssignments,
			fmt.Sprintf("These people hold different positions on %d Open Day(s); remove all but one first.", len(openDays)),
			nil)
	}
	roleConflicts, err := analyzeMergeRoles(ctx, queries, principal, state)
	if err != nil {
		return nil, err
	}
	return append(conflicts, roleConflicts...), nil
}

// analyzeMergeRoles applies the role-assignment rules to every role the target ends up with: the merged Person
// receives the sources' authentication methods, so the actor must already be allowed to hand out all of them.
func analyzeMergeRoles(
	ctx context.Context,
	queries *peopledb.Queries,
	principal authorization.Principal,
	state mergeState,
) ([]MergeConflict, error) {
	conflicts := []MergeConflict{}
	roles := state.resultingRoles()
	holdsMaster := false
	for _, role := range roles {
		if isMasterRole(role) {
			holdsMaster = true
		}
	}
	if holdsMaster && !principal.Master {
		conflicts = append(conflicts, MergeConflict{
			Code:      ConflictMasterMergeForbidden,
			Message:   "Only a master can merge a person who holds the master role.",
			PersonIDs: []uuid.UUID{},
		})
	} else {
		for _, role := range roles {
			if _, err := authorizeRoleAssignment(ctx, queries, principal, role.ID); err != nil {
				if !errors.Is(err, apperror.PermissionDenied) && !errors.Is(err, apperror.NotFound) {
					return nil, err
				}
				conflicts = append(conflicts, MergeConflict{
					Code:      ConflictRoleAssignmentDenied,
					Message:   "You may not assign every role the merged person would hold (people.roles.assign).",
					PersonIDs: []uuid.UUID{},
				})
				break
			}
		}
	}
	if !holdsMaster {
		return conflicts, nil
	}
	// Deleting the merged Accounts must leave an enabled master: either one outside the merge or the surviving
	// Account, which receives the master role through the union.
	outside, err := queries.CountEnabledMastersOutsideMerge(ctx, uuidStrings(state.ordered()))
	if err != nil {
		return nil, err
	}
	survivorEnabled := state.survivor != nil &&
		authorization.AccountStatus(state.survivor.Status) == authorization.AccountEnabled
	if outside == 0 && !survivorEnabled {
		conflicts = append(conflicts, MergeConflict{
			Code:      ConflictLastMasterRequired,
			Message:   "At least one enabled master account must remain.",
			PersonIDs: []uuid.UUID{},
		})
	}
	return conflicts, nil
}

// PreviewMerge reports candidate values, history that would move and every blocking conflict without changing
// anything.
func (s *Service) PreviewMerge(
	ctx context.Context,
	principal authorization.Principal,
	selection MergeSelection,
) (MergePreview, error) {
	if err := authorizeMerge(principal); err != nil {
		return MergePreview{}, err
	}
	if err := validateMergeSelection(selection); err != nil {
		return MergePreview{}, err
	}
	// Read-write only because the role checks take share locks; the transaction is always rolled back.
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return MergePreview{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := peopledb.New(tx)
	state, err := loadMergeState(ctx, queries, selection, false)
	if err != nil {
		return MergePreview{}, err
	}
	conflicts, err := analyzeMerge(ctx, queries, principal, state)
	if err != nil {
		return MergePreview{}, err
	}
	history, err := mergeHistory(ctx, queries, state)
	if err != nil {
		return MergePreview{}, err
	}
	preview := MergePreview{
		TargetPersonID: state.target,
		People:         make([]MergeCandidate, 0, len(state.people)),
		ResultingRoles: state.resultingRoles(),
		History:        history,
		Conflicts:      conflicts,
	}
	if state.survivor != nil {
		id := state.survivor.ID
		preview.SurvivingAccountID = &id
	}
	includeMatriculation := principal.Has(authorization.PeopleReadMatriculation)
	for _, id := range state.ordered() {
		candidate := MergeCandidate{
			Person:      fromRow(state.people[id], true, includeMatriculation),
			SCIMManaged: state.facts[id].ScimManaged,
		}
		candidate.Person.Roles = append(candidate.Person.Roles, state.roles[id]...)
		if account, ok := state.accounts[id]; ok {
			methods := state.methods[account.ID]
			candidate.Account = &MergeCandidateAccount{
				ID: account.ID, Version: account.Version, Status: authorization.AccountStatus(account.Status),
				ProvisioningSource: account.ProvisioningSource, LoginEmail: methods.LoginEmail,
				PasswordSet: methods.PasswordSet, PINEnrolled: methods.HasPin, OIDCIdentities: methods.OidcIdentities,
				TOTPEnrolled: methods.TotpEnrolled, Passkeys: methods.Passkeys,
			}
		}
		preview.People = append(preview.People, candidate)
	}
	return preview, nil
}

// mergeHistory counts the source People's records that would move to the target.
func mergeHistory(ctx context.Context, queries *peopledb.Queries, state mergeState) ([]MergeCount, error) {
	var accountIDs []uuid.UUID
	for _, id := range state.sources {
		if account, ok := state.accounts[id]; ok && (state.survivor == nil || account.ID != state.survivor.ID) {
			accountIDs = append(accountIDs, account.ID)
		}
	}
	row, err := queries.CountMergeHistory(
		ctx,
		peopledb.CountMergeHistoryParams{Ids: uuidStrings(state.sources), AccountIds: uuidStrings(accountIDs)},
	)
	if err != nil {
		return nil, err
	}
	return mergeCounts(map[MergeCategory]int64{
		MergedVisits:                  row.Visits,
		MergedAttendanceHolds:         row.AttendanceHolds,
		MergedTrainingRecords:         row.TrainingRecords,
		MergedLabRulesRequests:        row.LabRulesRequests,
		MergedOpenDayAssignments:      row.OpenDayAssignments,
		MergedEventShiftAssignments:   row.EventShiftAssignments,
		MergedEventPlanning:           row.EventPlanning,
		MergedOrders:                  row.Orders,
		MergedMachineJobs:             row.MachineJobs,
		MergedInvoiceRequests:         row.InvoiceRequests,
		MergedCashMovements:           row.CashMovements,
		MergedSurveyInvitations:       row.SurveyInvitations,
		MergedSurveyResponses:         row.SurveyResponses,
		MergedOrganizationMemberships: row.OrganizationMemberships,
		MergedNotifications:           row.Notifications,
	}), nil
}

func mergeCounts(values map[MergeCategory]int64) []MergeCount {
	result := []MergeCount{}
	for _, category := range mergeCategoryOrder {
		if values[category] > 0 {
			result = append(result, MergeCount{Category: category, Count: values[category]})
		}
	}
	return result
}

func mergeBlocked(conflicts []MergeConflict) error {
	reasons := make([]*apperror.Error, 0, len(conflicts))
	for _, conflict := range conflicts {
		if conflict.Code.authorizationConflict() {
			return apperror.PermissionDenied
		}
		reasons = append(reasons, apperror.New(http.StatusConflict, string(conflict.Code), conflict.Message))
	}
	return apperror.Blocked(mergeBlockedCode, "These people cannot be merged for several reasons", reasons...)
}
