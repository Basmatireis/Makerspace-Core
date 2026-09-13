package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	DatabaseURL         string
	HTTPAddr            string
	Environment         string
	PublicBaseURL       *url.URL
	SessionCookieName   string
	CSRFCookieName      string
	SessionCookieSecure bool
	SessionIdleTTL      time.Duration
	SessionAbsoluteTTL  time.Duration
	PasswordResetTTL    time.Duration
	AuditRetention      time.Duration
	ShutdownTimeout     time.Duration
}

func Load() (Config, error) {
	environment := envOr("APP_ENV", "development")
	if environment != "development" && environment != "production" && environment != "test" {
		return Config{}, fmt.Errorf("APP_ENV must be development, production, or test")
	}

	base, err := url.Parse(envOr("PUBLIC_BASE_URL", "http://localhost:5173"))
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" || base.Path != "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return Config{}, errors.New("PUBLIC_BASE_URL must be an HTTP(S) origin without credentials, path, query, or fragment")
	}
	if environment == "production" && base.Scheme != "https" {
		return Config{}, errors.New("PUBLIC_BASE_URL must use HTTPS in production")
	}

	secure, err := strconv.ParseBool(envOr("SESSION_COOKIE_SECURE", strconv.FormatBool(environment == "production")))
	if err != nil {
		return Config{}, fmt.Errorf("parse SESSION_COOKIE_SECURE: %w", err)
	}
	if environment == "production" && !secure {
		return Config{}, errors.New("SESSION_COOKIE_SECURE must be true in production")
	}

	idle, err := durationEnv("SESSION_IDLE_TTL", 6*time.Hour)
	if err != nil {
		return Config{}, err
	}
	auditRetention, err := durationEnv("AUDIT_RETENTION", 365*24*time.Hour)
	if err != nil {
		return Config{}, err
	}
	if auditRetention < 0 {
		return Config{}, errors.New("AUDIT_RETENTION cannot be negative")
	}
	absolute, err := durationEnv("SESSION_ABSOLUTE_TTL", 72*time.Hour)
	if err != nil {
		return Config{}, err
	}
	if idle <= 0 || absolute <= 0 || idle > absolute {
		return Config{}, errors.New("session TTLs must be positive and idle must not exceed absolute")
	}
	resetTTL, err := durationEnv("PASSWORD_RESET_TTL", 30*time.Minute)
	if err != nil {
		return Config{}, err
	}
	if resetTTL <= 0 {
		return Config{}, errors.New("PASSWORD_RESET_TTL must be positive")
	}

	sessionName := "makerspace_session"
	csrfName := "makerspace_csrf"
	if secure {
		sessionName = "__Host-makerspace_session"
		csrfName = "__Host-makerspace_csrf"
	}

	return Config{
		DatabaseURL:         strings.TrimSpace(os.Getenv("DATABASE_URL")),
		HTTPAddr:            envOr("HTTP_ADDR", ":8080"),
		Environment:         environment,
		PublicBaseURL:       base,
		SessionCookieName:   sessionName,
		CSRFCookieName:      csrfName,
		SessionCookieSecure: secure,
		SessionIdleTTL:      idle,
		SessionAbsoluteTTL:  absolute,
		PasswordResetTTL:    resetTTL,
		AuditRetention:      auditRetention,
		ShutdownTimeout:     10 * time.Second,
	}, nil
}

func (c Config) ValidateDatabase() error {
	if c.DatabaseURL == "" {
		return errors.New("DATABASE_URL is required")
	}
	return nil
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func durationEnv(name string, fallback time.Duration) (time.Duration, error) {
	raw := envOr(name, fallback.String())
	value, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("parse %s: %w", name, err)
	}
	return value, nil
}
