package accounts

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	accountsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/accounts/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	mailservice "github.com/Basmatireis/Makerspace-Core/backend/internal/mail"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) IssuePasswordReset(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expectedVersion int64,
	requestID *uuid.UUID,
) (ResetIssue, error) {
	if !principal.Has(authorization.AccountsPasswordReset) {
		return ResetIssue{}, apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return ResetIssue{}, apperror.InvalidField("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ResetIssue{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := accountsdb.New(tx)
	current, err := loadAccountForMutation(ctx, queries, id)
	if err != nil {
		return ResetIssue{}, err
	}
	if current.Version != expectedVersion {
		return ResetIssue{}, apperror.StaleWrite
	}
	identity, err := queries.GetIdentityByAccount(ctx, id)
	if err != nil {
		return ResetIssue{}, err
	}
	code, err := security.NewChallengeCode()
	if err != nil {
		return ResetIssue{}, err
	}
	expiresAt := time.Now().UTC().Add(s.config.PasswordResetTTL)
	actor := principal.AccountID
	if identity.IdentifierDisplay == nil {
		return ResetIssue{}, apperror.InvalidField("the account has no password login email")
	}
	challenge, err := queries.UpsertAuthChallenge(ctx, accountsdb.UpsertAuthChallengeParams{
		ID: ids.New(), Kind: string(auth.ChallengePasswordReset), AccountID: id,
		AuthIdentityID:  &identity.ID,
		CodeDigest:      security.ChallengeDigest(s.config.ChallengeHMACKey, "password_reset", id, code),
		DeliveryAddress: identity.IdentifierDisplay, CreatedByAccountID: &actor, ExpiresAt: expiresAt,
	})
	if err != nil {
		return ResetIssue{}, err
	}
	if _, err := queries.BumpAccountVersion(
		ctx,
		accountsdb.BumpAccountVersionParams{ID: id, ExpectedVersion: expectedVersion},
	); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return ResetIssue{}, apperror.StaleWrite
	} else if err != nil {
		return ResetIssue{}, err
	}
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "account.password_reset_issued",
			ResourceType:   "account",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"passwordChallenge"},
		},
	); err != nil {
		return ResetIssue{}, err
	}
	result, err := loadAccount(ctx, queries, id)
	if err != nil {
		return ResetIssue{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ResetIssue{}, err
	}
	deliveryErr := mailservice.ErrDisabled
	if s.notifier != nil {
		deliveryErr = s.notifier.SendPasswordReset(ctx, *identity.IdentifierDisplay, code, expiresAt)
	}
	status := auth.DeliverySent
	var failureCode *string
	if errors.Is(deliveryErr, mailservice.ErrDisabled) {
		status = auth.DeliveryManual
	} else if deliveryErr != nil {
		status = auth.DeliveryFailed
		code := "provider_error"
		failureCode = &code
	}
	_ = accountsdb.New(s.pool).
		SetAuthChallengeDelivery(
			ctx,
			accountsdb.SetAuthChallengeDeliveryParams{
				ID:                  challenge.ID,
				DeliveryStatus:      string(status),
				DeliveryFailureCode: failureCode,
			},
		)
	if errors.Is(deliveryErr, mailservice.ErrDisabled) {
		manual := "/reset-password#email=" + url.QueryEscape(
			*identity.IdentifierDisplay,
		) + "&code=" + url.QueryEscape(
			code,
		)
		return ResetIssue{ExpiresAt: expiresAt, Account: result, DeliveryStatus: auth.DeliveryManual, SetupURL: &manual}, nil
	}
	if deliveryErr != nil {
		return ResetIssue{}, apperror.New(
			http.StatusServiceUnavailable,
			"mail_delivery_failed",
			"Password recovery could not be delivered",
		)
	}
	return ResetIssue{ExpiresAt: expiresAt, Account: result, DeliveryStatus: auth.DeliverySent}, nil
}

