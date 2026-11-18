package invoicing

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	mailservice "github.com/Basmatireis/Makerspace-Core/backend/internal/mail"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifications"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/engine"
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
}

// Service owns the wiRef delivery settings and sends the mail.
type Service struct {
	pool     *pgxpool.Pool
	notifier Notifier
	pdf      PDFRenderer
}

// NewService returns the delivery service. Until WithPDFTemplates is called the PDF is rendered with the built-in
// default template, without logo.
func NewService(pool *pgxpool.Pool, notifier Notifier) *Service {
	return &Service{pool: pool, notifier: notifier, pdf: pdftemplates.BuiltinRenderer{}}
}

// WithPDFTemplates makes the PDF follow the published wiRef template and show the branding logo.
func (s *Service) WithPDFTemplates(renderer PDFRenderer) *Service {
	s.pdf = renderer
	return s
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
	pdf, filename, err := s.render(ctx, settings, d)
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
		mailservice.Attachment{Name: filename, ContentType: "application/pdf", Data: pdf},
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

// render draws the document with the effective wiRef template. The rendering carries no sensitive fields, so it
// needs no reader permissions.
func (s *Service) render(ctx context.Context, settings Settings, d Document) (pdf []byte, filename string, err error) {
	return s.pdf.RenderEffective(ctx, engine.KindWiRef, d.PDFData(settings), nil)
}

// PDFData is the wiRef template data of a document with the saved settings; the PDF template previews use it for
// real invoice requests.
func (s *Service) PDFData(ctx context.Context, d Document) (engine.Data, error) {
	settings, err := s.loadSettings(ctx)
	if err != nil {
		return nil, err
	}
	return d.PDFData(settings), nil
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
	pdf, _, err := s.render(ctx, settings, SampleDocument(time.Now()))
	return pdf, err
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
