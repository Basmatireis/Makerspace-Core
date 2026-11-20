package invoicing

import (
	"context"
	"errors"

	mailservice "github.com/Basmatireis/Makerspace-Core/backend/internal/mail"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifications"
)

// SendMessage mails a branded message with attachments to the wiRef address of the settings (with their cc and
// Reply-To addresses). Other features that talk to the wiRef, such as the Projektantrag of a working group project,
// use it; the outcome tells whether the message left.
func (s *Service) SendMessage(ctx context.Context, subject string, paragraphs []string, attachments []mailservice.Attachment) Outcome {
	settings, err := s.loadSettings(ctx)
	if err != nil {
		return failed(ctx, FailureSettings)
	}
	if !settings.ready() {
		return Outcome{Status: DeliveryNotConfigured}
	}
	content := notifications.Content{Heading: subject, Paragraphs: paragraphs, OmitNotificationSettingsLink: true}
	err = s.notifier.SendBrandedCC(ctx, settings.RecipientEmail, settings.CCEmails, settings.ReplyToEmail, subject, content, attachments...)
	switch {
	case err == nil:
		return Outcome{Status: DeliverySent}
	case errors.Is(err, mailservice.ErrDisabled):
		return failed(ctx, FailureMailDisabled)
	default:
		return failed(ctx, FailureSendFailed)
	}
}
