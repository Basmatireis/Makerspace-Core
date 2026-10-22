package mail

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"net/url"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	maildb "github.com/Basmatireis/Makerspace-Core/backend/internal/mail/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrDisabled = errors.New("mail delivery is disabled")

const passwordPurpose = "mail.smtp.password" //nolint:gosec // key-derivation purpose label, not a credential

// Message is one outgoing email. Text is always sent; HTML is optional and, when present, sent as
// the alternative representation. Attachments make the message multipart/mixed.
type Message struct {
	To, Subject, Text, HTML string
	// Cc recipients receive the same message; they appear in the Cc header.
	Cc []string
	// ReplyTo, when set, is where replies go instead of the sender address. It is not a recipient.
	ReplyTo     string
	Attachments []Attachment
}

// Attachment is a file delivered with a message.
type Attachment struct {
	Name        string
	ContentType string
	Data        []byte
}
type Provider interface {
	Send(context.Context, Message) error
}

type Configuration struct {
	Enabled, PasswordConfigured                              bool
	Provider, Host, Username, FromAddress, FromName, BaseURL string
	TLSMode                                                  TLSMode
	Port                                                     int
	Version                                                  int64
	UpdatedAt                                                time.Time
}
type ConfigurationInput struct {
	Enabled                                                  bool
	Host, Username, Password, FromAddress, FromName, BaseURL string
	// ClearPassword drops the stored SMTP password when no new one is given. The configuration import sets it when
	// the server or username changes, so a stored password is never sent to a server it was not entered for.
	ClearPassword   bool
	TLSMode         TLSMode
	Port            int
	ExpectedVersion int64
}
type Service struct {
	pool    *pgxpool.Pool
	keyring *security.Keyring
}

func NewService(pool *pgxpool.Pool, keys [][]byte) (*Service, error) {
	var keyring *security.Keyring
	if len(keys) > 0 {
		var err error
		keyring, err = security.NewKeyring(keys)
		if err != nil {
			return nil, err
		}
	}
	return &Service{pool: pool, keyring: keyring}, nil
}

// EncryptionAvailable reports whether application encryption keys are configured, which storing an SMTP password
// and enabling delivery require.
func (s *Service) EncryptionAvailable() bool { return s.keyring != nil }

func (s *Service) GetConfiguration(ctx context.Context, principal authorization.Principal) (Configuration, error) {
	if !principal.Has(authorization.MailManage) {
		return Configuration{}, apperror.PermissionDenied
	}
	row, err := maildb.New(s.pool).GetConfiguration(ctx)
	if err != nil {
		return Configuration{}, err
	}
	return configurationFromRow(row), nil
}

func (s *Service) UpdateConfiguration(
	ctx context.Context,
	principal authorization.Principal,
	input ConfigurationInput,
	requestID *uuid.UUID,
) (Configuration, error) {
	if !principal.Has(authorization.MailManage) {
		return Configuration{}, apperror.PermissionDenied
	}
	var result Configuration
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.UpdateConfigurationTx(ctx, tx, principal, input, requestID)
		return err
	})
	return result, err
}