func (s *Service) IssuePINEnrollment(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expectedVersion int64,
	requestID *uuid.UUID,
) (ResetIssue, error) {
	if !principal.Has(authorization.AccountsPINEnrollAll) && !principal.Has(authorization.AccountsPINReset) {
		return ResetIssue{}, apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return ResetIssue{}, apperror.InvalidField("expectedVersion must be positive")
	}
	notifier, notifierAvailable := s.notifier.(PINEnrollmentNotificationService)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ResetIssue{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := accountsdb.New(tx)
	current, err := loadAccountForMutation(ctx, queries, id)
	if err != nil {
		return ResetIssue{}, err
	}
	if current.Version != expectedVersion {
		return ResetIssue{}, apperror.StaleWrite
	}
	var pinIdentityID *uuid.UUID
	for _, identity := range current.AuthIdentities {
		if identity.Kind == IdentityPIN {
			value := identity.ID
			pinIdentityID = &value
			break
		}
	}
	if pinIdentityID == nil && !principal.Has(authorization.AccountsPINEnrollAll) {
		return ResetIssue{}, apperror.PermissionDenied
	}
	if pinIdentityID != nil && !principal.Has(authorization.AccountsPINReset) {
		return ResetIssue{}, apperror.PermissionDenied
	}
	deliveryAddress, err := queries.GetPersonEmailForAccount(ctx, id)
	if err != nil {
		return ResetIssue{}, err
	}
	code, err := security.NewChallengeCode()
	if err != nil {
		return ResetIssue{}, err
	}
	expiresAt := time.Now().UTC().Add(s.config.PasswordResetTTL)
	actor := principal.AccountID
	challenge, err := queries.UpsertAuthChallenge(ctx, accountsdb.UpsertAuthChallengeParams{
		ID: ids.New(), Kind: string(auth.ChallengePINEnrollment), AccountID: id,
		AuthIdentityID: pinIdentityID, CodeDigest: security.ChallengeDigest(
			s.config.ChallengeHMACKey,
			"pin_enrollment",
			id,
			code,
		),
		DeliveryAddress: deliveryAddress, CreatedByAccountID: &actor, ExpiresAt: expiresAt,
	})
	if err != nil {
		return ResetIssue{}, err
	}
	if _, err := queries.BumpAccountVersion(
		ctx,
		accountsdb.BumpAccountVersionParams{ID: id, ExpectedVersion: expectedVersion},
	); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return ResetIssue{}, apperror.StaleWrite
	} else if err != nil {
		return ResetIssue{}, err
	}
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "account.pin_enrollment_issued",
			ResourceType:   "account",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"pinEnrollmentChallenge"},
		},
	); err != nil {
		return ResetIssue{}, err
	}
	result, err := loadAccount(ctx, queries, id)
	if err != nil {
		return ResetIssue{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ResetIssue{}, err
	}
	deliveryErr := mailservice.ErrDisabled
	if notifierAvailable && deliveryAddress != nil {
		deliveryErr = notifier.SendPINEnrollment(ctx, *deliveryAddress, id, code, expiresAt)
	}
	status := auth.DeliverySent
	var failureCode *string
	if errors.Is(deliveryErr, mailservice.ErrDisabled) {
		status = auth.DeliveryManual
	} else if deliveryErr != nil {
		status = auth.DeliveryFailed
		value := "provider_error"
		failureCode = &value
	}
	_ = accountsdb.New(s.pool).
		SetAuthChallengeDelivery(
			ctx,
			accountsdb.SetAuthChallengeDeliveryParams{
				ID:                  challenge.ID,
				DeliveryStatus:      string(status),
				DeliveryFailureCode: failureCode,
			},
		)
	if errors.Is(deliveryErr, mailservice.ErrDisabled) {
		manual := "/complete-pin-setup#account=" + id.String() + "&code=" + url.QueryEscape(code)
		return ResetIssue{ExpiresAt: expiresAt, Account: result, DeliveryStatus: auth.DeliveryManual, SetupURL: &manual}, nil
	}
	if deliveryErr != nil {
		return ResetIssue{}, apperror.New(
			http.StatusServiceUnavailable,
			"mail_delivery_failed",
			"PIN setup could not be delivered",
		)
	}
	return ResetIssue{ExpiresAt: expiresAt, Account: result, DeliveryStatus: auth.DeliverySent}, nil
}

