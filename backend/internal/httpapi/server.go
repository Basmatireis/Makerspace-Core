package httpapi

import (
	"context"
	"fmt"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accounts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/opendays"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/oapi-codegen/nullable"
)

const apiBasePath = "/api/v1"

// Server translates the generated OpenAPI transport contract into feature
// service calls. Business validation, authorization, transactions, and audit
// writes deliberately remain in those services.
type Server struct {
	pool        *pgxpool.Pool
	config      config.Config
	auth        *auth.Service
	people      *people.Service
	accounts    *accounts.Service
	permissions *authorization.Service
	roles       *roles.Service
	audit       *audit.Service
	opendays    *opendays.Service
}

func NewServer(pool *pgxpool.Pool, cfg config.Config) (*Server, error) {
	authService, err := auth.NewService(pool, cfg)
	if err != nil {
		return nil, fmt.Errorf("initialize authentication: %w", err)
	}
	openDaysService, err := opendays.NewService(pool, cfg)
	if err != nil {
		return nil, fmt.Errorf("initialize Open Days: %w", err)
	}
	return &Server{
		pool:        pool,
		config:      cfg,
		auth:        authService,
		people:      people.NewService(pool),
		accounts:    accounts.NewService(pool, cfg),
		permissions: authorization.NewService(),
		roles:       roles.NewService(pool),
		audit:       audit.NewService(pool),
		opendays:    openDaysService,
	}, nil
}

