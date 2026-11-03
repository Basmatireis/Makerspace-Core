package notifications

import (
	"context"
	"strings"
)

// SendNotice mails a system notification (printer events) with the branded layout: the title as heading and
// subject, the text, and a button to the application path link when the mail base URL is set.
func (s *Service) SendNotice(ctx context.Context, to, subject, body, link string) error {
	content := Content{Heading: subject, Paragraphs: textParagraphs(body)}
	if base := s.mail.BaseURL(ctx); base != "" && strings.HasPrefix(link, "/") && !strings.HasPrefix(link, "//") {
		content.Action = &Action{Label: "Open in " + s.applicationName(ctx), URL: base + link}
	}
	return s.SendBranded(ctx, to, s.applicationName(ctx)+": "+subject, content)
}
