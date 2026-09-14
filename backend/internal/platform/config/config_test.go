package config

import (
	"testing"
	"time"
)

func setValidEnvironment(t *testing.T) {
	t.Helper()
	t.Setenv("APP_ENV", "test")
	t.Setenv("PUBLIC_BASE_URL", "")
	t.Setenv("SESSION_COOKIE_SECURE", "")
	t.Setenv("SESSION_IDLE_TTL", "")
	t.Setenv("SESSION_ABSOLUTE_TTL", "")
	t.Setenv("PASSWORD_RESET_TTL", "")
	t.Setenv("AUDIT_RETENTION", "")
	t.Setenv("MAKERSPACE_TIME_ZONE", "")
	t.Setenv("OPEN_DAYS_HOLIDAY_COUNTRY", "")
	t.Setenv("OPEN_DAYS_HOLIDAY_SUBDIVISION", "")
	t.Setenv("OPEN_DAYS_HOLIDAY_LANGUAGE", "")
}

func TestLoadUsesLockedSessionAndRetentionDefaults(t *testing.T) {
	setValidEnvironment(t)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SessionIdleTTL != 6*time.Hour || cfg.SessionAbsoluteTTL != 72*time.Hour {
		t.Fatalf("unexpected session defaults: idle=%s absolute=%s", cfg.SessionIdleTTL, cfg.SessionAbsoluteTTL)
	}
	if cfg.PasswordResetTTL != 30*time.Minute || cfg.AuditRetention != 365*24*time.Hour {
		t.Fatalf("unexpected retention defaults: reset=%s audit=%s", cfg.PasswordResetTTL, cfg.AuditRetention)
	}
	if cfg.MakerspaceTimeZone != "Europe/Vienna" || cfg.HolidayCountry != "AT" || cfg.HolidaySubdivision != "AT-6" || cfg.HolidayLanguage != "de" {
		t.Fatalf("unexpected Open Days defaults: %#v", cfg)
	}
}

func TestLoadRejectsInvalidMakerspaceTimeZone(t *testing.T) {
	setValidEnvironment(t)
	t.Setenv("MAKERSPACE_TIME_ZONE", "Mars/Olympus_Mons")
	if _, err := Load(); err == nil {
		t.Fatal("invalid makerspace timezone was accepted")
	}
}

func TestLoadRequiresHTTPSProductionOrigin(t *testing.T) {
	setValidEnvironment(t)
	t.Setenv("APP_ENV", "production")
	t.Setenv("SESSION_COOKIE_SECURE", "true")
	if _, err := Load(); err == nil {
		t.Fatal("HTTP production origin was accepted")
	}
}

func TestLoadRejectsValuesThatAreNotOrigins(t *testing.T) {
	for _, value := range []string{
		"ftp://example.test",
		"https://example.test/path",
		"https://example.test?query=value",
		"https://example.test/#fragment",
		"https://user@example.test",
	} {
		t.Run(value, func(t *testing.T) {
			setValidEnvironment(t)
			t.Setenv("PUBLIC_BASE_URL", value)
			if _, err := Load(); err == nil {
				t.Fatalf("non-origin %q was accepted", value)
			}
		})
	}
}

func TestLoadRejectsNonPositiveResetTTL(t *testing.T) {
	setValidEnvironment(t)
	t.Setenv("PASSWORD_RESET_TTL", "0s")
	if _, err := Load(); err == nil {
		t.Fatal("zero password reset TTL was accepted")
	}
}
