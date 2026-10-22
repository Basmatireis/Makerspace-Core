package invoicing

import (
	"context"
	"errors"
	"log/slog"
	"regexp"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/branding"
	mailservice "github.com/Basmatireis/Makerspace-Core/backend/internal/mail"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifications"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DeliveryStatus is the outcome recorded on an invoice request.
type DeliveryStatus string

const (
	// DeliveryNotConfigured means sending was switched off or had no recipient when the request was forwarded.
	DeliveryNotConfigured DeliveryStatus = "not_configured"
	DeliverySent          DeliveryStatus = "sent"
	DeliveryFailed        DeliveryStatus = "failed"
)

// Failure codes are stored and shown instead of error texts, which may contain addresses.
const (
	FailureMailDisabled = "mail_disabled"
	FailureSendFailed   = "send_failed"
	FailureRenderFailed = "render_failed"
	FailureSettings     = "settings_unavailable"
)

// Outcome is the result of one delivery attempt.
type Outcome struct {
	Status      DeliveryStatus
	FailureCode string
}

// Notifier is the part of the notification service that the delivery needs; tests replace it.
type Notifier interface {
	SendBrandedCC(
		ctx context.Context,
		to string,
		cc []string,
		replyTo string,
		subject string,
		content notifications.Content,
		attachments ...mailservice.Attachment,
	) error
	RenderBranded(ctx context.Context, content notifications.Content) (text, htmlBody string)
	Branding(ctx context.Context) notifications.Branding
}

// MarkSource returns the brand shown at the top of the PDF.
type MarkSource interface {
	DocumentMark(ctx context.Context) branding.DocumentMark
}

// Service owns the wiRef delivery settings and sends the mail.
type Service struct {
	pool     *pgxpool.Pool
	notifier Notifier
	marks    MarkSource
}

// NewService returns the delivery service. marks may be nil; the PDF header then shows the application and
// organization names of the mail branding without a logo.
func NewService(pool *pgxpool.Pool, notifier Notifier, marks MarkSource) *Service {
	return &Service{pool: pool, notifier: notifier, marks: marks}
}

// Deliver renders and sends the document with the saved settings. It never returns an error: the caller records the
// outcome on the request. It must be called outside of any database transaction.
func (s *Service) Deliver(ctx context.Context, d Document) Outcome {
	settings, err := s.loadSettings(ctx)
	if err != nil {
		return failed(ctx, FailureSettings)
	}
	if !settings.ready() {
		return Outcome{Status: DeliveryNotConfigured}
	}
	return s.send(ctx, settings, d, "")
}

func (s *Service) send(ctx context.Context, settings Settings, d Document, subjectPrefix string) Outcome {
	subject, content := settings.MailContent(d)
	pdf, err := s.pdf(ctx, settings, d)
	if err != nil {
		return failed(ctx, FailureRenderFailed)
	}
	err = s.notifier.SendBrandedCC(
		ctx,
		settings.RecipientEmail,
		settings.CCEmails,
		settings.ReplyToEmail,
		subjectPrefix+subject,
		content,
		mailservice.Attachment{Name: pdfFilename(d.RequestNumber), ContentType: "application/pdf", Data: pdf},
	)
	switch {
	case err == nil:
		return Outcome{Status: DeliverySent}
	case errors.Is(err, mailservice.ErrDisabled):
		return failed(ctx, FailureMailDisabled)
	default:
		return failed(ctx, FailureSendFailed)
	}
}

// failed logs the code only: error texts of SMTP servers can contain recipient addresses.
func failed(ctx context.Context, code string) Outcome {
	slog.WarnContext(ctx, "wiref delivery failed", "code", code)
	return Outcome{Status: DeliveryFailed, FailureCode: code}
}

func (s *Service) pdf(ctx context.Context, settings Settings, d Document) ([]byte, error) {
	brand := s.notifier.Branding(ctx)
	mark := Mark{OrganizationName: brand.OrganizationName, DisplayName: brand.ApplicationName}
	if s.marks != nil {
		source := s.marks.DocumentMark(ctx)
		mark = Mark{OrganizationName: source.OrganizationName, DisplayName: source.DisplayName}
		switch source.LogoType {
		case "image/png":
			mark.Logo = &Logo{Data: source.Logo, Type: "PNG"}
		case "image/jpeg":
			mark.Logo = &Logo{Data: source.Logo, Type: "JPG"}
		}
	}
	return RenderPDF(brand, mark, settings, d)
}

var unsafeFilename = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func pdfFilename(requestNumber string) string {
	name := unsafeFilename.ReplaceAllString(requestNumber, "-")
	if name == "" {
		name = "request"
	}
	return "invoice-request-" + name + ".pdf"
}

// MailPreview is a rendered sample mail.
type MailPreview struct{ Subject, Text, HTML string }

// previewSettings combines unsaved templates with the saved recipient settings.
func (s *Service) previewSettings(
	ctx context.Context,
	p authorization.Principal,
	templates Templates,
) (Settings, error) {
	if !p.Has(authorization.InvoicingSettingsManage) {
		return Settings{}, apperror.PermissionDenied
	}
	if err := ValidateTemplates(templates); err != nil {
		return Settings{}, err
	}
	saved, err := s.loadSettings(ctx)
	if err != nil {
		return Settings{}, err
	}
	saved.Templates = templates
	return saved, nil
}

// PreviewMail renders the given, possibly unsaved templates with fictitious data. Nothing is sent.
func (s *Service) PreviewMail(
	ctx context.Context,
	p authorization.Principal,
	templates Templates,
) (MailPreview, error) {
	settings, err := s.previewSettings(ctx, p, templates)
	if err != nil {
		return MailPreview{}, err
	}
	subject, content := settings.MailContent(SampleDocument(time.Now()))
	text, htmlBody := s.notifier.RenderBranded(ctx, content)
	return MailPreview{Subject: subject, Text: text, HTML: htmlBody}, nil
}

// PreviewPDF renders the given, possibly unsaved templates with fictitious data.
func (s *Service) PreviewPDF(
	ctx context.Context,
	p authorization.Principal,
	templates Templates,
) ([]byte, error) {
	settings, err := s.previewSettings(ctx, p, templates)
	if err != nil {
		return nil, err
	}
	return s.pdf(ctx, settings, SampleDocument(time.Now()))
}

// SendTestMail sends the saved templates with fictitious data to the saved recipient. It works while sending is
// switched off, so the setup can be checked before the first real invoice.
func (s *Service) SendTestMail(ctx context.Context, p authorization.Principal) (Outcome, error) {
	if !p.Has(authorization.InvoicingSettingsManage) {
		return Outcome{}, apperror.PermissionDenied
	}
	settings, err := s.loadSettings(ctx)
	if err != nil {
		return Outcome{}, err
	}
	if settings.RecipientEmail == "" {
		return Outcome{}, invalidSettings("Save a wiRef address before sending a test mail")
	}
	return s.send(ctx, settings, SampleDocument(time.Now()), "[TEST] "), nil
}
