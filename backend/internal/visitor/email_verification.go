package visitor

import (
	"context"
	"crypto/hmac"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	mailservice "github.com/Basmatireis/Makerspace-Core/backend/internal/mail"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	visitordb "github.com/Basmatireis/Makerspace-Core/backend/internal/visitor/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

const (
	// EmailCodeTTL is how long an enrollment verification code stays valid.
	EmailCodeTTL = 10 * time.Minute
	// EmailCodesPerContext bounds the verification mails of one enrollment context, and of one address within
	// emailCodeRateWindow across contexts.
	EmailCodesPerContext = 5
	emailCodeRateWindow  = 15 * time.Minute
	// emailCodeMaxAttempts wrong entries end a code; the column check caps the counter at the same value.
	emailCodeMaxAttempts = 5
	// emailCodeDigestKind separates enrollment codes from account challenges under the same HMAC key.
	emailCodeDigestKind = "visitor_enrollment_email"
)

var errEmailVerificationRequired = apperror.New(
	http.StatusConflict,
	"email_verification_required",
	"Confirm the email address with the mailed code before completing enrollment",
)

func emailCodeRateLimited() error {
	return apperror.RateLimited(
		"verification_rate_limited",
		"Too many verification codes were requested; try again later",
		emailCodeRateWindow,
	)
}

func emailCodeInvalid() error {
	return apperror.New(http.StatusUnprocessableEntity, "challenge_invalid", "The code is invalid or expired")
}

// SendEmailCode binds an address to the enrollment context and mails it a verification code. Delivery is synchronous
// so the kiosk can ask for another address when it fails. An address that is already a login email is refused: the
// visitor checks in instead.
func (s *Service) SendEmailCode(ctx context.Context, enrollment Context, email string, requestID *uuid.UUID) error {
	display, normalized, err := security.NormalizeEmail(strings.TrimSpace(email))
	if err != nil {
		return apperror.New(http.StatusUnprocessableEntity, "email_invalid", "The email address is invalid")
	}
	if s.notifier == nil {
		return mailUnavailable()
	}
	if !s.emailSends.Take(normalized, time.Now()) {
		return emailCodeRateLimited()
	}
	code, err := security.NewNumericCode()
	if err != nil {
		return err
	}
	digest := security.ChallengeDigest(s.config.ChallengeHMACKey, emailCodeDigestKind, enrollment.ID, code)
	expiresAt := time.Now().UTC().Add(EmailCodeTTL)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := visitordb.New(tx)
	locked, err := queries.GetEnrollmentContextForUpdate(ctx, enrollment.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.Unauthenticated
	}
	if err != nil {
		return err
	}
	if locked.EmailCodesSent >= EmailCodesPerContext {
		return emailCodeRateLimited()
	}
	taken, err := queries.LoginEmailTaken(ctx, normalized)
	if err != nil {
		return err
	}
	if taken {
		return errIdentifierExists()
	}
	if err := queries.SetEnrollmentEmailCode(ctx, visitordb.SetEnrollmentEmailCodeParams{
		ID: enrollment.ID, EmailDisplay: &display, EmailNormalized: &normalized,
		EmailCodeDigest: digest, EmailCodeExpiresAt: pgtype.Timestamptz{Time: expiresAt, Valid: true},
	}); err != nil {
		return err
	}
	if err := audit.Write(ctx, tx, audit.Event{
		Action: "visitor_enrollment.email_code_sent", ResourceType: "visitor_enrollment_context",
		ResourceID: &enrollment.ID, RequestID: requestID,
	}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	deliveryErr := s.notifier.SendEnrollmentEmailCode(ctx, display, code, expiresAt)
	if deliveryErr == nil {
		return nil
	}
	// Nobody received this code; withdraw it so the context does not wait for it.
	_ = visitordb.New(s.pool).ClearEnrollmentEmailCode(context.WithoutCancel(ctx), visitordb.ClearEnrollmentEmailCodeParams{
		ID: enrollment.ID, EmailCodeDigest: digest,
	})
	if errors.Is(deliveryErr, mailservice.ErrDisabled) {
		return mailUnavailable()
	}
	slog.WarnContext(ctx, "enrollment email code delivery failed", "enrollment_context_id", enrollment.ID.String())
	return apperror.New(
		http.StatusUnprocessableEntity,
		"email_delivery_failed",
		"The code could not be sent to this address; use another one",
	)
}

// ConfirmEmail verifies the context's address with the mailed code. Five wrong codes end it.
func (s *Service) ConfirmEmail(ctx context.Context, enrollment Context, code string, requestID *uuid.UUID) error {
	code = strings.TrimSpace(code)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := visitordb.New(tx)
	locked, err := queries.GetEnrollmentContextForUpdate(ctx, enrollment.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.Unauthenticated
	}
	if err != nil {
		return err
	}
	if locked.EmailCodeDigest == nil || !locked.EmailCodeExpiresAt.Valid ||
		!locked.EmailCodeExpiresAt.Time.After(time.Now().UTC()) || locked.EmailCodeAttempts >= emailCodeMaxAttempts {
		return emailCodeInvalid()
	}
	want := security.ChallengeDigest(s.config.ChallengeHMACKey, emailCodeDigestKind, enrollment.ID, code)
	if !security.IsNumericCode(code) || !hmac.Equal(want, locked.EmailCodeDigest) {
		if err := queries.RecordEnrollmentEmailCodeFailure(ctx, enrollment.ID); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return emailCodeInvalid()
	}
	if err := queries.VerifyEnrollmentEmail(ctx, enrollment.ID); err != nil {
		return err
	}
	if err := audit.Write(ctx, tx, audit.Event{
		Action: "visitor_enrollment.email_verified", ResourceType: "visitor_enrollment_context",
		ResourceID: &enrollment.ID, RequestID: requestID,
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func mailUnavailable() error {
	return apperror.New(http.StatusServiceUnavailable, "mail_unavailable", "Email delivery is unavailable")
}

func errIdentifierExists() error {
	return apperror.New(
		http.StatusConflict,
		"authentication_identifier_exists",
		"This email address already belongs to an Account; check in instead",
	)
}
