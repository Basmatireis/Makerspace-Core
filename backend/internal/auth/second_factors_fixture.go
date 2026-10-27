package auth

import (
	"context"
	"errors"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	authdb "github.com/Basmatireis/Makerspace-Core/backend/internal/auth/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

// EnrollFixtureTOTP confirms an authenticator app with a caller-chosen secret for an account without a session. It
// exists only for the isolated browser-test bootstrap, which needs a deterministic secret, and refuses to run unless
// APP_ENV is "test". The secret is encrypted with the keyring exactly like a real enrollment, and the enrollment
// writes recovery codes, bumps the account version and records its audit event in one transaction.
func (s *Service) EnrollFixtureTOTP(ctx context.Context, accountID uuid.UUID, secret []byte) error {
	if s.config.Environment != "test" {
		return errors.New("fixture TOTP enrollment requires APP_ENV=test")
	}
	if s.keyring == nil {
		return apperror.Conflicting("encryption_unavailable", "Authenticator apps need an application encryption key")
	}
	ciphertext, err := s.keyring.Encrypt(secret, totpSecretPurpose+":"+accountID.String())
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := authdb.New(tx)
	credentialID := ids.New()
	if err := queries.ReplacePendingTOTPCredential(ctx, authdb.ReplacePendingTOTPCredentialParams{
		ID: credentialID, AccountID: accountID, SecretCiphertext: ciphertext,
	}); err != nil {
		return err
	}
	credential, err := queries.GetTOTPCredentialForUpdate(ctx, accountID)
	if err != nil {
		return err
	}
	// No used step is recorded, so the first code of the browser suite is accepted.
	if err := queries.ConfirmTOTPCredential(ctx, authdb.ConfirmTOTPCredentialParams{ID: credential.ID}); err != nil {
		return err
	}
	if _, err := s.replaceRecoveryCodes(ctx, queries, accountID); err != nil {
		return err
	}
	if err := queries.BumpAccountVersionAfterCredentialChange(ctx, accountID); err != nil {
		return err
	}
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &accountID, Action: "account.totp_enrolled", ResourceType: "account", ResourceID: &accountID,
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
