package notifications

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/branding"
	mailservice "github.com/Basmatireis/Makerspace-Core/backend/internal/mail"
	"github.com/google/uuid"
)

type MailService interface {
	Send(context.Context, mailservice.Message) error
	BaseURL(context.Context) string
}

type ApplicationNameProvider interface {
	ApplicationName(context.Context) string
}

// EmailIdentityProvider is optionally implemented by the ApplicationNameProvider. When present, the
// branded layout shows the logo, brand colour, organization and legal links.
type EmailIdentityProvider interface {
	EmailIdentity(context.Context) branding.EmailIdentity
}

type Channel string

const (
	ChannelEmail Channel = "email"
	ChannelSMS   Channel = "sms"
)

type Notification struct {
	Channel   Channel
	Recipient string
	Subject   string
	Text      string
}

// SMSProvider is intentionally transport-only. A future tablet relay implements
// this interface and never receives browser credentials or domain permissions.
type SMSProvider interface {
	SendSMS(context.Context, string, string) error
}

type Service struct {
	mail  MailService
	names ApplicationNameProvider
	sms   SMSProvider
}

func (s *Service) WithSMSProvider(provider SMSProvider) *Service { s.sms = provider; return s }

func (s *Service) Send(ctx context.Context, notification Notification) error {
	switch notification.Channel {
	case ChannelEmail:
		return s.SendBranded(
			ctx,
			notification.Recipient,
			notification.Subject,
			Content{Heading: notification.Subject, Paragraphs: textParagraphs(notification.Text)},
		)
	case ChannelSMS:
		if s.sms == nil {
			return fmt.Errorf("sms provider is not configured")
		}
		return s.sms.SendSMS(ctx, notification.Recipient, notification.Text)
	default:
		return fmt.Errorf("unsupported notification channel")
	}
}

func (s *Service) SendSurveyInvitation(ctx context.Context, to, title, token string, expiresAt time.Time) error {
	name := s.applicationName(ctx)
	return s.SendBranded(ctx, to, name+": "+title, Content{
		Heading:    title,
		Paragraphs: []string{"We would value your feedback."},
		Action:     &Action{Label: "Open the survey", URL: s.mail.BaseURL(ctx) + "/survey/" + token},
		Footnote: fmt.Sprintf(
			"Please respond before %s. The response is stored separately from this delivery record when the survey is anonymous.",
			formatDateTime(expiresAt),
		),
	})
}

var viennaLocation = func() *time.Location {
	location, err := time.LoadLocation("Europe/Vienna")
	if err != nil {
		return time.FixedZone("Europe/Vienna", 60*60)
	}
	return location
}()

func formatDateTime(value time.Time) string {
	return value.In(viennaLocation).Format("02.01.2006 15:04")
}

// NewService returns the notification service. names may be nil; messages then use the
// default application name.
func NewService(mail MailService, names ApplicationNameProvider) *Service {
	return &Service{mail: mail, names: names}
}

func (s *Service) applicationName(ctx context.Context) string {
	if s.names == nil {
		return "Makerspace"
	}
	name := s.names.ApplicationName(ctx)
	if name == "" {
		return "Makerspace"
	}
	return name
}

// branding resolves the layout branding. Public asset and legal paths are made absolute with the
// mail base URL; without a base URL, links that need one are dropped.
func (s *Service) branding(ctx context.Context) Branding {
	result := Branding{ApplicationName: s.applicationName(ctx)}
	provider, ok := s.names.(EmailIdentityProvider)
	if !ok {
		return result
	}
	identity := provider.EmailIdentity(ctx)
	base := s.mail.BaseURL(ctx)
	absolute := func(link string, internal bool) string {
		if link == "" {
			return ""
		}
		if internal {
			if base == "" {
				return ""
			}
			return base + link
		}
		return link
	}
	result.OrganizationName = identity.OrganizationName
	result.PrimaryColor = identity.PrimaryColor
	if identity.LogoPath != "" {
		result.LogoURL = absolute(identity.LogoPath, strings.HasPrefix(identity.LogoPath, "/"))
	}
	result.ImprintURL = absolute(identity.ImprintURL, identity.ImprintInternal)
	result.PrivacyURL = absolute(identity.PrivacyURL, identity.PrivacyInternal)
	return result
}

// RenderBranded renders content with the configured branding into plain-text and HTML parts.
func (s *Service) RenderBranded(ctx context.Context, content Content) (text, htmlBody string) {
	return RenderBranded(s.branding(ctx), content)
}

// Branding returns the layout branding that SendBranded applies, for documents rendered alongside a mail.
func (s *Service) Branding(ctx context.Context) Branding {
	return sanitizeBranding(s.branding(ctx))
}

