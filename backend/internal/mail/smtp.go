package mail

import (
	"bufio"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	netmail "net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"
)

type SMTPConfig struct {
	Host, TLSMode, Username, Password, FromAddress, FromName string
	Port                                                     int
}

type SMTPProvider struct{ config SMTPConfig }

func NewSMTPProvider(config SMTPConfig) (*SMTPProvider, error) {
	if config.Host == "" || config.Port < 1 || config.FromAddress == "" {
		return nil, fmt.Errorf("invalid SMTP configuration")
	}
	if config.TLSMode != "starttls" && config.TLSMode != "tls" && config.TLSMode != "none" {
		return nil, fmt.Errorf("invalid SMTP TLS mode")
	}
	return &SMTPProvider{config: config}, nil
}

func (p *SMTPProvider) Send(ctx context.Context, message Message) error {
	if _, err := netmail.ParseAddress(message.To); err != nil || hasHeaderBreak(message.Subject) {
		return fmt.Errorf("invalid mail message")
	}
	address := net.JoinHostPort(p.config.Host, strconv.Itoa(p.config.Port))
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	var connection net.Conn
	var err error
	if p.config.TLSMode == "tls" {
		connection, err = (&tls.Dialer{NetDialer: dialer, Config: &tls.Config{MinVersion: tls.VersionTLS12, ServerName: p.config.Host}}).DialContext(ctx, "tcp", address)
	} else {
		connection, err = dialer.DialContext(ctx, "tcp", address)
	}
	if err != nil {
		return fmt.Errorf("connect SMTP: %w", err)
	}
	defer connection.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = connection.SetDeadline(deadline)
	} else {
		_ = connection.SetDeadline(time.Now().Add(30 * time.Second))
	}
	client, err := smtp.NewClient(connection, p.config.Host)
	if err != nil {
		return fmt.Errorf("start SMTP: %w", err)
	}
	defer client.Close()
	if p.config.TLSMode == "starttls" {
		if ok, _ := client.Extension("STARTTLS"); !ok {
			return fmt.Errorf("SMTP server does not offer STARTTLS")
		}
		if err := client.StartTLS(&tls.Config{MinVersion: tls.VersionTLS12, ServerName: p.config.Host}); err != nil {
			return fmt.Errorf("start SMTP TLS: %w", err)
		}
	}
	if p.config.Username != "" {
		if err := client.Auth(smtp.PlainAuth("", p.config.Username, p.config.Password, p.config.Host)); err != nil {
			return fmt.Errorf("authenticate SMTP: %w", err)
		}
	}
	if err := client.Mail(p.config.FromAddress); err != nil {
		return fmt.Errorf("set SMTP sender: %w", err)
	}
	if err := client.Rcpt(message.To); err != nil {
		return fmt.Errorf("set SMTP recipient: %w", err)
	}
	w, err := client.Data()
	if err != nil {
		return fmt.Errorf("open SMTP body: %w", err)
	}
	if _, err = io.Copy(w, bufio.NewReader(strings.NewReader(p.render(message)))); err != nil {
		_ = w.Close()
		return fmt.Errorf("write SMTP body: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("finish SMTP body: %w", err)
	}
	return client.Quit()
}

func (p *SMTPProvider) render(message Message) string {
	from := (&netmail.Address{Name: p.config.FromName, Address: p.config.FromAddress}).String()
	to := (&netmail.Address{Address: message.To}).String()
	body := strings.ReplaceAll(strings.ReplaceAll(message.Text, "\r\n", "\n"), "\n", "\r\n")
	return "From: " + from + "\r\nTo: " + to + "\r\nSubject: " + message.Subject + "\r\n" +
		"MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n" + body + "\r\n"
}

func hasHeaderBreak(value string) bool { return strings.ContainsAny(value, "\r\n") }
