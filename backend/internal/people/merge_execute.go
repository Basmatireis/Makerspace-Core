package people

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	peopledb "github.com/Basmatireis/Makerspace-Core/backend/internal/people/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/dates"
	"github.com/google/uuid"
)

type MergeExpectedVersion struct {
	PersonID uuid.UUID
	Version  int64
	// AccountVersion is nil when the Person had no Account in the preview.
	AccountVersion *int64
}

type MergeInput struct {
	MergeSelection
	ExpectedVersions []MergeExpectedVersion
	// FieldSources names the Person whose value each field keeps; see resolveMergedFields for the defaults.
	FieldSources map[MergeField]uuid.UUID
}

type MergeResult struct {
	Person          Person
	MergedPersonIDs []uuid.UUID
	Moved           []MergeCount
}

// mergedFields are the values the merged Person ends up with.
type mergedFields struct {
	firstName, lastName       string
	email, phone              *string
	matriculation, photo      *string
	imageFileID               *uuid.UUID
	imageSource               *string
	memberSince               time.Time
	keepPasswordIdentityID    *uuid.UUID
	changed                   []string
	discardedProfileImageFile []uuid.UUID
}

// Merge folds the source People into the target in one transaction. See docs/people-merge.md for every rule.
func (s *Service) Merge(
	ctx context.Context,
	principal authorization.Principal,
	input MergeInput,
	requestID *uuid.UUID,
) (MergeResult, error) {
	if err := authorizeMerge(principal); err != nil {
		return MergeResult{}, err
	}
	if err := validateMergeInput(principal, input); err != nil {
		return MergeResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MergeResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := peopledb.New(tx)
	state, err := loadMergeState(ctx, queries, input.MergeSelection, true)
	if err != nil {
		return MergeResult{}, err
	}
	if err := checkMergeVersions(state, input.ExpectedVersions); err != nil {
		return MergeResult{}, err
	}
	conflicts, err := analyzeMerge(ctx, queries, principal, state)
	if err != nil {
		return MergeResult{}, err
	}
	if len(conflicts) > 0 {
		return MergeResult{}, mergeBlocked(conflicts)
	}
	fields, err := resolveMergedFields(state, input.FieldSources)
	if err != nil {
		return MergeResult{}, err
	}
	if len(fields.discardedProfileImageFile) > 0 && s.files == nil {
		return MergeResult{}, errStorageUnavailable
	}
	moved, err := applyMerge(ctx, queries, principal, state, fields)
	if err != nil {
		return MergeResult{}, databaseError(err)
	}
	row, err := queries.ApplyMergedPerson(ctx, peopledb.ApplyMergedPersonParams{
		ID:                  state.target,
		FirstName:           fields.firstName,
		LastName:            fields.lastName,
		Email:               fields.email,
		Phone:               fields.phone,
		MatriculationNumber: fields.matriculation,
		PhotoReference:      fields.photo,
		ProfileImageFileID:  fields.imageFileID,
		ProfileImageSource:  fields.imageSource,
		MemberSince:         dates.FromTime(fields.memberSince),
	})
	if err != nil {
		return MergeResult{}, databaseError(err)
	}
	metadata := map[string]any{"countMergedPeople": strconv.Itoa(len(state.sources))}
	for _, count := range moved {
		metadata["count"+camelCategory(count.Category)] = strconv.FormatInt(count.Count, 10)
	}
	actor := principal.AccountID
	target := state.target
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor,
		Action:         "person.merged",
		ResourceType:   "person",
		ResourceID:     &target,
		RequestID:      requestID,
		ChangedFields:  fields.changed,
		Metadata:       metadata,
	}); err != nil {
		return MergeResult{}, err
	}
	result, err := loadPerson(ctx, queries, row, true, principal.Has(authorization.PeopleReadMatriculation))
	if err != nil {
		return MergeResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return MergeResult{}, err
	}
	for _, fileID := range fields.discardedProfileImageFile {
		// The merge is committed; a file that cannot be removed now is only orphaned storage, never personal data
		// reachable through a Person.
		if err := s.files.DeleteSystem(ctx, fileID, requestID); err != nil {
			slog.WarnContext(ctx, "discarded profile image of a merged person was not deleted", "file_id", fileID)
		}
	}
	return MergeResult{Person: result, MergedPersonIDs: input.SourcePersonIDs, Moved: moved}, nil
}

