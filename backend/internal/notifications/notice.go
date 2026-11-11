package notifications

import (
	"context"
	"strings"
)

// SendNotice mails a system notification (printer events) with the branded layout: the title as heading and
// subject, the text, and a button to the application path link when the mail base URL is set. settingsLink is false
// for recipients who cannot sign in (an organization's contact address, a person without an account), whose mail
// then carries no notification settings link.
func (s *Service) SendNotice(ctx context.Context, to, subject, body, link string, settingsLink bool) error {
	content := Content{
		Heading: subject, Paragraphs: textParagraphs(body), OmitNotificationSettingsLink: !settingsLink,
	}
	if base := s.mail.BaseURL(ctx); base != "" && strings.HasPrefix(link, "/") && !strings.HasPrefix(link, "//") {
		content.Action = &Action{Label: "Open in " + s.applicationName(ctx), URL: base + link}
	}
	return s.SendBranded(ctx, to, s.applicationName(ctx)+": "+subject, content)
}
