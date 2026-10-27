package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

func (s *Server) PreviewPeopleMerge(
	ctx context.Context,
	request openapi.PreviewPeopleMergeRequestObject,
) (openapi.PreviewPeopleMergeResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	preview, err := s.people.PreviewMerge(ctx, principal, people.MergeSelection{
		TargetPersonID:  request.Body.TargetPersonId,
		SourcePersonIDs: request.Body.SourcePersonIds,
	})
	if err != nil {
		return nil, err
	}
	return openapi.PreviewPeopleMerge200JSONResponse(peopleMergePreviewDTO(principal, preview)), nil
}

func (s *Server) MergePeople(
	ctx context.Context,
	request openapi.MergePeopleRequestObject,
) (openapi.MergePeopleResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	body := request.Body
	input := people.MergeInput{
		MergeSelection: people.MergeSelection{
			TargetPersonID:  body.TargetPersonId,
			SourcePersonIDs: body.SourcePersonIds,
		},
		ExpectedVersions: make([]people.MergeExpectedVersion, 0, len(body.ExpectedVersions)),
		FieldSources:     map[people.MergeField]uuid.UUID{},
	}
	for _, expected := range body.ExpectedVersions {
		version := people.MergeExpectedVersion{PersonID: expected.PersonId, Version: expected.Version}
		if accountVersion, err := expected.AccountVersion.Get(); err == nil {
			version.AccountVersion = &accountVersion
		}
		input.ExpectedVersions = append(input.ExpectedVersions, version)
	}
	sources := body.FieldSources
	for field, personID := range map[people.MergeField]*uuid.UUID{
		people.MergeFirstName:           sources.FirstName,
		people.MergeLastName:            sources.LastName,
		people.MergeEmail:               sources.Email,
		people.MergePhone:               sources.Phone,
		people.MergeMatriculationNumber: sources.MatriculationNumber,
		people.MergePhotoReference:      sources.PhotoReference,
		people.MergeProfileImage:        sources.ProfileImage,
		people.MergeMemberSince:         sources.MemberSince,
	} {
		if personID != nil {
			input.FieldSources[field] = *personID
		}
	}
	result, err := s.people.Merge(ctx, principal, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	person, err := s.personDTO(ctx, principal, result.Person, true, true)
	if err != nil {
		return nil, err
	}
	return openapi.MergePeople200JSONResponse(openapi.PeopleMergeResult{
		Person:          person,
		MergedPersonIds: result.MergedPersonIDs,
		Moved:           peopleMergeCountsDTO(result.Moved),
	}), nil
}

func peopleMergePreviewDTO(principal authorization.Principal, preview people.MergePreview) openapi.PeopleMergePreview {
	response := openapi.PeopleMergePreview{
		TargetPersonId:     preview.TargetPersonID,
		People:             make([]openapi.PeopleMergeCandidate, 0, len(preview.People)),
		ResultingRoles:     make([]openapi.RoleSummary, 0, len(preview.ResultingRoles)),
		SurvivingAccountId: nullablePointer(preview.SurvivingAccountID, func(id uuid.UUID) uuid.UUID { return id }),
		History:            peopleMergeCountsDTO(preview.History),
		Conflicts:          make([]openapi.PeopleMergeConflict, 0, len(preview.Conflicts)),
		CanMerge:           preview.CanMerge(),
	}
	for _, role := range preview.ResultingRoles {
		response.ResultingRoles = append(response.ResultingRoles, roleSummaryDTO(role))
	}
	for _, conflict := range preview.Conflicts {
		response.Conflicts = append(response.Conflicts, openapi.PeopleMergeConflict{
			Code:      openapi.PeopleMergeConflictCode(conflict.Code),
			Message:   conflict.Message,
			PersonIds: conflict.PersonIDs,
		})
	}
	readMatriculation := principal.Has(authorization.PeopleReadMatriculation)
	for _, candidate := range preview.People {
		person := candidate.Person
		roles := make([]openapi.RoleSummary, 0, len(person.Roles))
		for _, role := range person.Roles {
			roles = append(roles, roleSummaryDTO(role))
		}
		item := openapi.PeopleMergeCandidate{
			Id:        person.ID,
			Version:   person.Version,
			FirstName: person.FirstName,
			LastName:  person.LastName,
			Email: nullablePointer(
				person.Email,
				func(value string) openapi.Email { return openapi.Email(value) },
			),
			Phone:          nullablePointer(person.Phone, func(value string) string { return value }),
			PhotoReference: nullablePointer(person.PhotoReference, func(value string) string { return value }),
			ProfileImage:   nullable.NewNullNullable[openapi.ProfileImage](),
			MemberSince:    openapi_types.Date{Time: person.MemberSince},
			CreatedAt:      person.CreatedAt,
			Roles:          roles,
			Account:        nullable.NewNullNullable[openapi.PeopleMergeCandidateAccount](),
			ScimManaged:    candidate.SCIMManaged,
		}
		if readMatriculation {
			item.MatriculationNumber = nullablePointer(person.MatriculationNumber, func(value string) string { return value })
		}
		if person.ProfileImageFileID != nil && person.ProfileImageSource != nil {
			item.ProfileImage = nullable.NewNullableWithValue(profileImageDTO(person))
		}
		if account := candidate.Account; account != nil {
			item.Account = nullable.NewNullableWithValue(openapi.PeopleMergeCandidateAccount{
				Id:                 account.ID,
				Version:            account.Version,
				Status:             openapi.AccountStatus(account.Status),
				ProvisioningSource: openapi.PeopleMergeCandidateAccountProvisioningSource(account.ProvisioningSource),
				LoginEmail: nullablePointer(
					account.LoginEmail,
					func(value string) openapi.Email { return openapi.Email(value) },
				),
				PasswordSet:       account.PasswordSet,
				PinEnrolled:       account.PINEnrolled,
				OidcIdentityCount: account.OIDCIdentities,
				TotpEnrolled:      account.TOTPEnrolled,
				PasskeyCount:      account.Passkeys,
			})
		}
		response.People = append(response.People, item)
	}
	return response
}

func peopleMergeCountsDTO(counts []people.MergeCount) []openapi.PeopleMergeCount {
	result := make([]openapi.PeopleMergeCount, 0, len(counts))
	for _, count := range counts {
		result = append(result, openapi.PeopleMergeCount{
			Category: openapi.PeopleMergeCategory(count.Category),
			Count:    count.Count,
		})
	}
	return result
}