var errStorageUnavailable = apperror.New(
	http.StatusServiceUnavailable,
	"file_storage_unavailable",
	"File storage is unavailable",
)

func validateMergeInput(principal authorization.Principal, input MergeInput) error {
	if err := validateMergeSelection(input.MergeSelection); err != nil {
		return err
	}
	involved := map[uuid.UUID]struct{}{input.TargetPersonID: {}}
	for _, id := range input.SourcePersonIDs {
		involved[id] = struct{}{}
	}
	expected := map[uuid.UUID]struct{}{}
	for _, version := range input.ExpectedVersions {
		if _, ok := involved[version.PersonID]; !ok || version.Version < 1 {
			return apperror.InvalidField("expectedVersions must list each merged person once with a positive version")
		}
		if _, duplicate := expected[version.PersonID]; duplicate {
			return apperror.InvalidField("expectedVersions must list each merged person once with a positive version")
		}
		expected[version.PersonID] = struct{}{}
	}
	if len(expected) != len(involved) {
		return apperror.InvalidField("expectedVersions must list each merged person once with a positive version")
	}
	for field, personID := range input.FieldSources {
		if _, ok := involved[personID]; !ok {
			return apperror.InvalidField("fieldSources must name one of the merged people")
		}
		if field == MergeMatriculationNumber && (!principal.Has(authorization.PeopleReadMatriculation) ||
			!principal.Has(authorization.PeopleUpdateMatriculation)) {
			return apperror.PermissionDenied
		}
	}
	return nil
}

// checkMergeVersions rejects the merge when any Person or Account changed, appeared or vanished since the preview.
func checkMergeVersions(state mergeState, expected []MergeExpectedVersion) error {
	for _, version := range expected {
		if state.people[version.PersonID].Version != version.Version {
			return apperror.StaleWrite
		}
		account, hasAccount := state.accounts[version.PersonID]
		if hasAccount != (version.AccountVersion != nil) {
			return apperror.StaleWrite
		}
		if hasAccount && account.Version != *version.AccountVersion {
			return apperror.StaleWrite
		}
	}
	return nil
}

var errMergeEmailRequiresAccount = apperror.New(
	http.StatusUnprocessableEntity,
	mergeEmailRequiresAccountCode,
	"The merged person keeps an account, so the email must come from a person with an account.",
)

