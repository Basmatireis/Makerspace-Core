package invoicing

import (
	"context"
	"errors"
	"net/http"
	"net/mail"
	"strings"
	"time"
	"unicode"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	invoicingdb "github.com/Basmatireis/Makerspace-Core/backend/internal/invoicing/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Limits shared with the database constraints and the OpenAPI schema.
const (
	MaxCC          = 5
	MaxSubject     = 200
	MaxText        = 2000
	maxAddressSize = 254
)

// Templates are the texts and field toggles that shape the mail and the PDF.
type Templates struct {
	MailSubject, MailIntro, MailClosing string
	PDFTitle, PDFIntro, PDFClosing      string

	ShowContactPerson, ShowApprover, ShowPurchaseOrder, ShowServicePeriod, ShowServiceDescription bool
}

// Settings is the installation-wide wiRef delivery configuration.
type Settings struct {
	Templates
	Enabled        bool
	RecipientEmail string
	CCEmails       []string
	Version        int64
	UpdatedAt      time.Time
}

// SettingsInput replaces the settings. ExpectedVersion is the optimistic-concurrency token.
type SettingsInput struct {
	Templates
	Enabled         bool
	RecipientEmail  string
	CCEmails        []string
	ExpectedVersion int64
}

// ready reports whether forwarded requests are mailed at all.
func (s Settings) ready() bool { return s.Enabled && s.RecipientEmail != "" }

func settingsFromRow(row invoicingdb.WirefDeliverySetting) Settings {
	return Settings{
		Templates: Templates{
			MailSubject:            row.MailSubject,
			MailIntro:              row.MailIntro,
			MailClosing:            row.MailClosing,
			PDFTitle:               row.PdfTitle,
			PDFIntro:               row.PdfIntro,
			PDFClosing:             row.PdfClosing,
			ShowContactPerson:      row.ShowContactPerson,
			ShowApprover:           row.ShowApprover,
			ShowPurchaseOrder:      row.ShowPurchaseOrder,
			ShowServicePeriod:      row.ShowServicePeriod,
			ShowServiceDescription: row.ShowServiceDescription,
		},
		Enabled:        row.Enabled,
		RecipientEmail: row.RecipientEmail,
		CCEmails:       row.CcEmails,
		Version:        row.Version,
		UpdatedAt:      row.UpdatedAt,
	}
}

func (s *Service) loadSettings(ctx context.Context) (Settings, error) {
	row, err := invoicingdb.New(s.pool).GetSettings(ctx)
	if err != nil {
		return Settings{}, err
	}
	return settingsFromRow(row), nil
}

// GetSettings returns the configuration for administrators.
func (s *Service) GetSettings(ctx context.Context, p authorization.Principal) (Settings, error) {
	if !p.Has(authorization.InvoicingSettingsManage) {
		return Settings{}, apperror.PermissionDenied
	}
	return s.loadSettings(ctx)
}

// ValidateTemplates checks lengths and placeholders. It is also used by the preview, which accepts unsaved text.
func ValidateTemplates(t Templates) error {
	if strings.TrimSpace(t.MailSubject) == "" || strings.TrimSpace(t.PDFTitle) == "" {
		return invalidSettings("Mail subject and PDF title are required")
	}
	if len([]rune(t.MailSubject)) > MaxSubject || len([]rune(t.PDFTitle)) > MaxSubject {
		return invalidSettings("Mail subject and PDF title are limited to 200 characters")
	}
	for _, text := range []string{t.MailIntro, t.MailClosing, t.PDFIntro, t.PDFClosing} {
		if len([]rune(text)) > MaxText {
			return invalidSettings("Texts are limited to 2000 characters")
		}
	}
	for _, text := range []string{t.MailSubject, t.MailIntro, t.MailClosing, t.PDFTitle, t.PDFIntro, t.PDFClosing} {
		if err := ValidateTemplate(text); err != nil {
			return err
		}
	}
	return nil
}

// parseAddress accepts a bare address only: no display name, no list, no header breaks.
func parseAddress(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > maxAddressSize || strings.ContainsFunc(value, unicode.IsSpace) {
		return "", false
	}
	parsed, err := mail.ParseAddress(value)
	if err != nil || parsed.Address != value || !strings.Contains(parsed.Address[strings.LastIndex(parsed.Address, "@"):], ".") {
		return "", false
	}
	return value, true
}

func normalizeRecipients(input SettingsInput) (string, []string, error) {
	recipient := strings.TrimSpace(input.RecipientEmail)
	if recipient != "" {
		if _, ok := parseAddress(recipient); !ok {
			return "", nil, invalidSettings("The wiRef address is not a valid email address")
		}
	}
	if input.Enabled && recipient == "" {
		return "", nil, invalidSettings("A wiRef address is required to enable sending")
	}
	if len(input.CCEmails) > MaxCC {
		return "", nil, invalidSettings("At most 5 CC addresses are allowed")
	}
	seen := map[string]struct{}{strings.ToLower(recipient): {}}
	cc := []string{}
	for _, value := range input.CCEmails {
		address, ok := parseAddress(value)
		if !ok {
			return "", nil, invalidSettings("A CC address is not a valid email address")
		}
		key := strings.ToLower(address)
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		cc = append(cc, address)
	}
	return recipient, cc, nil
}

// UpdateSettings replaces the configuration and records the change in the audit log in the same transaction.
func (s *Service) UpdateSettings(
	ctx context.Context,
	p authorization.Principal,
	input SettingsInput,
	requestID *uuid.UUID,
) (Settings, error) {
	if !p.Has(authorization.InvoicingSettingsManage) {
		return Settings{}, apperror.PermissionDenied
	}
	if input.ExpectedVersion < 1 {
		return Settings{}, invalidSettings("The settings version is required")
	}
	if err := ValidateTemplates(input.Templates); err != nil {
		return Settings{}, err
	}
	recipient, cc, err := normalizeRecipients(input)
	if err != nil {
		return Settings{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Settings{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := invoicingdb.New(tx)
	current, err := q.GetSettingsForUpdate(ctx)
	if err != nil {
		return Settings{}, err
	}
	if current.Version != input.ExpectedVersion {
		return Settings{}, apperror.StaleWrite
	}
	actor := p.AccountID
	row, err := q.UpdateSettings(ctx, invoicingdb.UpdateSettingsParams{
		Enabled:                input.Enabled,
		RecipientEmail:         recipient,
		CcEmails:               cc,
		MailSubject:            strings.TrimSpace(input.MailSubject),
		MailIntro:              strings.TrimSpace(input.MailIntro),
		MailClosing:            strings.TrimSpace(input.MailClosing),
		PdfTitle:               strings.TrimSpace(input.PDFTitle),
		PdfIntro:               strings.TrimSpace(input.PDFIntro),
		PdfClosing:             strings.TrimSpace(input.PDFClosing),
		ShowContactPerson:      input.ShowContactPerson,
		ShowApprover:           input.ShowApprover,
		ShowPurchaseOrder:      input.ShowPurchaseOrder,
		ShowServicePeriod:      input.ShowServicePeriod,
		ShowServiceDescription: input.ShowServiceDescription,
		UpdatedByAccountID:     &actor,
		ExpectedVersion:        input.ExpectedVersion,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Settings{}, apperror.StaleWrite
	}
	if err != nil {
		return Settings{}, err
	}
	if err = audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor,
		Action:         "invoicing.wiref_settings_updated",
		ResourceType:   "wiref_delivery_settings",
		RequestID:      requestID,
		ChangedFields: []string{
			"enabled", "recipientEmail", "ccEmails", "mailSubject", "mailIntro", "mailClosing",
			"pdfTitle", "pdfIntro", "pdfClosing", "fieldToggles",
		},
	}); err != nil {
		return Settings{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Settings{}, err
	}
	return settingsFromRow(row), nil
}

func invalidSettings(message string) error {
	return apperror.New(http.StatusUnprocessableEntity, "wiref_settings_invalid", message)
}
