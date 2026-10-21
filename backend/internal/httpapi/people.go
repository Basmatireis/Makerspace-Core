package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accounts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
)

func (s *Server) RemovePersonRole(
	ctx context.Context,
	request openapi.RemovePersonRoleRequestObject,
) (openapi.RemovePersonRoleResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	person, err := s.people.ChangeRole(
		ctx,
		principal,
		request.PersonId,
		request.RoleId,
		request.Body.ExpectedVersion,
		false,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	response, err := s.personDTO(ctx, principal, person, principal.CanReadPerson(person.ID), true)
	if err != nil {
		return nil, err
	}
	return openapi.RemovePersonRole200JSONResponse(response), nil
}

func (s *Server) AssignPersonRole(
	ctx context.Context,
	request openapi.AssignPersonRoleRequestObject,
) (openapi.AssignPersonRoleResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	person, err := s.people.ChangeRole(
		ctx,
		principal,
		request.PersonId,
		request.RoleId,
		request.Body.ExpectedVersion,
		true,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	response, err := s.personDTO(ctx, principal, person, principal.CanReadPerson(person.ID), true)
	if err != nil {
		return nil, err
	}
	return openapi.AssignPersonRole200JSONResponse(response), nil
}

func (s *Server) PromotePersonToSupervisor(
	ctx context.Context,
	request openapi.PromotePersonToSupervisorRequestObject,
) (openapi.PromotePersonToSupervisorResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	person, err := s.people.PromoteToSupervisor(
		ctx,
		principal,
		request.PersonId,
		request.Body.ExpectedVersion,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	response, err := s.personDTO(ctx, principal, person, principal.CanReadPerson(person.ID), true)
	if err != nil {
		return nil, err
	}
	return openapi.PromotePersonToSupervisor200JSONResponse(response), nil
}

func (s *Server) ListPeople(
	ctx context.Context,
	request openapi.ListPeopleRequestObject,
) (openapi.ListPeopleResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	pageNumber, pageSize, search := 1, 25, ""
	if request.Params.Page != nil {
		pageNumber = *request.Params.Page
	}
	if request.Params.PageSize != nil {
		pageSize = *request.Params.PageSize
	}
	if request.Params.Search != nil {
		search = *request.Params.Search
	}
	var roleIDs []uuid.UUID
	if request.Params.RoleIds != nil {
		roleIDs = *request.Params.RoleIds
	}
	var accountStatuses []string
	if request.Params.AccountStatuses != nil {
		for _, status := range *request.Params.AccountStatuses {
			accountStatuses = append(accountStatuses, string(status))
		}
	}
	var laborordnungStatuses []string
	if request.Params.LaborordnungStatuses != nil {
		for _, status := range *request.Params.LaborordnungStatuses {
			laborordnungStatuses = append(laborordnungStatuses, string(status))
		}
	}
	page, err := s.people.List(ctx, principal, pageNumber, pageSize, people.ListFilters{
		Search: search, RoleIDs: roleIDs, AccountStatuses: accountStatuses, LaborordnungStatuses: laborordnungStatuses,
	})
	if err != nil {
		return nil, err
	}
	personIDs := make([]uuid.UUID, 0, len(page.Items))
	for _, person := range page.Items {
		personIDs = append(personIDs, person.ID)
	}
	profileImageRequirements, err := s.people.ProfileImageRequirements(ctx, principal, personIDs)
	if err != nil {
		return nil, err
	}
	accountsByPerson := map[uuid.UUID]accounts.Account{}
	if principal.Has(authorization.AccountsRead) {
		accountsByPerson, err = s.accounts.ListForPeople(ctx, principal, personIDs)
		if err != nil {
			return nil, err
		}
	}
	items := make([]openapi.Person, 0, len(page.Items))
	for _, person := range page.Items {
		var account *accounts.Account
		if value, ok := accountsByPerson[person.ID]; ok {
			copy := value
			account = &copy
		}
		items = append(
			items,
			personDTOWithRelated(principal, person, true, true, profileImageRequirements[person.ID], account),
		)
	}
	return openapi.ListPeople200JSONResponse(
		openapi.PersonPage{Items: items, Page: page.Page, PageSize: page.PageSize, Total: page.Total},
	), nil
}

func (s *Server) GetPersonMakerspaceStatus(
	ctx context.Context,
	request openapi.GetPersonMakerspaceStatusRequestObject,
) (openapi.GetPersonMakerspaceStatusResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := s.people.Get(ctx, principal, request.PersonId); err != nil {
		return nil, err
	}
	response := openapi.PersonMakerspaceStatus{}
	if principal.Has(authorization.OpenDaysReadAssignments) {
		assignments, err := s.opendays.ListUpcomingAssignmentsForPerson(ctx, principal, request.PersonId)
		if err != nil {
			return nil, err
		}
		items := make([]openapi.PersonOpenDayAssignmentSummary, 0, len(assignments))
		for _, assignment := range assignments {
			items = append(items, openapi.PersonOpenDayAssignmentSummary{
				AssignmentId: assignment.AssignmentID, OpenDayId: assignment.OpenDayID,
				PeriodId: assignment.PeriodID, PeriodName: assignment.PeriodName,
				StartsAt: assignment.StartsAt, EndsAt: assignment.EndsAt,
				Role: openapi.OpenDayRequirementKind(assignment.Role),
			})
		}
		response.UpcomingOpenDayAssignments = &items
	}
	if principal.Has(authorization.LaborordnungRequestsRead) {
		status, err := s.laborordnung.EvaluateForPerson(ctx, principal, request.PersonId)
		if err != nil {
			return nil, err
		}
		value := laborordnungStatusDTO(status)
		response.LaborordnungStatus = &value
	}
	return openapi.GetPersonMakerspaceStatus200JSONResponse(response), nil
}

func (s *Server) CreatePerson(
	ctx context.Context,
	request openapi.CreatePersonRequestObject,
) (openapi.CreatePersonResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	person, err := s.people.Create(ctx, principal, people.CreateInput{
		FirstName: request.Body.FirstName, LastName: request.Body.LastName,
		Email: nullableStringPointer(request.Body.Email), Phone: nullableStringPointer(request.Body.Phone),
		MatriculationNumber: nullableStringPointer(request.Body.MatriculationNumber),
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	response, err := s.personDTO(ctx, principal, person, principal.CanReadPerson(person.ID), true)
	if err != nil {
		return nil, err
	}
	return openapi.CreatePerson201JSONResponse{
		Body:    response,
		Headers: openapi.CreatePerson201ResponseHeaders{Location: apiBasePath + "/people/" + person.ID.String()},
	}, nil
}

func (s *Server) DeletePerson(
	ctx context.Context,
	request openapi.DeletePersonRequestObject,
) (openapi.DeletePersonResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.people.Delete(
		ctx,
		principal,
		request.PersonId,
		request.Body.ExpectedVersion,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeletePerson204Response{}, nil
}

func (s *Server) GetPerson(
	ctx context.Context,
	request openapi.GetPersonRequestObject,
) (openapi.GetPersonResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	person, err := s.people.Get(ctx, principal, request.PersonId)
	if err != nil {
		return nil, err
	}
	response, err := s.personDTO(ctx, principal, person, true, true)
	if err != nil {
		return nil, err
	}
	return openapi.GetPerson200JSONResponse(response), nil
}

func (s *Server) UpdatePerson(
	ctx context.Context,
	request openapi.UpdatePersonRequestObject,
) (openapi.UpdatePersonResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	person, err := s.people.Update(ctx, principal, request.PersonId, people.UpdateInput{
		ExpectedVersion: request.Body.ExpectedVersion,
		FirstName:       request.Body.FirstName, LastName: request.Body.LastName,
		Email: optionalString(request.Body.Email), Phone: optionalString(request.Body.Phone),
		MatriculationNumber: optionalString(request.Body.MatriculationNumber),
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	response, err := s.personDTO(ctx, principal, person, principal.CanReadPerson(person.ID), true)
	if err != nil {
		return nil, err
	}
	return openapi.UpdatePerson200JSONResponse(response), nil
}

func (s *Server) PutPersonProfileImage(
	ctx context.Context,
	request openapi.PutPersonProfileImageRequestObject,
) (openapi.PutPersonProfileImageResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("profile image body is required")
	}
	var source people.ProfileImageSource
	if request.Params.XProfileImageSource != nil {
		source = people.ProfileImageSource(*request.Params.XProfileImageSource)
	}
	if source == people.ImageTerminalCapture {
		return nil, invalidRequest("terminal_capture is reserved for visitor enrollment")
	}
	person, err := s.people.PutProfileImage(
		ctx,
		principal,
		request.PersonId,
		request.Params.ExpectedVersion,
		request.Params.XFileName,
		source,
		request.Body,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.PutPersonProfileImage200JSONResponse(profileImageDTO(person)), nil
}

func (s *Server) GetPersonProfileImage(
	ctx context.Context,
	request openapi.GetPersonProfileImageRequestObject,
) (openapi.GetPersonProfileImageResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	file, reader, err := s.people.OpenProfileImage(ctx, principal, request.PersonId)
	if err != nil {
		return nil, err
	}
	return openapi.GetPersonProfileImage200ImagejpegResponse{
		Body: reader, ContentLength: file.Size,
		Headers: openapi.GetPersonProfileImage200ResponseHeaders{CacheControl: "private, no-store"},
	}, nil
}

func (s *Server) DeletePersonProfileImage(
	ctx context.Context,
	request openapi.DeletePersonProfileImageRequestObject,
) (openapi.DeletePersonProfileImageResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.people.DeleteProfileImage(
		ctx,
		principal,
		request.PersonId,
		request.Body.ExpectedVersion,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeletePersonProfileImage204Response{}, nil
}

func (s *Server) CreatePersonAccount(
	ctx context.Context,
	request openapi.CreatePersonAccountRequestObject,
) (openapi.CreatePersonAccountResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	var loginEmail *string
	if value, err := request.Body.LoginEmail.Get(); err == nil {
		converted := string(value)
		loginEmail = &converted
	}
	var account accounts.Account
	if loginEmail == nil {
		account, err = s.accounts.CreateWithoutIdentity(
			ctx,
			principal,
			request.PersonId,
			request.Body.ExpectedVersion,
			requestIDPointer(ctx),
		)
	} else {
		account, err = s.accounts.Create(
			ctx,
			principal,
			request.PersonId,
			*loginEmail,
			request.Body.ExpectedVersion,
			requestIDPointer(ctx),
		)
	}
	if err != nil {
		return nil, err
	}
	return openapi.CreatePersonAccount201JSONResponse{
		Body: accountDTO(
			account,
		), Headers: openapi.CreatePersonAccount201ResponseHeaders{Location: apiBasePath + "/accounts/" + account.ID.String()},
	}, nil
}

func (s *Server) personDTO(
	ctx context.Context,
	principal authorization.Principal,
	person people.Person,
	includeContact, includeAccount bool,
) (openapi.Person, error) {
	required, err := s.people.RequiresProfileImage(ctx, person.ID)
	if err != nil {
		return openapi.Person{}, err
	}
	var account *accounts.Account
	if includeAccount && principal.Has(authorization.AccountsRead) {
		account, err = s.accounts.GetForPerson(ctx, principal, person.ID)
		if err != nil {
			return openapi.Person{}, err
		}
	}
	return personDTOWithRelated(principal, person, includeContact, includeAccount, required, account), nil
}

func personDTOWithRelated(
	principal authorization.Principal,
	person people.Person,
	includeContact, includeAccount, profileImageRequired bool,
	account *accounts.Account,
) openapi.Person {
	roleSummaries := make([]openapi.RoleSummary, 0, len(person.Roles))
	for _, role := range person.Roles {
		roleSummaries = append(roleSummaries, roleSummaryDTO(role))
	}
	response := openapi.Person{
		Id: person.ID, FirstName: person.FirstName, LastName: person.LastName,
		Version: person.Version, CreatedAt: person.CreatedAt, UpdatedAt: person.UpdatedAt,
		ProfileImageRequired: &profileImageRequired, Roles: roleSummaries,
	}
	if includeContact {
		response.Email = nullablePointer[string, openapi.Email](
			person.Email,
			func(value string) openapi.Email { return openapi.Email(value) },
		)
		response.Phone = nullablePointer[string](person.Phone, func(value string) string { return value })
		response.PhotoReference = nullablePointer[string](
			person.PhotoReference,
			func(value string) string { return value },
		)
		if person.ProfileImageFileID == nil || person.ProfileImageSource == nil {
			response.ProfileImage = nullable.NewNullNullable[openapi.ProfileImage]()
		} else {
			response.ProfileImage = nullable.NewNullableWithValue(profileImageDTO(person))
		}
		if principal.Has(authorization.PeopleReadMatriculation) {
			response.MatriculationNumber = nullablePointer[string](
				person.MatriculationNumber,
				func(value string) string { return value },
			)
		}
	}
	if includeAccount && principal.Has(authorization.AccountsRead) {
		if account == nil {
			response.Account = nullable.NewNullNullable[openapi.AccountSummary]()
		} else {
			response.Account = nullable.NewNullableWithValue(accountSummaryDTO(*account))
		}
	}
	return response
}

func profileImageDTO(person people.Person) openapi.ProfileImage {
	return openapi.ProfileImage{
		FileId: *person.ProfileImageFileID, Source: openapi.ProfileImageSource(*person.ProfileImageSource),
		DownloadUrl: apiBasePath + "/people/" + person.ID.String() + "/profile-image",
	}
}