func (s *Service) IssueInvitation(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expectedVersion int64,
	requestID *uuid.UUID,
) (ResetIssue, error) {
	if !principal.Has(authorization.AccountsPasswordEnrollAll) {
		return ResetIssue{}, apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return ResetIssue{}, apperror.InvalidField("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ResetIssue{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := accountsdb.New(tx)
	current, err := loadAccountForMutation(ctx, queries, id)
	if err != nil {
		return ResetIssue{}, err
	}
	if current.Version != expectedVersion {
		return ResetIssue{}, apperror.StaleWrite
	}
	if current.PasswordStatus == PasswordActive {
		return ResetIssue{}, apperror.New(
			http.StatusConflict,
			"password_already_enrolled",
			"Use password reset for an account that already has a password",
		)
	}
	identity, err := queries.GetIdentityByAccount(ctx, id)
	if err != nil {
		return ResetIssue{}, err
	}
	if identity.IdentifierDisplay == nil {
		return ResetIssue{}, apperror.InvalidField("the account has no password login email")
	}
	code, err := security.NewChallengeCode()
	if err != nil {
		return ResetIssue{}, err
	}
	expiresAt := time.Now().UTC().Add(s.config.PasswordResetTTL)
	actor := principal.AccountID
	challenge, err := queries.UpsertAuthChallenge(ctx, accountsdb.UpsertAuthChallengeParams{
		ID: ids.New(), Kind: string(auth.ChallengeInvitation), AccountID: id,
		AuthIdentityID:  &identity.ID,
		CodeDigest:      security.ChallengeDigest(s.config.ChallengeHMACKey, "invitation", id, code),
		DeliveryAddress: identity.IdentifierDisplay, CreatedByAccountID: &actor, ExpiresAt: expiresAt,
	})
	if err != nil {
		return ResetIssue{}, err
	}
	if err := queries.MarkInvitationProvisioning(ctx, id); err != nil {
		return ResetIssue{}, err
	}
	if _, err := queries.BumpAccountVersion(
		ctx,
		accountsdb.BumpAccountVersionParams{ID: id, ExpectedVersion: expectedVersion},
	); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return ResetIssue{}, apperror.StaleWrite
	} else if err != nil {
		return ResetIssue{}, err
	}
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "account.invitation_issued",
			ResourceType:   "account",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"invitation"},
		},
	); err != nil {
		return ResetIssue{}, err
	}
	result, err := loadAccount(ctx, queries, id)
	if err != nil {
		return ResetIssue{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ResetIssue{}, err
	}
	deliveryErr := mailservice.ErrDisabled
	if s.notifier != nil {
		deliveryErr = s.notifier.SendInvitation(ctx, *identity.IdentifierDisplay, code, expiresAt)
	}
	status := auth.DeliverySent
	var failureCode *string
	if errors.Is(deliveryErr, mailservice.ErrDisabled) {
		status = auth.DeliveryManual
	} else if deliveryErr != nil {
		status = auth.DeliveryFailed
		code := "provider_error"
		failureCode = &code
	}
	_ = accountsdb.New(s.pool).
		SetAuthChallengeDelivery(
			ctx,
			accountsdb.SetAuthChallengeDeliveryParams{
				ID:                  challenge.ID,
				DeliveryStatus:      string(status),
				DeliveryFailureCode: failureCode,
			},
		)
	if errors.Is(deliveryErr, mailservice.ErrDisabled) {
		manual := "/complete-invitation#email=" + url.QueryEscape(
			*identity.IdentifierDisplay,
		) + "&code=" + url.QueryEscape(
			code,
		)
		return ResetIssue{ExpiresAt: expiresAt, Account: result, DeliveryStatus: auth.DeliveryManual, SetupURL: &manual}, nil
	}
	if deliveryErr != nil {
		return ResetIssue{}, apperror.New(
			http.StatusServiceUnavailable,
			"mail_delivery_failed",
			"Invitation could not be delivered",
		)
	}
	return ResetIssue{ExpiresAt: expiresAt, Account: result, DeliveryStatus: auth.DeliverySent}, nil
}
