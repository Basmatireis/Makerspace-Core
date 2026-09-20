package notifications

import (
	"context"
	"fmt"
	"time"

	mailservice "github.com/Basmatireis/Makerspace-Core/backend/internal/mail"
	"github.com/google/uuid"
)

type MailService interface {
	Send(context.Context, mailservice.Message) error
	BaseURL(context.Context) string
}

type Service struct{ mail MailService }

func NewService(mail MailService) *Service { return &Service{mail: mail} }

func (s *Service) SendPasswordReset(ctx context.Context, to, code string, expiresAt time.Time) error {
	return s.mail.Send(ctx, mailservice.Message{To: to, Subject: "Makerspace password reset code", Text: fmt.Sprintf("Your password reset code is %s. It expires at %s. If you did not request this, ignore this message.\n\nOpen %s/reset-password", code, expiresAt.UTC().Format(time.RFC3339), s.mail.BaseURL(ctx))})
}

func (s *Service) SendInvitation(ctx context.Context, to, code string, expiresAt time.Time) error {
	return s.mail.Send(ctx, mailservice.Message{To: to, Subject: "Your Makerspace invitation", Text: fmt.Sprintf("Your invitation code is %s. It expires at %s.\n\nOpen %s/complete-invitation", code, expiresAt.UTC().Format(time.RFC3339), s.mail.BaseURL(ctx))})
}

func (s *Service) SendPINEnrollment(ctx context.Context, to string, accountID uuid.UUID, code string, expiresAt time.Time) error {
	return s.mail.Send(ctx, mailservice.Message{To: to, Subject: "Set up your Makerspace PIN login", Text: fmt.Sprintf("Your PIN setup code is %s. It expires at %s. Choose your own username and PIN at %s/complete-pin-setup?account=%s", code, expiresAt.UTC().Format(time.RFC3339), s.mail.BaseURL(ctx), accountID.String())})
}

func (s *Service) SendEmailVerification(ctx context.Context, to, code string, expiresAt time.Time) error {
	return s.mail.Send(ctx, mailservice.Message{To: to, Subject: "Verify your Makerspace email", Text: fmt.Sprintf("Your email verification code is %s. It expires at %s.\n\nOpen %s/verify-email", code, expiresAt.UTC().Format(time.RFC3339), s.mail.BaseURL(ctx))})
}

func (s *Service) SendSecurityNotice(ctx context.Context, to, subject, text string) error {
	return s.mail.Send(ctx, mailservice.Message{To: to, Subject: subject, Text: text})
}
