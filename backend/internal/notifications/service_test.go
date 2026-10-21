package notifications

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/branding"
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
	if err := service.SendPasswordReset(
		context.Background(),
		"member@example.test",
		"ABC23456",
		time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC),
	); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(mail.message.Subject, "Open Workshop Portal") ||
		!strings.Contains(mail.message.Text, "Open Workshop Portal") {
		t.Fatalf("configured name missing from message: %#v", mail.message)
	}
	if strings.Contains(mail.message.Subject, "Makerspace") || strings.Contains(mail.message.Text, "Makerspace") {
		t.Fatalf("legacy organization name leaked into message: %#v", mail.message)
	}
	for _, body := range []string{mail.message.Text, mail.message.HTML} {
		link := "https://portal.example.test/reset-password#email=member%40example.test&amp;code=ABC23456"
		if body == mail.message.Text {
			link = "https://portal.example.test/reset-password#email=member%40example.test&code=ABC23456"
		}
		if !strings.Contains(body, link) || !strings.Contains(body, "ABC23456") {
			t.Fatalf("reset link with fragment or code missing: %s", body)
		}
		if strings.Contains(body, "reset-password?") {
			t.Fatalf("code must never be in the query string: %s", body)
		}
	}
	if mail.message.HTML == "" {
		t.Fatal("HTML part missing")
	}
	if !strings.Contains(mail.message.Text, "03.10.2026 14:00") {
		t.Fatalf("Vienna date and time format missing from message: %#v", mail.message)
	}
}

func TestSecurityNoticeReplacesLegacyMessageName(t *testing.T) {
	mail := &recordingMail{}
	service := NewService(mail, fixedName("Open Workshop Portal"))
	if err := service.SendSecurityNotice(
		context.Background(),
		"member@example.test",
		"Makerspace PIN configured",
		"Your Makerspace PIN changed.",
	); err != nil {
		t.Fatal(err)
	}
	if mail.message.Subject != "Open Workshop Portal PIN configured" ||
		!strings.Contains(mail.message.Text, "Your Open Workshop Portal PIN changed.") ||
		!strings.Contains(mail.message.HTML, "Your Open Workshop Portal PIN changed.") {
		t.Fatalf("unexpected security notice: %#v", mail.message)
	}
}

func TestGenericSMSProviderAbstraction(t *testing.T) {
	mail := &recordingMail{}
	sms := &recordingSMS{}
	service := NewService(mail, nil).WithSMSProvider(sms)
	if err := service.Send(
		context.Background(),
		Notification{Channel: ChannelSMS, Recipient: "+4312345", Text: "Workshop update"},
	); err != nil {
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
	if err := service.SendSurveyInvitation(
		context.Background(),
		"visitor@example.test",
		"Visit feedback",
		"opaque-token",
		expiresAt,
	); err != nil {
		t.Fatal(err)
	}
	if mail.message.To != "visitor@example.test" || mail.message.Subject != "Open Workshop Portal: Visit feedback" {
		t.Fatalf("unexpected survey message metadata: %#v", mail.message)
	}
	for _, expected := range []string{
		"https://portal.example.test/survey/opaque-token",
		"stored separately from this delivery record",
	} {
		if !strings.Contains(mail.message.Text, expected) {
			t.Fatalf("survey message missing %q: %#v", expected, mail.message)
		}
	}
}

type brandedNames struct{ fixedName }

func (brandedNames) EmailIdentity(context.Context) branding.EmailIdentity {
	return branding.EmailIdentity{
		ApplicationName: "Open Workshop Portal", OrganizationName: "Workshop Club", PrimaryColor: "#8a3ffc",
		LogoPath: "/api/v1/public/branding/assets/logo/abc", ImprintURL: "/legal/imprint", ImprintInternal: true,
		PrivacyURL: "https://example.test/privacy",
	}
}

func TestBrandedMessagesUseBrandingConfiguration(t *testing.T) {
	mail := &recordingMail{}
	service := NewService(mail, brandedNames{fixedName("Open Workshop Portal")})
	if err := service.SendEmailVerification(context.Background(), "m@example.test", "ABC23456", time.Now()); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		`src="https://portal.example.test/api/v1/public/branding/assets/logo/abc"`,
		"#8a3ffc", "Workshop Club", `href="https://portal.example.test/legal/imprint"`, `href="https://example.test/privacy"`,
		"https://portal.example.test/verify-email#email=m%40example.test&amp;code=ABC23456",
	} {
		if !strings.Contains(mail.message.HTML, expected) {
			t.Fatalf("HTML missing %q: %s", expected, mail.message.HTML)
		}
	}
	if !strings.Contains(mail.message.Text, "Imprint: https://portal.example.test/legal/imprint") {
		t.Fatalf("text footer missing legal link: %s", mail.message.Text)
	}
}
