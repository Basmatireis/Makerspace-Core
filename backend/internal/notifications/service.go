package notifications

import (
	"context"
	"fmt"
	"strings"
	"time"

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

type Service struct {
	mail  MailService
	names ApplicationNameProvider
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

func NewService(mail MailService, names ...ApplicationNameProvider) *Service {
	service := &Service{mail: mail}
	if len(names) > 0 {
		service.names = names[0]
	}
	return service
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

func (s *Service) SendPasswordReset(ctx context.Context, to, code string, expiresAt time.Time) error {
	name := s.applicationName(ctx)
	return s.mail.Send(ctx, mailservice.Message{To: to, Subject: name + " password reset code", Text: fmt.Sprintf("Your %s password reset code is %s. It expires at %s. If you did not request this, ignore this message.\n\nOpen %s/reset-password", name, code, formatDateTime(expiresAt), s.mail.BaseURL(ctx))})
}

func (s *Service) SendInvitation(ctx context.Context, to, code string, expiresAt time.Time) error {
	name := s.applicationName(ctx)
	return s.mail.Send(ctx, mailservice.Message{To: to, Subject: "Your " + name + " invitation", Text: fmt.Sprintf("Your %s invitation code is %s. It expires at %s.\n\nOpen %s/complete-invitation", name, code, formatDateTime(expiresAt), s.mail.BaseURL(ctx))})
}

func (s *Service) SendPINEnrollment(ctx context.Context, to string, accountID uuid.UUID, code string, expiresAt time.Time) error {
	name := s.applicationName(ctx)
	return s.mail.Send(ctx, mailservice.Message{To: to, Subject: "Set up your " + name + " PIN login", Text: fmt.Sprintf("Your %s PIN setup code is %s. It expires at %s. Choose your own username and PIN at %s/complete-pin-setup?account=%s", name, code, formatDateTime(expiresAt), s.mail.BaseURL(ctx), accountID.String())})
}

func (s *Service) SendEmailVerification(ctx context.Context, to, code string, expiresAt time.Time) error {
	name := s.applicationName(ctx)
	return s.mail.Send(ctx, mailservice.Message{To: to, Subject: "Verify your " + name + " email", Text: fmt.Sprintf("Your %s email verification code is %s. It expires at %s.\n\nOpen %s/verify-email", name, code, formatDateTime(expiresAt), s.mail.BaseURL(ctx))})
}

func (s *Service) SendSecurityNotice(ctx context.Context, to, subject, text string) error {
	name := s.applicationName(ctx)
	return s.mail.Send(ctx, mailservice.Message{To: to, Subject: strings.ReplaceAll(subject, "Makerspace", name), Text: strings.ReplaceAll(text, "Makerspace", name)})
}
