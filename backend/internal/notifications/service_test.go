package notifications

import (
	"context"
	"strings"
	"testing"
	"time"

	mailservice "github.com/Basmatireis/Makerspace-Core/backend/internal/mail"
)

type recordingMail struct{ message mailservice.Message }

func (mail *recordingMail) Send(_ context.Context, message mailservice.Message) error {
	mail.message = message
	return nil
}
func (mail *recordingMail) BaseURL(context.Context) string { return "https://portal.example.test" }

type fixedName string

func (name fixedName) ApplicationName(context.Context) string { return string(name) }

type recordingSMS struct {
	recipient string
	text      string
}

func (sms *recordingSMS) SendSMS(_ context.Context, recipient, text string) error {
	sms.recipient = recipient
	sms.text = text
	return nil
}

func TestTransactionalMessagesUseConfiguredApplicationName(t *testing.T) {
	mail := &recordingMail{}
	service := NewService(mail, fixedName("Open Workshop Portal"))
	if err := service.SendPasswordReset(context.Background(), "member@example.test", "ABC23456", time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(mail.message.Subject, "Open Workshop Portal") || !strings.Contains(mail.message.Text, "Open Workshop Portal") {
		t.Fatalf("configured name missing from message: %#v", mail.message)
	}
	if strings.Contains(mail.message.Subject, "Makerspace") || strings.Contains(mail.message.Text, "Makerspace") {
		t.Fatalf("legacy organization name leaked into message: %#v", mail.message)
	}
	if !strings.Contains(mail.message.Text, "03.10.2026 14:00") {
		t.Fatalf("Vienna date and time format missing from message: %#v", mail.message)
	}
}

func TestSecurityNoticeReplacesLegacyMessageName(t *testing.T) {
	mail := &recordingMail{}
	service := NewService(mail, fixedName("Open Workshop Portal"))
	if err := service.SendSecurityNotice(context.Background(), "member@example.test", "Makerspace PIN configured", "Your Makerspace PIN changed."); err != nil {
		t.Fatal(err)
	}
	if mail.message.Subject != "Open Workshop Portal PIN configured" || mail.message.Text != "Your Open Workshop Portal PIN changed." {
		t.Fatalf("unexpected security notice: %#v", mail.message)
	}
}

func TestGenericSMSProviderAbstraction(t *testing.T) {
	mail := &recordingMail{}
	sms := &recordingSMS{}
	service := NewService(mail).WithSMSProvider(sms)
	if err := service.Send(context.Background(), Notification{Channel: ChannelSMS, Recipient: "+4312345", Text: "Workshop update"}); err != nil {
		t.Fatal(err)
	}
	if sms.recipient != "+4312345" || sms.text != "Workshop update" {
		t.Fatalf("unexpected SMS delivery: %#v", sms)
	}
	if mail.message.To != "" {
		t.Fatalf("SMS was incorrectly sent through mail: %#v", mail.message)
	}
}

func TestSurveyInvitationUsesPublicLinkAndPrivacyCopy(t *testing.T) {
	mail := &recordingMail{}
	service := NewService(mail, fixedName("Open Workshop Portal"))
	expiresAt := time.Date(2026, 10, 20, 18, 0, 0, 0, time.UTC)
	if err := service.SendSurveyInvitation(context.Background(), "visitor@example.test", "Visit feedback", "opaque-token", expiresAt); err != nil {
		t.Fatal(err)
	}
	if mail.message.To != "visitor@example.test" || mail.message.Subject != "Open Workshop Portal: Visit feedback" {
		t.Fatalf("unexpected survey message metadata: %#v", mail.message)
	}
	for _, expected := range []string{"https://portal.example.test/survey/opaque-token", "stored separately from this delivery record"} {
		if !strings.Contains(mail.message.Text, expected) {
			t.Fatalf("survey message missing %q: %#v", expected, mail.message)
		}
	}
}
