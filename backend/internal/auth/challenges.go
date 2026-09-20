package auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	authdb "github.com/Basmatireis/Makerspace-Core/backend/internal/auth/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) RequestPasswordReset(ctx context.Context, email, sourceKey string, requestID *uuid.UUID) error {
	_, normalized, normalizeErr := security.NormalizeEmail(email)
	if normalized == "" {
		normalized = strings.ToLower(strings.TrimSpace(email))
	}
	allowed, err := s.consumeChallengeLimit(ctx, "password_reset_request_source", sourceKey, 10)
	if err != nil {
		return err
	}
	emailAllowed, err := s.consumeChallengeLimit(ctx, "password_reset_request_identifier", normalized, 5)
	if err != nil {
		return err
	}
	if normalizeErr != nil || !allowed || !emailAllowed {
		return nil
	}
	target, err := authdb.New(s.pool).FindPasswordChallengeTarget(ctx, normalized)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && target.Status != "enabled") {
		return nil
	}
	if err != nil {
		return err
	}
	if target.DeliveryAddress == nil || s.notifier == nil {
		return nil
	}
	code, err := security.NewChallengeCode()
	if err != nil {
		return err
	}
	expiresAt := time.Now().UTC().Add(s.config.PasswordResetTTL)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := authdb.New(tx)
	if err := lockPasswordChallengeTarget(ctx, queries, target.AccountID, target.AuthIdentityID, normalized); err != nil {
		if apperror.IsCode(err, "challenge_invalid") {
			return nil
		}
		return err
	}
	challenge, err := queries.UpsertAuthChallenge(ctx, authdb.UpsertAuthChallengeParams{
		ID: uuid.Must(uuid.NewV7()), Kind: "password_reset", AccountID: target.AccountID,
		AuthIdentityID: &target.AuthIdentityID, CodeDigest: s.challengeDigest("password_reset", target.AccountID, code),
		DeliveryAddress: *target.DeliveryAddress, ExpiresAt: expiresAt,
	})
	if err != nil {
		return err
	}
	if err := audit.Write(ctx, tx, audit.Event{Action: "account.password_reset_requested", ResourceType: "account", ResourceID: &target.AccountID, RequestID: requestID}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	deliveryErr := s.notifier.SendPasswordReset(ctx, *target.DeliveryAddress, code, expiresAt)
	s.recordChallengeDelivery(ctx, challenge.ID, deliveryErr)
	return nil
}