// resolveMergedFields applies the chosen sources. Unchosen required fields keep the target's value; unchosen optional
// fields keep the first value set in the order target, sources; an unchosen email follows the surviving Account.
func resolveMergedFields(state mergeState, sources map[MergeField]uuid.UUID) (mergedFields, error) {
	target := state.people[state.target]
	chosen := func(field MergeField, fallback uuid.UUID) peopledb.Person {
		if id, ok := sources[field]; ok {
			return state.people[id]
		}
		return state.people[fallback]
	}
	firstSet := func(field MergeField, value func(peopledb.Person) bool) peopledb.Person {
		if id, ok := sources[field]; ok {
			return state.people[id]
		}
		for _, id := range state.ordered() {
			if value(state.people[id]) {
				return state.people[id]
			}
		}
		return target
	}
	fields := mergedFields{
		firstName:   chosen(MergeFirstName, state.target).FirstName,
		lastName:    chosen(MergeLastName, state.target).LastName,
		phone:       firstSet(MergePhone, func(p peopledb.Person) bool { return p.Phone != nil }).Phone,
		memberSince: chosen(MergeMemberSince, state.target).MemberSince.Time,
		matriculation: firstSet(MergeMatriculationNumber, func(p peopledb.Person) bool {
			return p.MatriculationNumber != nil
		}).MatriculationNumber,
		photo: firstSet(MergePhotoReference, func(p peopledb.Person) bool { return p.PhotoReference != nil }).PhotoReference,
	}
	image := firstSet(MergeProfileImage, func(p peopledb.Person) bool { return p.ProfileImageFileID != nil })
	fields.imageFileID, fields.imageSource = image.ProfileImageFileID, image.ProfileImageSource
	for _, id := range state.ordered() {
		file := state.people[id].ProfileImageFileID
		if file != nil && (fields.imageFileID == nil || *file != *fields.imageFileID) {
			fields.discardedProfileImageFile = append(fields.discardedProfileImageFile, *file)
		}
	}
	// The person's email mirrors the login email of the surviving Account, so it travels with the password
	// identity (login email and password) of the chosen Person's Account.
	var emailPerson peopledb.Person
	if state.survivor != nil {
		emailPerson = chosen(MergeEmail, state.survivor.PersonID)
		account, ok := state.accounts[emailPerson.ID]
		if !ok {
			return mergedFields{}, errMergeEmailRequiresAccount
		}
		methods := state.methods[account.ID]
		fields.keepPasswordIdentityID = methods.PasswordIdentityID
		fields.email = emailPerson.Email
		if methods.LoginEmail != nil {
			fields.email = methods.LoginEmail
		}
	} else {
		emailPerson = firstSet(MergeEmail, func(p peopledb.Person) bool { return p.Email != nil })
		fields.email = emailPerson.Email
	}
	if err := validate(fields.firstName, fields.lastName, fields.email, fields.phone, fields.matriculation); err != nil {
		return mergedFields{}, err
	}
	fields.changed = changedFields(target, fields.firstName, fields.lastName, fields.email, fields.phone, fields.matriculation)
	if !sameString(target.PhotoReference, fields.photo) {
		fields.changed = append(fields.changed, "photoReference")
	}
	if fields.imageFileID != target.ProfileImageFileID &&
		(fields.imageFileID == nil || target.ProfileImageFileID == nil || *fields.imageFileID != *target.ProfileImageFileID) {
		fields.changed = append(fields.changed, "profileImage")
	}
	if !fields.memberSince.Equal(target.MemberSince.Time) {
		fields.changed = append(fields.changed, "memberSince")
	}
	if len(state.resultingRoles()) != len(state.roles[state.target]) {
		fields.changed = append(fields.changed, "roles")
	}
	if state.survivor != nil {
		fields.changed = append(fields.changed, "account")
	}
	return fields, nil
}