// SendBranded sends a branded multipart email, optionally with attachments.
func (s *Service) SendBranded(
	ctx context.Context,
	to, subject string,
	content Content,
	attachments ...mailservice.Attachment,
) error {
	return s.SendBrandedCC(ctx, to, nil, "", subject, content, attachments...)
}

// SendBrandedCC is SendBranded with carbon-copy recipients and an optional Reply-To address.
func (s *Service) SendBrandedCC(
	ctx context.Context,
	to string,
	cc []string,
	replyTo string,
	subject string,
	content Content,
	attachments ...mailservice.Attachment,
) error {
	text, htmlBody := s.RenderBranded(ctx, content)
	return s.mail.Send(
		ctx,
		mailservice.Message{
			To: to, Cc: cc, ReplyTo: replyTo, Subject: subject, Text: text, HTML: htmlBody, Attachments: attachments,
		},
	)
}

// fragmentLink builds a landing-page link that carries the email address and one-time code in the
// URL fragment. Fragments are not sent to servers, so the code stays out of access logs.
func (s *Service) fragmentLink(ctx context.Context, path, email, code string) string {
	return s.mail.BaseURL(ctx) + path + "#email=" + url.QueryEscape(email) + "&code=" + url.QueryEscape(code)
}

func (s *Service) SendPasswordReset(ctx context.Context, to, code string, expiresAt time.Time) error {
	name := s.applicationName(ctx)
	return s.SendBranded(ctx, to, name+" password reset code", Content{
		Heading: "Reset your password",
		Paragraphs: []string{
			fmt.Sprintf("We received a request to reset the password of your %s account.", name),
			"Select the button to choose a new password. If the button does not fill in the code for you, enter the code below on the reset page.",
		},
		Action: &Action{Label: "Choose a new password", URL: s.fragmentLink(ctx, "/reset-password", to, code)},
		Code:   code,
		Footnote: fmt.Sprintf(
			"The code expires at %s. If you did not request this, ignore this message.",
			formatDateTime(expiresAt),
		),
	})
}

func (s *Service) SendInvitation(ctx context.Context, to, code string, expiresAt time.Time) error {
	name := s.applicationName(ctx)
	return s.SendBranded(ctx, to, "Your "+name+" invitation", Content{
		Heading: "You are invited to " + name,
		Paragraphs: []string{
			"Select the button to choose your password and finish setting up your account. If the code is not filled in for you, enter the code below.",
		},
		Action:   &Action{Label: "Accept invitation", URL: s.fragmentLink(ctx, "/complete-invitation", to, code)},
		Code:     code,
		Footnote: fmt.Sprintf("The invitation code expires at %s.", formatDateTime(expiresAt)),
	})
}

func (s *Service) SendPINEnrollment(
	ctx context.Context,
	to string,
	accountID uuid.UUID,
	code string,
	expiresAt time.Time,
) error {
	name := s.applicationName(ctx)
	link := s.mail.BaseURL(ctx) + "/complete-pin-setup?account=" + url.QueryEscape(accountID.String()) +
		"#code=" + url.QueryEscape(code)
	return s.SendBranded(ctx, to, "Set up your "+name+" PIN login", Content{
		Heading: "Set up your PIN login",
		Paragraphs: []string{
			"Choose your own username and PIN. If the code is not filled in for you, enter the code below.",
		},
		Action:   &Action{Label: "Set up PIN login", URL: link},
		Code:     code,
		Footnote: fmt.Sprintf("The setup code expires at %s.", formatDateTime(expiresAt)),
	})
}

func (s *Service) SendEmailVerification(ctx context.Context, to, code string, expiresAt time.Time) error {
	name := s.applicationName(ctx)
	return s.SendBranded(ctx, to, "Verify your "+name+" email", Content{
		Heading:    "Verify your email address",
		Paragraphs: []string{"Select the button to verify your login email. If the code is not filled in for you, enter the code below."},
		Action:     &Action{Label: "Verify email", URL: s.fragmentLink(ctx, "/verify-email", to, code)},
		Code:       code,
		Footnote:   fmt.Sprintf("The code expires at %s.", formatDateTime(expiresAt)),
	})
}

// SendSecurityNotice sends a security notification. Text paragraphs are separated by blank lines.
func (s *Service) SendSecurityNotice(ctx context.Context, to, subject, text string) error {
	name := s.applicationName(ctx)
	subject = strings.ReplaceAll(subject, "Makerspace", name)
	text = strings.ReplaceAll(text, "Makerspace", name)
	return s.SendBranded(ctx, to, subject, Content{Heading: subject, Paragraphs: textParagraphs(text)})
}

func textParagraphs(text string) []string {
	var paragraphs []string
	for _, paragraph := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n\n") {
		if paragraph = strings.TrimSpace(paragraph); paragraph != "" {
			paragraphs = append(paragraphs, paragraph)
		}
	}
	return paragraphs
}