func (s *Server) DeleteAccount(ctx context.Context, request openapi.DeleteAccountRequestObject) (openapi.DeleteAccountResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.accounts.Delete(ctx, principal, request.AccountId, request.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteAccount204Response{}, nil
}

func (s *Server) GetAccount(ctx context.Context, request openapi.GetAccountRequestObject) (openapi.GetAccountResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	account, err := s.accounts.Get(ctx, principal, request.AccountId)
	if err != nil {
		return nil, err
	}
	return openapi.GetAccount200JSONResponse(accountDTO(account)), nil
}

func (s *Server) DisableAccount(ctx context.Context, request openapi.DisableAccountRequestObject) (openapi.DisableAccountResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	account, err := s.accounts.SetStatus(ctx, principal, request.AccountId, "disabled", request.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.DisableAccount200JSONResponse(accountDTO(account)), nil
}

func (s *Server) EnableAccount(ctx context.Context, request openapi.EnableAccountRequestObject) (openapi.EnableAccountResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	account, err := s.accounts.SetStatus(ctx, principal, request.AccountId, "enabled", request.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.EnableAccount200JSONResponse(accountDTO(account)), nil
}

func (s *Server) UpdateAccountLoginEmail(ctx context.Context, request openapi.UpdateAccountLoginEmailRequestObject) (openapi.UpdateAccountLoginEmailResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	account, err := s.accounts.UpdateLoginEmail(ctx, principal, request.AccountId, string(request.Body.LoginEmail), request.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateAccountLoginEmail200JSONResponse(accountDTO(account)), nil
}

func (s *Server) SetAccountPassword(ctx context.Context, request openapi.SetAccountPasswordRequestObject) (openapi.SetAccountPasswordResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil || request.Body.NewPassword == nil {
		return nil, invalidRequest("newPassword is required")
	}
	account, err := s.accounts.SetPassword(ctx, principal, request.AccountId, *request.Body.NewPassword, request.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SetAccountPassword200JSONResponse(accountDTO(account)), nil
}

func (s *Server) IssueAccountPasswordReset(ctx context.Context, request openapi.IssueAccountPasswordResetRequestObject) (openapi.IssueAccountPasswordResetResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	issue, err := s.accounts.IssuePasswordReset(ctx, principal, request.AccountId, request.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	resetURL := issue.URL
	return openapi.IssueAccountPasswordReset201JSONResponse{
		Body: openapi.PasswordResetIssue{
			Account: accountDTO(issue.Account), ExpiresAt: issue.ExpiresAt, ResetUrl: &resetURL,
		},
		Headers: openapi.IssueAccountPasswordReset201ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) RemoveAccountRole(ctx context.Context, request openapi.RemoveAccountRoleRequestObject) (openapi.RemoveAccountRoleResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	account, err := s.accounts.ChangeRole(ctx, principal, request.AccountId, request.RoleId, request.Body.ExpectedVersion, false, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.RemoveAccountRole200JSONResponse(accountDTO(account)), nil
}

func (s *Server) AssignAccountRole(ctx context.Context, request openapi.AssignAccountRoleRequestObject) (openapi.AssignAccountRoleResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	account, err := s.accounts.ChangeRole(ctx, principal, request.AccountId, request.RoleId, request.Body.ExpectedVersion, true, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.AssignAccountRole200JSONResponse(accountDTO(account)), nil
}

func (s *Server) ListAuditEvents(ctx context.Context, request openapi.ListAuditEventsRequestObject) (openapi.ListAuditEventsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	limit := 50
	if request.Params.Limit != nil {
		limit = *request.Params.Limit
	}
	filter := audit.Filter{
		Limit: limit, Action: request.Params.Action, ResourceType: request.Params.ResourceType,
		ResourceID: request.Params.ResourceId, ActorAccountID: request.Params.ActorAccountId,
		OccurredFrom: request.Params.OccurredFrom, OccurredTo: request.Params.OccurredTo,
	}
	if request.Params.Cursor != nil {
		filter.Cursor = *request.Params.Cursor
	}
	page, err := s.audit.List(ctx, principal, filter)
	if err != nil {
		return nil, err
	}
	return openapi.ListAuditEvents200JSONResponse(auditPageDTO(page)), nil
}

func (s *Server) Login(ctx context.Context, request openapi.LoginRequestObject) (openapi.LoginResponseObject, error) {
	if request.Body == nil || request.Body.Password == nil {
		return nil, invalidRequest("email and password are required")
	}
	session, err := s.auth.Login(ctx, string(request.Body.Email), *request.Body.Password, sourceAddress(ctx), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return cookieNoContentResponse{config: s.config, session: &session}, nil
}

func (s *Server) Logout(ctx context.Context, _ openapi.LogoutRequestObject) (openapi.LogoutResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.auth.Logout(ctx, principal, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return cookieNoContentResponse{config: s.config, clear: true}, nil
}

func (s *Server) GetCurrentUser(ctx context.Context, _ openapi.GetCurrentUserRequestObject) (openapi.GetCurrentUserResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	account, err := s.accounts.GetCurrent(ctx, principal)
	if err != nil {
		return nil, err
	}
	person, err := s.people.GetCurrent(ctx, principal)
	if err != nil {
		return nil, err
	}
	personResponse, err := s.personDTO(ctx, principal, person, principal.CanReadPerson(person.ID), false)
	if err != nil {
		return nil, err
	}
	permissions := principal.PermissionIDs()
	permissionIDs := make([]openapi.PermissionId, 0, len(permissions))
	for _, permission := range permissions {
		permissionIDs = append(permissionIDs, openapi.PermissionId(permission))
	}
	return openapi.GetCurrentUser200JSONResponse{
		Body:    openapi.CurrentUser{Account: accountDTO(account), Person: personResponse, Permissions: permissionIDs},
		Headers: openapi.GetCurrentUser200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) ChangeOwnPassword(ctx context.Context, request openapi.ChangeOwnPasswordRequestObject) (openapi.ChangeOwnPasswordResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil || request.Body.CurrentPassword == nil || request.Body.NewPassword == nil {
		return nil, invalidRequest("currentPassword and newPassword are required")
	}
	session, err := s.auth.ChangePassword(ctx, principal, *request.Body.CurrentPassword, *request.Body.NewPassword, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return cookieNoContentResponse{config: s.config, session: &session}, nil
}

func (s *Server) CompletePasswordReset(ctx context.Context, request openapi.CompletePasswordResetRequestObject) (openapi.CompletePasswordResetResponseObject, error) {
	if request.Body == nil || request.Body.Token == nil || request.Body.NewPassword == nil {
		return nil, invalidRequest("token and newPassword are required")
	}
	if err := s.auth.RedeemPasswordReset(ctx, *request.Body.Token, *request.Body.NewPassword, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return cookieNoContentResponse{config: s.config, clear: true}, nil
}

func (s *Server) GetLiveness(context.Context, openapi.GetLivenessRequestObject) (openapi.GetLivenessResponseObject, error) {
	return openapi.GetLiveness200JSONResponse(openapi.HealthStatus{Status: openapi.Ok}), nil
}

func (s *Server) GetReadiness(ctx context.Context, _ openapi.GetReadinessRequestObject) (openapi.GetReadinessResponseObject, error) {
	if err := s.pool.Ping(ctx); err != nil {
		return openapi.GetReadiness503JSONResponse(openapi.HealthStatus{Status: openapi.Unavailable}), nil
	}
	return openapi.GetReadiness200JSONResponse(openapi.HealthStatus{Status: openapi.Ok}), nil
}

func (s *Server) ListPeople(ctx context.Context, request openapi.ListPeopleRequestObject) (openapi.ListPeopleResponseObject, error) {
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
	page, err := s.people.List(ctx, principal, pageNumber, pageSize, search)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.Person, 0, len(page.Items))
	for _, person := range page.Items {
		item, err := s.personDTO(ctx, principal, person, true, true)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return openapi.ListPeople200JSONResponse(openapi.PersonPage{Items: items, Page: page.Page, PageSize: page.PageSize, Total: page.Total}), nil
}

func (s *Server) CreatePerson(ctx context.Context, request openapi.CreatePersonRequestObject) (openapi.CreatePersonResponseObject, error) {
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
		Body: response, Headers: openapi.CreatePerson201ResponseHeaders{Location: apiBasePath + "/people/" + person.ID.String()},
	}, nil
}

func (s *Server) DeletePerson(ctx context.Context, request openapi.DeletePersonRequestObject) (openapi.DeletePersonResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.people.Delete(ctx, principal, request.PersonId, request.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeletePerson204Response{}, nil
}

func (s *Server) GetPerson(ctx context.Context, request openapi.GetPersonRequestObject) (openapi.GetPersonResponseObject, error) {
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

func (s *Server) UpdatePerson(ctx context.Context, request openapi.UpdatePersonRequestObject) (openapi.UpdatePersonResponseObject, error) {
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

func (s *Server) CreatePersonAccount(ctx context.Context, request openapi.CreatePersonAccountRequestObject) (openapi.CreatePersonAccountResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	account, err := s.accounts.Create(ctx, principal, request.PersonId, string(request.Body.LoginEmail), request.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreatePersonAccount201JSONResponse{
		Body: accountDTO(account), Headers: openapi.CreatePersonAccount201ResponseHeaders{Location: apiBasePath + "/accounts/" + account.ID.String()},
	}, nil
}

func (s *Server) ListPermissions(ctx context.Context, _ openapi.ListPermissionsRequestObject) (openapi.ListPermissionsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	definitions, err := s.permissions.ListPermissions(principal)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.Permission, 0, len(definitions))
	for _, definition := range definitions {
		items = append(items, openapi.Permission{Id: openapi.PermissionId(definition.ID), Description: definition.Description})
	}
	return openapi.ListPermissions200JSONResponse{Items: items}, nil
}

func (s *Server) ListRoles(ctx context.Context, request openapi.ListRolesRequestObject) (openapi.ListRolesResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	limit, cursor := 50, ""
	if request.Params.Limit != nil {
		limit = *request.Params.Limit
	}
	if request.Params.Cursor != nil {
		cursor = *request.Params.Cursor
	}
	page, err := s.roles.List(ctx, principal, limit, cursor)
	if err != nil {
		return nil, err
	}
	return openapi.ListRoles200JSONResponse(rolePageDTO(page)), nil
}

func (s *Server) CreateRole(ctx context.Context, request openapi.CreateRoleRequestObject) (openapi.CreateRoleResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	role, err := s.roles.Create(ctx, principal, request.Body.Name, nullableStringPointer(request.Body.Description), permissionStrings(request.Body.PermissionIds), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateRole201JSONResponse{
		Body: roleDTO(role), Headers: openapi.CreateRole201ResponseHeaders{Location: apiBasePath + "/roles/" + role.ID.String()},
	}, nil
}

func (s *Server) DeleteRole(ctx context.Context, request openapi.DeleteRoleRequestObject) (openapi.DeleteRoleResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.roles.Delete(ctx, principal, request.RoleId, request.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteRole204Response{}, nil
}

func (s *Server) GetRole(ctx context.Context, request openapi.GetRoleRequestObject) (openapi.GetRoleResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	role, err := s.roles.Get(ctx, principal, request.RoleId)
	if err != nil {
		return nil, err
	}
	return openapi.GetRole200JSONResponse(roleDTO(role)), nil
}

func (s *Server) UpdateRole(ctx context.Context, request openapi.UpdateRoleRequestObject) (openapi.UpdateRoleResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	role, err := s.roles.Update(ctx, principal, request.RoleId, request.Body.ExpectedVersion, request.Body.Name,
		request.Body.Description.IsSpecified(), nullableStringPointer(request.Body.Description), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateRole200JSONResponse(roleDTO(role)), nil
}

func (s *Server) ReplaceRolePermissions(ctx context.Context, request openapi.ReplaceRolePermissionsRequestObject) (openapi.ReplaceRolePermissionsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	role, err := s.roles.ReplacePermissions(ctx, principal, request.RoleId, request.Body.ExpectedVersion, permissionStrings(request.Body.PermissionIds), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ReplaceRolePermissions200JSONResponse(roleDTO(role)), nil
}

func (s *Server) personDTO(ctx context.Context, principal authorization.Principal, person people.Person, includeContact, includeAccount bool) (openapi.Person, error) {
	response := openapi.Person{
		Id: person.ID, FirstName: person.FirstName, LastName: person.LastName,
		Version: person.Version, CreatedAt: person.CreatedAt, UpdatedAt: person.UpdatedAt,
	}
	if includeContact {
		response.Email = nullablePointer[string, openapi.Email](person.Email, func(value string) openapi.Email { return openapi.Email(value) })
		response.Phone = nullablePointer[string](person.Phone, func(value string) string { return value })
		response.PhotoReference = nullablePointer[string](person.PhotoReference, func(value string) string { return value })
	}
	if includeContact && principal.Has(authorization.PeopleReadMatriculation) {
		response.MatriculationNumber = nullablePointer[string](person.MatriculationNumber, func(value string) string { return value })
	}
	if includeAccount && principal.Has(authorization.AccountsRead) {
		account, err := s.accounts.GetForPerson(ctx, principal, person.ID)
		if err != nil {
			return openapi.Person{}, err
		}
		if account == nil {
			response.Account = nullable.NewNullNullable[openapi.AccountSummary]()
		} else {
			response.Account = nullable.NewNullableWithValue(accountSummaryDTO(*account))
		}
	}
	return response, nil
}

func accountDTO(account accounts.Account) openapi.Account {
	roles := make([]openapi.RoleSummary, 0, len(account.Roles))
	for _, role := range account.Roles {
		roles = append(roles, roleSummaryDTO(role))
	}
	return openapi.Account{
		Id: account.ID, PersonId: account.PersonID, Status: openapi.AccountStatus(account.Status),
		PasswordStatus: openapi.PasswordStatus(account.PasswordStatus), LoginEmail: openapi.Email(account.LoginEmail),
		Roles: roles, Version: account.Version, CreatedAt: account.CreatedAt, UpdatedAt: account.UpdatedAt,
	}
}

func accountSummaryDTO(account accounts.Account) openapi.AccountSummary {
	full := accountDTO(account)
	return openapi.AccountSummary{
		Id: full.Id, PersonId: full.PersonId, Status: full.Status, PasswordStatus: full.PasswordStatus,
		LoginEmail: full.LoginEmail, Roles: full.Roles, Version: full.Version,
	}
}

func roleSummaryDTO(role accounts.RoleSummary) openapi.RoleSummary {
	response := openapi.RoleSummary{Id: role.ID, Name: role.Name}
	if role.SystemKey != nil {
		response.SystemKey = nullable.NewNullableWithValue(openapi.RoleSummarySystemKey(*role.SystemKey))
	}
	return response
}

func roleDTO(role roles.Role) openapi.Role {
	permissionIDs := make([]openapi.PermissionId, 0, len(role.PermissionIDs))
	for _, permission := range role.PermissionIDs {
		permissionIDs = append(permissionIDs, openapi.PermissionId(permission))
	}
	response := openapi.Role{
		Id: role.ID, Name: role.Name, PermissionIds: permissionIDs, Version: role.Version,
		CreatedAt: role.CreatedAt, UpdatedAt: role.UpdatedAt,
		Description: nullablePointer[string](role.Description, func(value string) string { return value }),
	}
	if role.SystemKey == nil {
		response.SystemKey = nullable.NewNullNullable[openapi.RoleSystemKey]()
	} else {
		response.SystemKey = nullable.NewNullableWithValue(openapi.RoleSystemKey(*role.SystemKey))
	}
	return response
}

func rolePageDTO(page roles.Page) openapi.RolePage {
	items := make([]openapi.Role, 0, len(page.Items))
	for _, role := range page.Items {
		items = append(items, roleDTO(role))
	}
	return openapi.RolePage{Items: items, NextCursor: nullablePointer[string](page.NextCursor, func(value string) string { return value })}
}

func auditPageDTO(page audit.Page) openapi.AuditEventPage {
	items := make([]openapi.AuditEvent, 0, len(page.Items))
	for _, event := range page.Items {
		response := openapi.AuditEvent{
			Id: event.ID, Action: event.Action, ResourceType: event.ResourceType,
			OccurredAt: event.OccurredAt, ChangedFields: event.ChangedFields,
			Metadata: event.Metadata, Source: openapi.AuditEventSource(event.Source),
			ActorAccountId: nullablePointer[openapi.UUIDv7](event.ActorAccountID, func(value uuid.UUID) openapi.UUIDv7 { return value }),
			ResourceId:     nullablePointer[openapi.UUIDv7](event.ResourceID, func(value uuid.UUID) openapi.UUIDv7 { return value }),
			RequestId:      nullablePointer[string](event.RequestID, func(value string) string { return value }),
		}
		items = append(items, response)
	}
	return openapi.AuditEventPage{Items: items, NextCursor: nullablePointer[string](page.NextCursor, func(value string) string { return value })}
}

func permissionStrings(values []openapi.PermissionId) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		result = append(result, string(value))
	}
	return result
}

func nullableStringPointer[T ~string](value nullable.Nullable[T]) *string {
	if !value.IsSpecified() || value.IsNull() {
		return nil
	}
	result := string(value.GetOrEmpty())
	return &result
}

func optionalString[T ~string](value nullable.Nullable[T]) people.OptionalString {
	return people.OptionalString{Set: value.IsSpecified(), Value: nullableStringPointer(value)}
}

func nullablePointer[T any, S any](value *T, convert func(T) S) nullable.Nullable[S] {
	if value == nil {
		return nullable.NewNullNullable[S]()
	}
	return nullable.NewNullableWithValue(convert(*value))
}

func invalidRequest(reason string) *apperror.Error {
	err := apperror.New(400, "invalid_request", "Request is invalid")
	err.Details["reason"] = reason
	return err
}