// applyMerge moves authentication methods and every reference of the source People and Accounts to the target and
// the surviving Account, then deletes the sources. The caller holds every lock and has checked all conflicts.
func applyMerge(
	ctx context.Context,
	queries *peopledb.Queries,
	principal authorization.Principal,
	state mergeState,
	fields mergedFields,
) ([]MergeCount, error) {
	counts := map[MergeCategory]int64{}
	if err := queries.EnablePeopleMergeMode(ctx); err != nil {
		return nil, err
	}
	allAccounts := uuidStrings(state.accountIDs())
	if err := queries.DeleteMergeTransientAccountState(ctx, allAccounts); err != nil {
		return nil, err
	}
	if _, err := queries.RevokeMergeSessions(ctx, allAccounts); err != nil {
		return nil, err
	}
	if _, err := queries.DeleteMergePasswordIdentities(ctx, peopledb.DeleteMergePasswordIdentitiesParams{
		AccountIds: allAccounts, KeepIdentityID: fields.keepPasswordIdentityID,
	}); err != nil {
		return nil, err
	}
	if state.survivor != nil {
		if state.survivor.PersonID != state.target {
			// Before the source Person is deleted, which would cascade to its Account.
			if err := queries.AttachMergeAccount(ctx, peopledb.AttachMergeAccountParams{
				ID: state.survivor.ID, TargetPersonID: state.target,
			}); err != nil {
				return nil, err
			}
		} else if err := queries.BumpMergeAccountVersion(ctx, state.survivor.ID); err != nil {
			return nil, err
		}
	}
	for _, source := range state.sources {
		var sourceAccount *uuid.UUID
		if account, ok := state.accounts[source]; ok && account.ID != state.survivor.ID {
			id := account.ID
			sourceAccount = &id
			if err := moveMergeAccount(ctx, queries, id, state.survivor.ID, counts); err != nil {
				return nil, err
			}
		}
		if err := moveMergePerson(ctx, queries, principal, source, state.target, counts); err != nil {
			return nil, err
		}
		params := peopledb.RepointMergeAuditEventsParams{SourcePersonID: &source, TargetPersonID: state.target}
		if sourceAccount != nil {
			params.SourceAccountID, params.TargetAccountID = sourceAccount, &state.survivor.ID
		}
		audited, err := queries.RepointMergeAuditEvents(ctx, params)
		if err != nil {
			return nil, err
		}
		counts[MergedAuditEvents] += audited
		if sourceAccount != nil {
			if _, err := queries.DeleteMergedAccount(ctx, *sourceAccount); err != nil {
				return nil, err
			}
		}
		if _, err := queries.DeleteMergedPerson(ctx, source); err != nil {
			return nil, err
		}
	}
	return mergeCounts(counts), nil
}

func moveMergeAccount(
	ctx context.Context,
	queries *peopledb.Queries,
	source, target uuid.UUID,
	counts map[MergeCategory]int64,
) error {
	identities, err := queries.MoveMergeAuthIdentities(ctx, peopledb.MoveMergeAuthIdentitiesParams{
		SourceAccountID: source, TargetAccountID: target,
	})
	if err != nil {
		return err
	}
	if _, err := queries.DeleteDuplicateMergeRecoveryCodes(ctx, peopledb.DeleteDuplicateMergeRecoveryCodesParams{
		SourceAccountID: source, TargetAccountID: target,
	}); err != nil {
		return err
	}
	factors, err := queries.MoveMergeSecondFactors(ctx, peopledb.MoveMergeSecondFactorsParams{
		SourceAccountID: source, TargetAccountID: target,
	})
	if err != nil {
		return err
	}
	if _, err := queries.DeleteDuplicateMergeInboxRecipients(ctx, peopledb.DeleteDuplicateMergeInboxRecipientsParams{
		SourceAccountID: source, TargetAccountID: target,
	}); err != nil {
		return err
	}
	notifications, err := queries.MoveMergeInboxRecipients(ctx, peopledb.MoveMergeInboxRecipientsParams{
		SourceAccountID: source, TargetAccountID: target,
	})
	if err != nil {
		return err
	}
	actors, err := queries.RepointMergeAccountReferences(ctx, peopledb.RepointMergeAccountReferencesParams{
		SourceAccountID: source, TargetAccountID: target,
	})
	if err != nil {
		return err
	}
	counts[MergedAuthenticationMethods] += identities + factors
	counts[MergedNotifications] += notifications
	counts[MergedActorReferences] += actors
	return nil
}