func (s *Service) CompletePasswordResetCode(ctx context.Context, email, code, newPassword, sourceKey string, requestID *uuid.UUID) error {
	if err := security.ValidatePassword(newPassword); err != nil {
		return validationError(err.Error())
	}
	_, normalized, normalizeErr := security.NormalizeEmail(email)
	allowed, err := s.consumeChallengeLimit(ctx, "password_reset_verify_source", sourceKey, 10)
	if err != nil {
		return err
	}
	identifierAllowed, err := s.consumeChallengeLimit(ctx, "password_reset_verify_identifier", normalized, 5)
	if err != nil {
		return err
	}
	if normalizeErr != nil || !allowed || !identifierAllowed {
		return invalidChallenge()
	}
	target, err := authdb.New(s.pool).FindPasswordIdentityTarget(ctx, normalized)
	if errors.Is(err, pgx.ErrNoRows) {
		return invalidChallenge()
	}
	if err != nil {
		return err
	}
	newHash, err := security.HashPassword(newPassword)
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := authdb.New(tx)
	if err := lockPasswordChallengeTarget(ctx, queries, target.AccountID, target.AuthIdentityID, normalized); err != nil {
		return err
	}
	challenge, err := queries.GetActiveAuthChallengeForUpdate(ctx, authdb.GetActiveAuthChallengeForUpdateParams{AccountID: target.AccountID, Kind: "password_reset"})
	if errors.Is(err, pgx.ErrNoRows) {
		return invalidChallenge()
	}
	if err != nil {
		return err
	}
	if !s.challengeValid(challenge, code) {
		if challenge.UsedAt.Valid || challenge.CancelledAt.Valid || challenge.AttemptCount >= 5 || !challenge.ExpiresAt.After(time.Now().UTC()) {
			return invalidChallenge()
		}
		if err := queries.IncrementAuthChallengeFailure(ctx, challenge.ID); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return invalidChallenge()
	}
	if challenge.AuthIdentityID == nil || *challenge.AuthIdentityID != target.AuthIdentityID {
		return invalidChallenge()
	}
	if err := queries.UpsertPasswordCredential(ctx, authdb.UpsertPasswordCredentialParams{AuthIdentityID: target.AuthIdentityID, PasswordHash: newHash}); err != nil {
		return err
	}
	if err := queries.UseAuthChallenge(ctx, challenge.ID); err != nil {
		return err
	}
	if err := queries.RevokeSessionsForAccount(ctx, authdb.RevokeSessionsForAccountParams{AccountID: target.AccountID, Reason: ptr("password_reset")}); err != nil {
		return err
	}
	if err := queries.BumpAccountVersionAfterCredentialChange(ctx, target.AccountID); err != nil {
		return err
	}
	if err := audit.Write(ctx, tx, audit.Event{Action: "account.password_reset_completed", ResourceType: "account", ResourceID: &target.AccountID, RequestID: requestID, ChangedFields: []string{"password"}}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if s.notifier != nil && target.DeliveryAddress != nil {
		_ = s.notifier.SendSecurityNotice(ctx, *target.DeliveryAddress, "Makerspace password reset", "Your Makerspace password was reset. If this was not you, contact an administrator immediately.")
	}
	return nil
}

func (s *Service) CompleteInvitation(ctx context.Context, email, code, newPassword, sourceKey string, requestID *uuid.UUID) error {
	if err := security.ValidatePassword(newPassword); err != nil {
		return validationError(err.Error())
	}
	_, normalized, normalizeErr := security.NormalizeEmail(email)
	allowed, err := s.consumeChallengeLimit(ctx, "invitation_verify_source", sourceKey, 10)
	if err != nil {
		return err
	}
	identifierAllowed, err := s.consumeChallengeLimit(ctx, "invitation_verify_identifier", normalized, 5)
	if err != nil {
		return err
	}
	if normalizeErr != nil || !allowed || !identifierAllowed {
		return invalidChallenge()
	}
	target, err := authdb.New(s.pool).FindPasswordIdentityTarget(ctx, normalized)
	if errors.Is(err, pgx.ErrNoRows) {
		return invalidChallenge()
	}
	if err != nil {
		return err
	}
	newHash, err := security.HashPassword(newPassword)
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := authdb.New(tx)
	if err := lockPasswordChallengeTarget(ctx, queries, target.AccountID, target.AuthIdentityID, normalized); err != nil {
		return err
	}
	challenge, err := queries.GetActiveAuthChallengeForUpdate(ctx, authdb.GetActiveAuthChallengeForUpdateParams{AccountID: target.AccountID, Kind: "invitation"})
	if errors.Is(err, pgx.ErrNoRows) {
		return invalidChallenge()
	}
	if err != nil {
		return err
	}
	if !s.challengeValid(challenge, code) {
		if challenge.UsedAt.Valid || challenge.CancelledAt.Valid || challenge.AttemptCount >= 5 || !challenge.ExpiresAt.After(time.Now().UTC()) {
			return invalidChallenge()
		}
		if err := queries.IncrementAuthChallengeFailure(ctx, challenge.ID); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return invalidChallenge()
	}
	if challenge.AuthIdentityID == nil || *challenge.AuthIdentityID != target.AuthIdentityID {
		return invalidChallenge()
	}
	if err := queries.UpsertPasswordCredential(ctx, authdb.UpsertPasswordCredentialParams{AuthIdentityID: target.AuthIdentityID, PasswordHash: newHash}); err != nil {
		return err
	}
	if err := queries.VerifyPasswordIdentity(ctx, target.AuthIdentityID); err != nil {
		return err
	}
	if err := queries.UseAuthChallenge(ctx, challenge.ID); err != nil {
		return err
	}
	if err := queries.EnableInvitedAccount(ctx, target.AccountID); err != nil {
		return err
	}
	if err := queries.BumpAccountVersionAfterCredentialChange(ctx, target.AccountID); err != nil {
		return err
	}
	if err := queries.RevokeSessionsForAccount(ctx, authdb.RevokeSessionsForAccountParams{AccountID: target.AccountID, Reason: ptr("invitation_completed")}); err != nil {
		return err
	}
	if err := audit.Write(ctx, tx, audit.Event{Action: "account.invitation_completed", ResourceType: "account", ResourceID: &target.AccountID, RequestID: requestID, ChangedFields: []string{"password", "emailVerification", "status"}}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if s.notifier != nil && target.DeliveryAddress != nil {
		_ = s.notifier.SendSecurityNotice(ctx, *target.DeliveryAddress, "Makerspace account activated", "Your Makerspace invitation was completed and your password was set.")
	}
	return nil
}

func (s *Service) RequestOwnEmailVerification(ctx context.Context, principal authorization.Principal, requestID *uuid.UUID) error {
	if s.notifier == nil {
		return apperror.New(503, "mail_unavailable", "Email verification delivery is unavailable")
	}
	allowed, err := s.consumeChallengeLimit(ctx, "email_verification_request_account", principal.AccountID.String(), 5)
	if err != nil {
		return err
	}
	if !allowed {
		return apperror.New(429, "verification_rate_limited", "Too many verification requests; try again later")
	}
	code, err := security.NewChallengeCode()
	if err != nil {
		return err
	}
	expiresAt := time.Now().UTC().Add(s.config.PasswordResetTTL)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := authdb.New(tx)
	if _, err := queries.GetAccountForAuthentication(ctx, principal.AccountID); errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	} else if err != nil {
		return err
	}
	target, err := queries.GetPasswordIdentityTargetForAccount(ctx, principal.AccountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if target.VerifiedAt.Valid {
		return apperror.New(409, "email_already_verified", "The local login email is already verified")
	}
	if target.DeliveryAddress == nil {
		return apperror.New(503, "mail_unavailable", "Email verification delivery is unavailable")
	}
	challenge, err := queries.UpsertAuthChallenge(ctx, authdb.UpsertAuthChallengeParams{
		ID: uuid.Must(uuid.NewV7()), Kind: "email_verification", AccountID: principal.AccountID,
		AuthIdentityID: &target.AuthIdentityID, CodeDigest: s.challengeDigest("email_verification", principal.AccountID, code),
		DeliveryAddress: *target.DeliveryAddress, CreatedByAccountID: &principal.AccountID, ExpiresAt: expiresAt,
	})
	if err != nil {
		return err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "account.email_verification_requested", ResourceType: "account", ResourceID: &actor, RequestID: requestID, ChangedFields: []string{"emailVerification"}}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	deliveryErr := s.notifier.SendEmailVerification(ctx, *target.DeliveryAddress, code, expiresAt)
	s.recordChallengeDelivery(ctx, challenge.ID, deliveryErr)
	if deliveryErr != nil {
		return apperror.New(503, "mail_delivery_failed", "Email verification could not be delivered")
	}
	return nil
}

func (s *Service) CompleteEmailVerification(ctx context.Context, email, code, sourceKey string, requestID *uuid.UUID) error {
	_, normalized, normalizeErr := security.NormalizeEmail(email)
	allowed, err := s.consumeChallengeLimit(ctx, "email_verification_verify_source", sourceKey, 10)
	if err != nil {
		return err
	}
	identifierAllowed, err := s.consumeChallengeLimit(ctx, "email_verification_verify_identifier", normalized, 5)
	if err != nil {
		return err
	}
	if normalizeErr != nil || !allowed || !identifierAllowed {
		return invalidChallenge()
	}
	target, err := authdb.New(s.pool).FindPasswordIdentityTarget(ctx, normalized)
	if errors.Is(err, pgx.ErrNoRows) {
		return invalidChallenge()
	}
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := authdb.New(tx)
	if err := lockPasswordChallengeTarget(ctx, queries, target.AccountID, target.AuthIdentityID, normalized); err != nil {
		return err
	}
	challenge, err := queries.GetActiveAuthChallengeForUpdate(ctx, authdb.GetActiveAuthChallengeForUpdateParams{AccountID: target.AccountID, Kind: "email_verification"})
	if errors.Is(err, pgx.ErrNoRows) {
		return invalidChallenge()
	}
	if err != nil {
		return err
	}
	if !s.challengeValid(challenge, code) {
		if challenge.UsedAt.Valid || challenge.CancelledAt.Valid || challenge.AttemptCount >= 5 || !challenge.ExpiresAt.After(time.Now().UTC()) {
			return invalidChallenge()
		}
		if err := queries.IncrementAuthChallengeFailure(ctx, challenge.ID); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return invalidChallenge()
	}
	if challenge.AuthIdentityID == nil || *challenge.AuthIdentityID != target.AuthIdentityID {
		return invalidChallenge()
	}
	if err := queries.VerifyPasswordIdentity(ctx, target.AuthIdentityID); err != nil {
		return err
	}
	if err := queries.UseAuthChallenge(ctx, challenge.ID); err != nil {
		return err
	}
	if err := queries.BumpAccountVersionAfterCredentialChange(ctx, target.AccountID); err != nil {
		return err
	}
	if err := audit.Write(ctx, tx, audit.Event{Action: "account.email_verified", ResourceType: "account", ResourceID: &target.AccountID, RequestID: requestID, ChangedFields: []string{"emailVerification"}}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Use the same account-first lock order as login and administrative credential
// changes. Re-read the identifier after waiting so an old email cannot authorize
// a challenge for an identity that has since changed.
func lockPasswordChallengeTarget(ctx context.Context, queries *authdb.Queries, accountID, identityID uuid.UUID, normalized string) error {
	if _, err := queries.GetAccountForAuthentication(ctx, accountID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return invalidChallenge()
		}
		return err
	}
	current, err := queries.FindPasswordIdentityTarget(ctx, normalized)
	if errors.Is(err, pgx.ErrNoRows) {
		return invalidChallenge()
	}
	if err != nil {
		return err
	}
	if current.AccountID != accountID || current.AuthIdentityID != identityID {
		return invalidChallenge()
	}
	return nil
}

func (s *Service) challengeValid(challenge authdb.AuthChallenge, code string) bool {
	if challenge.UsedAt.Valid || challenge.CancelledAt.Valid || challenge.AttemptCount >= 5 || !challenge.ExpiresAt.After(time.Now().UTC()) {
		return false
	}
	normalized := strings.ToUpper(strings.TrimSpace(code))
	want := s.challengeDigest(challenge.Kind, challenge.AccountID, normalized)
	return hmac.Equal(want, challenge.CodeDigest)
}

func (s *Service) challengeDigest(kind string, accountID uuid.UUID, code string) []byte {
	return security.ChallengeDigest(s.config.ChallengeHMACKey, kind, accountID, code)
}

func (s *Service) consumeChallengeLimit(ctx context.Context, action, value string, maximum int32) (bool, error) {
	mac := hmac.New(sha256.New, s.config.ChallengeHMACKey)
	_, _ = io.WriteString(mac, action)
	_, _ = mac.Write([]byte{0})
	_, _ = io.WriteString(mac, value)
	allowed, err := authdb.New(s.pool).ConsumeAuthRateLimit(ctx, authdb.ConsumeAuthRateLimitParams{Action: action, KeyDigest: mac.Sum(nil), MaxAttempts: maximum})
	return err == nil && allowed != nil && *allowed, err
}

func (s *Service) recordChallengeDelivery(ctx context.Context, id uuid.UUID, deliveryErr error) {
	status := "sent"
	var failureCode *string
	if deliveryErr != nil {
		status = "failed"
		code := "provider_error"
		failureCode = &code
	}
	_ = authdb.New(s.pool).SetAuthChallengeDelivery(ctx, authdb.SetAuthChallengeDeliveryParams{ID: id, DeliveryStatus: status, DeliveryFailureCode: failureCode})
}

func invalidChallenge() error {
	return apperror.New(422, "challenge_invalid", "The code is invalid or expired")
}
