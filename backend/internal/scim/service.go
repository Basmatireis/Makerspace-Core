package scim

import (
	"errors"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const userSchema = "urn:ietf:params:scim:schemas:core:2.0:User"

type Connector struct {
	ID                             uuid.UUID
	Name                           string
	OIDCProviderID                 *uuid.UUID
	Enabled                        bool
	TokenExpiresAt, TokenRevokedAt *time.Time
	Version                        int64
	CreatedAt, UpdatedAt           time.Time
}

type TokenIssue struct {
	Connector   Connector
	BearerToken string
}

type ConnectorContext struct {
	ID             uuid.UUID
	Name           string
	OIDCProviderID *uuid.UUID
	Issuer         *string
}

type MultiValue struct {
	Value   string `json:"value"`
	Type    string `json:"type,omitempty"`
	Primary bool   `json:"primary,omitempty"`
}

type UserInput struct {
	UserName     string       `json:"userName"`
	ExternalID   *string      `json:"externalId,omitempty"`
	Active       bool         `json:"active"`
	GivenName    string       `json:"givenName"`
	FamilyName   string       `json:"familyName"`
	Emails       []MultiValue `json:"emails,omitempty"`
	PhoneNumbers []MultiValue `json:"phoneNumbers,omitempty"`
}

type User struct {
	ID                   uuid.UUID
	Input                UserInput
	Version              int64
	CreatedAt, UpdatedAt time.Time
}

type Page struct {
	Items      []User
	Total      int64
	StartIndex int
}

type Conflict struct {
	Code       string
	ResourceID *uuid.UUID
	Message    string
}

type ReconciliationReport struct {
	CanReconcile                          bool
	ProvisionalAccountID, TargetAccountID uuid.UUID
	Conflicts                             []Conflict
	Completed                             bool
}

type ProtocolError struct {
	Status   int
	SCIMType string
	Detail   string
}

func (e *ProtocolError) Error() string { return e.Detail }

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func databaseError(err error) error {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) && postgresError.Code == "23505" {
		return apperror.Conflict
	}
	if errors.As(err, &postgresError) && postgresError.Code == "23503" {
		return apperror.Validation
	}
	return err
}

func protocolDatabaseError(err error) error {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) && postgresError.Code == "23505" {
		return &ProtocolError{
			Status:   409,
			SCIMType: "uniqueness",
			Detail:   "A connector-scoped identifier or external identity is already in use",
		}
	}
	if errors.As(err, &postgresError) && (postgresError.Code == "23503" || postgresError.Code == "23514") {
		return &ProtocolError{Status: 400, SCIMType: "invalidValue", Detail: "The supplied User data is invalid"}
	}
	return err
}

func sameUUID(left, right *uuid.UUID) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func stringPointer(value string) *string { return &value }

func UserSchema() string { return userSchema }