func moveMergePerson(
	ctx context.Context,
	queries *peopledb.Queries,
	principal authorization.Principal,
	source, target uuid.UUID,
	counts map[MergeCategory]int64,
) error {
	actor := principal.AccountID
	if _, err := queries.AddMergedPersonRoles(ctx, peopledb.AddMergedPersonRolesParams{
		TargetPersonID: target, SourcePersonID: source, AssignedByAccountID: &actor,
	}); err != nil {
		return err
	}
	type dedupeMove struct {
		category MergeCategory
		dedupe   func() (int64, error)
		move     func() (int64, error)
	}
	steps := []dedupeMove{
		{MergedTrainingRecords, func() (int64, error) {
			return queries.DeleteSupersededMergeTrainingRecords(ctx, peopledb.DeleteSupersededMergeTrainingRecordsParams{
				SourcePersonID: source, TargetPersonID: target,
			})
		}, func() (int64, error) {
			return queries.MoveMergeTrainingRecords(ctx, peopledb.MoveMergeTrainingRecordsParams{
				SourcePersonID: source, TargetPersonID: target,
			})
		}},
		{MergedLabRulesRequests, func() (int64, error) {
			return queries.DeleteDuplicateMergeLabRulesRequests(ctx, peopledb.DeleteDuplicateMergeLabRulesRequestsParams{
				SourcePersonID: source, TargetPersonID: target,
			})
		}, func() (int64, error) {
			return queries.MoveMergeLabRulesRequests(ctx, peopledb.MoveMergeLabRulesRequestsParams{
				SourcePersonID: source, TargetPersonID: target,
			})
		}},
		{MergedOpenDayAssignments, func() (int64, error) {
			return queries.DeleteDuplicateMergeOpenDayAssignments(ctx, peopledb.DeleteDuplicateMergeOpenDayAssignmentsParams{
				SourcePersonID: source, TargetPersonID: target,
			})
		}, func() (int64, error) {
			return queries.MoveMergeOpenDayAssignments(ctx, peopledb.MoveMergeOpenDayAssignmentsParams{
				SourcePersonID: source, TargetPersonID: target,
			})
		}},
		{MergedEventShiftAssignments, func() (int64, error) {
			return queries.DeleteDuplicateMergeShiftAssignments(ctx, peopledb.DeleteDuplicateMergeShiftAssignmentsParams{
				SourcePersonID: &source, TargetPersonID: &target,
			})
		}, func() (int64, error) {
			return queries.MoveMergeShiftAssignments(ctx, peopledb.MoveMergeShiftAssignmentsParams{
				SourcePersonID: &source, TargetPersonID: &target,
			})
		}},
		{MergedOrganizationMemberships, func() (int64, error) {
			return queries.DeleteDuplicateMergeOrganizationMembers(
				ctx,
				peopledb.DeleteDuplicateMergeOrganizationMembersParams{SourcePersonID: source, TargetPersonID: target},
			)
		}, func() (int64, error) {
			return queries.MoveMergeOrganizationMembers(ctx, peopledb.MoveMergeOrganizationMembersParams{
				SourcePersonID: source, TargetPersonID: target,
			})
		}},
	}
	for _, step := range steps {
		if _, err := step.dedupe(); err != nil {
			return err
		}
		moved, err := step.move()
		if err != nil {
			return err
		}
		counts[step.category] += moved
	}
	row, err := queries.RepointMergePersonReferences(ctx, peopledb.RepointMergePersonReferencesParams{
		SourcePersonID: source, TargetPersonID: target,
	})
	if err != nil {
		return err
	}
	counts[MergedVisits] += row.Visits
	counts[MergedAttendanceHolds] += row.AttendanceHolds
	counts[MergedSurveyInvitations] += row.SurveyInvitations
	counts[MergedSurveyResponses] += row.SurveyResponses
	counts[MergedEventPlanning] += row.EventPlanning
	counts[MergedOrders] += row.Orders
	counts[MergedMachineJobs] += row.MachineJobs
	counts[MergedInvoiceRequests] += row.InvoiceRequests
	counts[MergedCashMovements] += row.CashMovements
	counts[MergedPrivacyHolds] += row.PrivacyHolds
	return nil
}

// camelCategory turns "open_day_assignments" into "OpenDayAssignments" for audit count keys.
func camelCategory(category MergeCategory) string {
	result := make([]byte, 0, len(category))
	upper := true
	for index := 0; index < len(category); index++ {
		character := category[index]
		if character == '_' {
			upper = true
			continue
		}
		if upper && character >= 'a' && character <= 'z' {
			character -= 'a' - 'A'
		}
		upper = false
		result = append(result, character)
	}
	return string(result)
}