// UpdateConfigurationTx is UpdateConfiguration inside the caller's transaction; the configuration import uses it.
func (s *Service) UpdateConfigurationTx(
	ctx context.Context,
	tx pgx.Tx,
	principal authorization.Principal,
	input ConfigurationInput,
	requestID *uuid.UUID,
) (Configuration, error) {
	if !principal.Has(authorization.MailManage) {
		return Configuration{}, apperror.PermissionDenied
	}
	input.Host, input.Username, input.FromAddress, input.FromName, input.BaseURL = strings.TrimSpace(
		input.Host,
	), strings.TrimSpace(
		input.Username,
	), strings.TrimSpace(
		input.FromAddress,
	), strings.TrimSpace(
		input.FromName,
	), strings.TrimSpace(
		input.BaseURL,
	)
	parsedBase, baseErr := url.Parse(input.BaseURL)
	parsedFrom, fromErr := mail.ParseAddress(input.FromAddress)
	if input.ExpectedVersion < 1 || input.Port < 1 || input.Port > 65535 ||
		!input.TLSMode.valid() ||
		(input.Enabled && (input.Host == "" || input.FromAddress == "" || input.BaseURL == "" || baseErr != nil || parsedBase.Host == "" || (parsedBase.Scheme != "http" && parsedBase.Scheme != "https") || parsedBase.Path != "" || parsedBase.RawQuery != "" || parsedBase.Fragment != "" || fromErr != nil || parsedFrom.Address != input.FromAddress)) {
		return Configuration{}, invalidConfiguration()
	}
	if input.Enabled && s.keyring == nil {
		return Configuration{}, apperror.New(
			http.StatusServiceUnavailable,
			"encryption_unavailable",
			"Application encryption keys are required before enabling mail",
		)
	}
	if input.Password != "" && s.keyring == nil {
		return Configuration{}, apperror.New(
			http.StatusServiceUnavailable,
			"encryption_unavailable",
			"Application encryption keys are required before storing an SMTP password",
		)
	}
	queries := maildb.New(tx)
	current, err := queries.GetConfigurationForUpdate(ctx)
	if err != nil {
		return Configuration{}, err
	}
	if current.Version != input.ExpectedVersion {
		return Configuration{}, apperror.StaleWrite
	}
	ciphertext := current.EncryptedSmtpPassword
	if input.ClearPassword {
		ciphertext = nil
	}
	if input.Password != "" {
		ciphertext, err = s.keyring.Encrypt([]byte(input.Password), passwordPurpose)
		if err != nil {
			return Configuration{}, err
		}
	}
	if input.Enabled && len(ciphertext) == 0 && input.Username != "" {
		return Configuration{}, apperror.New(
			http.StatusUnprocessableEntity,
			"smtp_password_required",
			"An SMTP password is required when a username is configured",
		)
	}
	actor := principal.AccountID
	row, err := queries.UpdateConfiguration(
		ctx,
		maildb.UpdateConfigurationParams{
			Enabled:               input.Enabled,
			SmtpHost:              input.Host,
			SmtpPort:              int32(input.Port),
			SmtpTlsMode:           string(input.TLSMode),
			SmtpUsername:          input.Username,
			EncryptedSmtpPassword: ciphertext,
			FromAddress:           input.FromAddress,
			FromName:              input.FromName,
			BaseUrl:               input.BaseURL,
			UpdatedByAccountID:    &actor,
			ExpectedVersion:       input.ExpectedVersion,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Configuration{}, apperror.StaleWrite
	}
	if err != nil {
		return Configuration{}, err
	}
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "mail.configuration_updated",
			ResourceType:   "mail_configuration",
			RequestID:      requestID,
			ChangedFields: []string{
				"enabled",
				"host",
				"port",
				"tlsMode",
				"username",
				"password",
				"fromAddress",
				"fromName",
				"baseUrl",
			},
		},
	); err != nil {
		return Configuration{}, err
	}
	return configurationFromRow(row), nil
}
func (s *Service) Send(ctx context.Context, message Message) error {
	row, err := maildb.New(s.pool).GetConfiguration(ctx)
	if err != nil {
		return err
	}
	if !row.Enabled {
		return ErrDisabled
	}
	if s.keyring == nil {
		return fmt.Errorf("mail encryption unavailable")
	}
	password := ""
	if len(row.EncryptedSmtpPassword) > 0 {
		plain, err := s.keyring.Decrypt(row.EncryptedSmtpPassword, passwordPurpose)
		if err != nil {
			return err
		}
		password = string(plain)
	}
	provider, err := NewSMTPProvider(
		SMTPConfig{
			Host:        row.SmtpHost,
			Port:        int(row.SmtpPort),
			TLSMode:     TLSMode(row.SmtpTlsMode),
			Username:    row.SmtpUsername,
			Password:    password,
			FromAddress: row.FromAddress,
			FromName:    row.FromName,
		},
	)
	if err != nil {
		return err
	}
	return provider.Send(ctx, message)
}
func (s *Service) BaseURL(ctx context.Context) string {
	row, err := maildb.New(s.pool).GetConfiguration(ctx)
	if err != nil {
		return ""
	}
	return strings.TrimSuffix(row.BaseUrl, "/")
}
func configurationFromRow(row maildb.MailConfiguration) Configuration {
	return Configuration{
		Enabled:            row.Enabled,
		PasswordConfigured: len(row.EncryptedSmtpPassword) > 0,
		Provider:           row.Provider,
		Host:               row.SmtpHost,
		Port:               int(row.SmtpPort),
		TLSMode:            TLSMode(row.SmtpTlsMode),
		Username:           row.SmtpUsername,
		FromAddress:        row.FromAddress,
		FromName:           row.FromName,
		BaseURL:            row.BaseUrl,
		Version:            row.Version,
		UpdatedAt:          row.UpdatedAt,
	}
}
func invalidConfiguration() error {
	return apperror.New(http.StatusUnprocessableEntity, "mail_configuration_invalid", "Mail configuration is invalid")
}
