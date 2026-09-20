package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	scimservice "github.com/Basmatireis/Makerspace-Core/backend/internal/scim"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
)

const (
	scimErrorSchema = "urn:ietf:params:scim:api:messages:2.0:Error"
	scimListSchema  = "urn:ietf:params:scim:api:messages:2.0:ListResponse"
)

func (s *Server) ListSCIMConnectors(ctx context.Context, _ openapi.ListSCIMConnectorsRequestObject) (openapi.ListSCIMConnectorsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	connectors, err := s.scim.ListConnectors(ctx, principal)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.SCIMConnector, 0, len(connectors))
	for _, connector := range connectors {
		items = append(items, scimConnectorDTO(connector))
	}
	return openapi.ListSCIMConnectors200JSONResponse{Items: items}, nil
}

func (s *Server) CreateSCIMConnector(ctx context.Context, request openapi.CreateSCIMConnectorRequestObject) (openapi.CreateSCIMConnectorResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	issue, err := s.scim.CreateConnector(ctx, principal, request.Body.Name, nullableUUID(request.Body.OidcProviderId), request.Body.Enabled, request.Body.TokenExpiresAt, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	token := issue.BearerToken
	return openapi.CreateSCIMConnector201JSONResponse{Body: openapi.SCIMConnectorTokenIssue{Connector: scimConnectorDTO(issue.Connector), BearerToken: &token}, Headers: openapi.CreateSCIMConnector201ResponseHeaders{CacheControl: "no-store"}}, nil
}

func (s *Server) UpdateSCIMConnector(ctx context.Context, request openapi.UpdateSCIMConnectorRequestObject) (openapi.UpdateSCIMConnectorResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	connector, err := s.scim.UpdateConnector(ctx, principal, request.ScimConnectorId, request.Body.Name, nullableUUID(request.Body.OidcProviderId), request.Body.Enabled, request.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateSCIMConnector200JSONResponse(scimConnectorDTO(connector)), nil
}

func (s *Server) RotateSCIMConnectorToken(ctx context.Context, request openapi.RotateSCIMConnectorTokenRequestObject) (openapi.RotateSCIMConnectorTokenResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	issue, err := s.scim.RotateToken(ctx, principal, request.ScimConnectorId, request.Body.ExpiresAt, request.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	token := issue.BearerToken
	return openapi.RotateSCIMConnectorToken201JSONResponse{Body: openapi.SCIMConnectorTokenIssue{Connector: scimConnectorDTO(issue.Connector), BearerToken: &token}, Headers: openapi.RotateSCIMConnectorToken201ResponseHeaders{CacheControl: "no-store"}}, nil
}

func (s *Server) RevokeSCIMConnectorToken(ctx context.Context, request openapi.RevokeSCIMConnectorTokenRequestObject) (openapi.RevokeSCIMConnectorTokenResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	connector, err := s.scim.RevokeToken(ctx, principal, request.ScimConnectorId, request.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.RevokeSCIMConnectorToken200JSONResponse(scimConnectorDTO(connector)), nil
}

func (s *Server) PreflightSCIMReconciliation(ctx context.Context, request openapi.PreflightSCIMReconciliationRequestObject) (openapi.PreflightSCIMReconciliationResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	report, err := s.scim.PreflightReconciliation(ctx, principal, request.Body.ProvisionalAccountId, request.Body.TargetAccountId)
	if err != nil {
		return nil, err
	}
	return openapi.PreflightSCIMReconciliation200JSONResponse(scimReconciliationDTO(report)), nil
}

func (s *Server) ReconcileSCIMAccount(ctx context.Context, request openapi.ReconcileSCIMAccountRequestObject) (openapi.ReconcileSCIMAccountResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	report, err := s.scim.Reconcile(ctx, principal, request.Body.ProvisionalAccountId, request.Body.TargetAccountId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto := scimReconciliationDTO(report)
	if !report.CanReconcile {
		return openapi.ReconcileSCIMAccount409JSONResponse(dto), nil
	}
	return openapi.ReconcileSCIMAccount200JSONResponse(dto), nil
}

func (s *Server) GetSCIMServiceProviderConfig(ctx context.Context, _ openapi.GetSCIMServiceProviderConfigRequestObject) (openapi.GetSCIMServiceProviderConfigResponseObject, error) {
	if _, err := requireSCIMConnector(ctx); err != nil {
		return nil, err
	}
	result := openapi.SCIMServiceProviderConfig{Schemas: []string{"urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"}}
	result.Patch.Supported = true
	result.Bulk.Supported = false
	result.Filter.Supported, result.Filter.MaxResults = true, 100
	result.ChangePassword.Supported = false
	result.Sort.Supported = false
	result.Etag.Supported = false
	return openapi.GetSCIMServiceProviderConfig200ApplicationScimPlusJSONResponse(result), nil
}

func (s *Server) ListSCIMResourceTypes(ctx context.Context, _ openapi.ListSCIMResourceTypesRequestObject) (openapi.ListSCIMResourceTypesResponseObject, error) {
	if _, err := requireSCIMConnector(ctx); err != nil {
		return nil, err
	}
	resource := map[string]any{"id": "User", "name": "User", "endpoint": "/Users", "schema": scimservice.UserSchema(), "schemas": []string{"urn:ietf:params:scim:schemas:core:2.0:ResourceType"}}
	return openapi.ListSCIMResourceTypes200ApplicationScimPlusJSONResponse{Schemas: []string{scimListSchema}, TotalResults: 1, StartIndex: 1, ItemsPerPage: 1, Resources: []map[string]any{resource}}, nil
}

func (s *Server) ListSCIMSchemas(ctx context.Context, _ openapi.ListSCIMSchemasRequestObject) (openapi.ListSCIMSchemasResponseObject, error) {
	if _, err := requireSCIMConnector(ctx); err != nil {
		return nil, err
	}
	resource := map[string]any{"id": scimservice.UserSchema(), "name": "User", "description": "Makerspace Core SCIM User", "schemas": []string{"urn:ietf:params:scim:schemas:core:2.0:Schema"}}
	return openapi.ListSCIMSchemas200ApplicationScimPlusJSONResponse{Schemas: []string{scimListSchema}, TotalResults: 1, StartIndex: 1, ItemsPerPage: 1, Resources: []map[string]any{resource}}, nil
}

func (s *Server) ListSCIMUsers(ctx context.Context, request openapi.ListSCIMUsersRequestObject) (openapi.ListSCIMUsersResponseObject, error) {
	connector, err := requireSCIMConnector(ctx)
	if err != nil {
		return nil, err
	}
	filter, start, count := "", 1, 100
	if request.Params.Filter != nil {
		filter = *request.Params.Filter
	}
	if request.Params.StartIndex != nil {
		start = *request.Params.StartIndex
	}
	if request.Params.Count != nil {
		count = *request.Params.Count
	}
	page, err := s.scim.ListUsers(ctx, connector, filter, start, count)
	if err != nil {
		if protocol := protocolError(err); protocol != nil {
			return openapi.ListSCIMUsers400ApplicationScimPlusJSONResponse(scimErrorDTO(protocol)), nil
		}
		return nil, err
	}
	resources := make([]openapi.SCIMUser, 0, len(page.Items))
	for _, user := range page.Items {
		resources = append(resources, scimUserDTO(user))
	}
	return openapi.ListSCIMUsers200ApplicationScimPlusJSONResponse{Schemas: []string{scimListSchema}, TotalResults: int(page.Total), StartIndex: page.StartIndex, ItemsPerPage: len(resources), Resources: resources}, nil
}

func (s *Server) CreateSCIMUser(ctx context.Context, request openapi.CreateSCIMUserRequestObject) (openapi.CreateSCIMUserResponseObject, error) {
	connector, err := requireSCIMConnector(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return openapi.CreateSCIMUser400ApplicationScimPlusJSONResponse(scimErrorDTO(&scimservice.ProtocolError{Status: 400, SCIMType: "invalidSyntax", Detail: "Request body is required"})), nil
	}
	user, err := s.scim.CreateUser(ctx, connector, scimInput(*request.Body), requestIDPointer(ctx))
	if err != nil {
		if protocol := protocolError(err); protocol != nil {
			if protocol.Status == http.StatusConflict {
				return openapi.CreateSCIMUser409ApplicationScimPlusJSONResponse(scimErrorDTO(protocol)), nil
			}
			return openapi.CreateSCIMUser400ApplicationScimPlusJSONResponse(scimErrorDTO(protocol)), nil
		}
		return nil, err
	}
	return openapi.CreateSCIMUser201ApplicationScimPlusJSONResponse(scimUserDTO(user)), nil
}

func (s *Server) GetSCIMUser(ctx context.Context, request openapi.GetSCIMUserRequestObject) (openapi.GetSCIMUserResponseObject, error) {
	connector, err := requireSCIMConnector(ctx)
	if err != nil {
		return nil, err
	}
	user, err := s.scim.GetUser(ctx, connector, request.ScimUserId)
	if err != nil {
		if protocol := protocolError(err); protocol != nil {
			return openapi.GetSCIMUser404ApplicationScimPlusJSONResponse(scimErrorDTO(protocol)), nil
		}
		return nil, err
	}
	return openapi.GetSCIMUser200ApplicationScimPlusJSONResponse(scimUserDTO(user)), nil
}

func (s *Server) ReplaceSCIMUser(ctx context.Context, request openapi.ReplaceSCIMUserRequestObject) (openapi.ReplaceSCIMUserResponseObject, error) {
	connector, err := requireSCIMConnector(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return openapi.ReplaceSCIMUser400ApplicationScimPlusJSONResponse(scimErrorDTO(&scimservice.ProtocolError{Status: 400, SCIMType: "invalidSyntax", Detail: "Request body is required"})), nil
	}
	user, err := s.scim.ReplaceUser(ctx, connector, request.ScimUserId, scimInput(*request.Body), requestIDPointer(ctx))
	if err != nil {
		if protocol := protocolError(err); protocol != nil {
			switch protocol.Status {
			case 404:
				return openapi.ReplaceSCIMUser404ApplicationScimPlusJSONResponse(scimErrorDTO(protocol)), nil
			case 409:
				return openapi.ReplaceSCIMUser409ApplicationScimPlusJSONResponse(scimErrorDTO(protocol)), nil
			default:
				return openapi.ReplaceSCIMUser400ApplicationScimPlusJSONResponse(scimErrorDTO(protocol)), nil
			}
		}
		return nil, err
	}
	return openapi.ReplaceSCIMUser200ApplicationScimPlusJSONResponse(scimUserDTO(user)), nil
}

func (s *Server) PatchSCIMUser(ctx context.Context, request openapi.PatchSCIMUserRequestObject) (openapi.PatchSCIMUserResponseObject, error) {
	connector, err := requireSCIMConnector(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return openapi.PatchSCIMUser400ApplicationScimPlusJSONResponse(scimErrorDTO(&scimservice.ProtocolError{Status: 400, SCIMType: "invalidSyntax", Detail: "Request body is required"})), nil
	}
	current, err := s.scim.GetUser(ctx, connector, request.ScimUserId)
	if err != nil {
		if protocol := protocolError(err); protocol != nil {
			return openapi.PatchSCIMUser404ApplicationScimPlusJSONResponse(scimErrorDTO(protocol)), nil
		}
		return nil, err
	}
	patched, err := applySCIMPatch(current.Input, request.Body.Operations)
	if err != nil {
		return openapi.PatchSCIMUser400ApplicationScimPlusJSONResponse(scimErrorDTO(protocolError(err))), nil
	}
	user, err := s.scim.ReplaceUser(ctx, connector, request.ScimUserId, patched, requestIDPointer(ctx))
	if err != nil {
		if protocol := protocolError(err); protocol != nil {
			switch protocol.Status {
			case 404:
				return openapi.PatchSCIMUser404ApplicationScimPlusJSONResponse(scimErrorDTO(protocol)), nil
			case 409:
				return openapi.PatchSCIMUser409ApplicationScimPlusJSONResponse(scimErrorDTO(protocol)), nil
			default:
				return openapi.PatchSCIMUser400ApplicationScimPlusJSONResponse(scimErrorDTO(protocol)), nil
			}
		}
		return nil, err
	}
	return openapi.PatchSCIMUser200ApplicationScimPlusJSONResponse(scimUserDTO(user)), nil
}

func (s *Server) DeleteSCIMUser(ctx context.Context, request openapi.DeleteSCIMUserRequestObject) (openapi.DeleteSCIMUserResponseObject, error) {
	connector, err := requireSCIMConnector(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.scim.DeleteUser(ctx, connector, request.ScimUserId, requestIDPointer(ctx)); err != nil {
		if protocol := protocolError(err); protocol != nil {
			if protocol.Status == http.StatusConflict {
				return openapi.DeleteSCIMUser409ApplicationScimPlusJSONResponse(scimErrorDTO(protocol)), nil
			}
			return openapi.DeleteSCIMUser404ApplicationScimPlusJSONResponse(scimErrorDTO(protocol)), nil
		}
		return nil, err
	}
	return openapi.DeleteSCIMUser204Response{}, nil
}

func requireSCIMConnector(ctx context.Context) (scimservice.ConnectorContext, error) {
	connector, ok := ctx.Value(scimConnectorContextKey).(scimservice.ConnectorContext)
	if !ok {
		return scimservice.ConnectorContext{}, &scimservice.ProtocolError{Status: 401, Detail: "A valid SCIM bearer token is required"}
	}
	return connector, nil
}

func scimConnectorDTO(connector scimservice.Connector) openapi.SCIMConnector {
	return openapi.SCIMConnector{Id: connector.ID, Name: connector.Name, OidcProviderId: nullablePointer(connector.OIDCProviderID, func(id uuid.UUID) openapi.UUIDv7 { return id }), Enabled: connector.Enabled, TokenExpiresAt: nullablePointer(connector.TokenExpiresAt, func(v time.Time) time.Time { return v }), TokenRevokedAt: nullablePointer(connector.TokenRevokedAt, func(v time.Time) time.Time { return v }), Version: connector.Version, CreatedAt: connector.CreatedAt, UpdatedAt: connector.UpdatedAt}
}

func scimReconciliationDTO(report scimservice.ReconciliationReport) openapi.SCIMReconciliationReport {
	conflicts := make([]openapi.SCIMReconciliationConflict, 0, len(report.Conflicts))
	for _, conflict := range report.Conflicts {
		conflicts = append(conflicts, openapi.SCIMReconciliationConflict{Code: conflict.Code, Message: conflict.Message, ResourceId: nullablePointer(conflict.ResourceID, func(id uuid.UUID) openapi.UUIDv7 { return id })})
	}
	return openapi.SCIMReconciliationReport{CanReconcile: report.CanReconcile, Completed: report.Completed, ProvisionalAccountId: report.ProvisionalAccountID, TargetAccountId: report.TargetAccountID, Conflicts: conflicts}
}

func scimInput(input openapi.SCIMUserWrite) scimservice.UserInput {
	var externalID *string
	if input.ExternalId.IsSpecified() && !input.ExternalId.IsNull() {
		value := input.ExternalId.GetOrEmpty()
		externalID = &value
	}
	return scimservice.UserInput{UserName: input.UserName, ExternalID: externalID, Active: input.Active, GivenName: input.Name.GivenName, FamilyName: input.Name.FamilyName, Emails: scimMultiValues(input.Emails), PhoneNumbers: scimMultiValues(input.PhoneNumbers)}
}

func scimMultiValues(values *[]openapi.SCIMMultiValue) []scimservice.MultiValue {
	if values == nil {
		return []scimservice.MultiValue{}
	}
	result := make([]scimservice.MultiValue, 0, len(*values))
	for _, value := range *values {
		item := scimservice.MultiValue{Value: value.Value}
		if value.Type != nil {
			item.Type = *value.Type
		}
		if value.Primary != nil {
			item.Primary = *value.Primary
		}
		result = append(result, item)
	}
	return result
}

func scimUserDTO(user scimservice.User) openapi.SCIMUser {
	externalID := nullable.NewNullNullable[string]()
	if user.Input.ExternalID != nil {
		externalID = nullable.NewNullableWithValue(*user.Input.ExternalID)
	}
	emails := make([]openapi.SCIMMultiValue, 0, len(user.Input.Emails))
	for _, value := range user.Input.Emails {
		item := openapi.SCIMMultiValue{Value: value.Value}
		if value.Type != "" {
			item.Type = &value.Type
		}
		if value.Primary {
			primary := true
			item.Primary = &primary
		}
		emails = append(emails, item)
	}
	phones := make([]openapi.SCIMMultiValue, 0, len(user.Input.PhoneNumbers))
	for _, value := range user.Input.PhoneNumbers {
		item := openapi.SCIMMultiValue{Value: value.Value}
		if value.Type != "" {
			item.Type = &value.Type
		}
		if value.Primary {
			primary := true
			item.Primary = &primary
		}
		phones = append(phones, item)
	}
	return openapi.SCIMUser{Id: user.ID, Schemas: []string{scimservice.UserSchema()}, UserName: user.Input.UserName, ExternalId: externalID, Active: user.Input.Active, Name: openapi.SCIMName{GivenName: user.Input.GivenName, FamilyName: user.Input.FamilyName}, Emails: &emails, PhoneNumbers: &phones, Meta: openapi.SCIMMeta{ResourceType: openapi.User, Created: user.CreatedAt, LastModified: user.UpdatedAt, Location: "/api/v1/scim/v2/Users/" + user.ID.String(), Version: fmt.Sprintf("W/\"%d\"", user.Version)}}
}

func nullableUUID(value nullable.Nullable[openapi.UUIDv7]) *uuid.UUID {
	if !value.IsSpecified() || value.IsNull() {
		return nil
	}
	id := uuid.UUID(value.GetOrEmpty())
	return &id
}

func protocolError(err error) *scimservice.ProtocolError {
	var result *scimservice.ProtocolError
	if errors.As(err, &result) {
		return result
	}
	return nil
}
func scimErrorDTO(err *scimservice.ProtocolError) openapi.SCIMError {
	result := openapi.SCIMError{Schemas: []string{scimErrorSchema}, Status: strconv.Itoa(err.Status), Detail: err.Detail}
	if err.SCIMType != "" {
		result.ScimType = &err.SCIMType
	}
	return result
}

func writeSCIMAuthenticationError(w http.ResponseWriter, r *http.Request, logger *slog.Logger) {
	writeSCIMServiceError(w, r, &scimservice.ProtocolError{Status: 401, Detail: "A valid SCIM bearer token is required"}, logger)
}
func writeSCIMServiceError(w http.ResponseWriter, r *http.Request, err error, logger *slog.Logger) {
	protocol := protocolError(err)
	if protocol == nil {
		logger.ErrorContext(r.Context(), "SCIM request failed", "request_id", requestIDString(r.Context()), "error_type", fmt.Sprintf("%T", err))
		protocol = &scimservice.ProtocolError{Status: 500, Detail: "An internal error occurred"}
	}
	w.Header().Set("Content-Type", "application/scim+json")
	w.WriteHeader(protocol.Status)
	_ = json.NewEncoder(w).Encode(scimErrorDTO(protocol))
}

func applySCIMPatch(input scimservice.UserInput, operations []openapi.SCIMPatchOperation) (scimservice.UserInput, error) {
	for _, operation := range operations {
		path := ""
		if operation.Path != nil {
			path = strings.TrimSpace(*operation.Path)
		}
		if path == "" {
			values, ok := operation.Value.(map[string]any)
			if !ok {
				return input, &scimservice.ProtocolError{Status: 400, SCIMType: "invalidSyntax", Detail: "A patch without path requires an object value"}
			}
			for key, value := range values {
				var err error
				input, err = applySCIMPatchValue(input, strings.ToLower(key), operation.Op, value)
				if err != nil {
					return input, err
				}
			}
			continue
		}
		var err error
		input, err = applySCIMPatchValue(input, strings.ToLower(path), operation.Op, operation.Value)
		if err != nil {
			return input, err
		}
	}
	return input, nil
}

func applySCIMPatchValue(input scimservice.UserInput, path string, operation openapi.SCIMPatchOperationOp, value any) (scimservice.UserInput, error) {
	remove := operation == openapi.Remove
	decode := func(target any) error {
		encoded, err := json.Marshal(value)
		if err != nil {
			return err
		}
		return json.Unmarshal(encoded, target)
	}
	switch path {
	case "username":
		if remove {
			input.UserName = ""
		} else if err := decode(&input.UserName); err != nil {
			return input, invalidSCIMPatch()
		}
	case "externalid":
		if remove || value == nil {
			input.ExternalID = nil
		} else {
			var v string
			if err := decode(&v); err != nil {
				return input, invalidSCIMPatch()
			}
			input.ExternalID = &v
		}
	case "active":
		if remove {
			input.Active = false
		} else if err := decode(&input.Active); err != nil {
			return input, invalidSCIMPatch()
		}
	case "name.givenname":
		if remove {
			input.GivenName = ""
		} else if err := decode(&input.GivenName); err != nil {
			return input, invalidSCIMPatch()
		}
	case "name.familyname":
		if remove {
			input.FamilyName = ""
		} else if err := decode(&input.FamilyName); err != nil {
			return input, invalidSCIMPatch()
		}
	case "name":
		if remove {
			input.GivenName, input.FamilyName = "", ""
		} else {
			var name openapi.SCIMName
			if err := decode(&name); err != nil {
				return input, invalidSCIMPatch()
			}
			input.GivenName, input.FamilyName = name.GivenName, name.FamilyName
		}
	case "emails":
		if remove {
			input.Emails = []scimservice.MultiValue{}
		} else {
			var values []openapi.SCIMMultiValue
			if err := decode(&values); err != nil {
				return input, invalidSCIMPatch()
			}
			input.Emails = scimMultiValues(&values)
		}
	case "phonenumbers":
		if remove {
			input.PhoneNumbers = []scimservice.MultiValue{}
		} else {
			var values []openapi.SCIMMultiValue
			if err := decode(&values); err != nil {
				return input, invalidSCIMPatch()
			}
			input.PhoneNumbers = scimMultiValues(&values)
		}
	default:
		return input, &scimservice.ProtocolError{Status: 400, SCIMType: "invalidPath", Detail: "The patch path is not supported"}
	}
	return input, nil
}

func invalidSCIMPatch() error {
	return &scimservice.ProtocolError{Status: 400, SCIMType: "invalidValue", Detail: "The patch value is invalid"}
}
