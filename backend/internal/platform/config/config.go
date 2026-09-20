package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	DatabaseURL             string
	HTTPAddr                string
	HTTPTrustedProxies      []netip.Prefix
	Environment             string
	PublicBaseURL           *url.URL
	SessionCookieName       string
	CSRFCookieName          string
	ManagedDeviceCookieName string
	OIDCFlowCookieName      string
	EnrollmentCookieName    string
	EnrollmentCSRFName      string
	SessionCookieSecure     bool
	SessionIdleTTL          time.Duration
	SessionAbsoluteTTL      time.Duration
	PasswordResetTTL        time.Duration
	AuditRetention          time.Duration
	ShutdownTimeout         time.Duration
	MakerspaceTimeZone      string
	HolidayCountry          string
	HolidaySubdivision      string
	HolidayLanguage         string
	ChallengeHMACKey        []byte
	PINPepper               []byte
	StorageBackend          string
	LocalStorageRoot        string
	S3Endpoint              string
	S3Region                string
	S3Bucket                string
	S3AccessKeyID           string
	S3SecretAccessKey       string
	S3UsePathStyle          bool
	S3DisableTLS            bool
	EncryptionKeys          [][]byte
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
	timeZone := envOr("MAKERSPACE_TIME_ZONE", "Europe/Vienna")
	if _, err := time.LoadLocation(timeZone); err != nil {
		return Config{}, fmt.Errorf("MAKERSPACE_TIME_ZONE is invalid: %w", err)
	}
	holidayCountry := strings.ToUpper(envOr("OPEN_DAYS_HOLIDAY_COUNTRY", "AT"))
	holidaySubdivision := strings.ToUpper(envOr("OPEN_DAYS_HOLIDAY_SUBDIVISION", "AT-6"))
	holidayLanguage := strings.ToLower(envOr("OPEN_DAYS_HOLIDAY_LANGUAGE", "de"))
	trustedProxies, err := prefixListEnv("HTTP_TRUSTED_PROXIES")
	if err != nil {
		return Config{}, err
	}
	challengeKey, err := secretKeyEnv("AUTH_CHALLENGE_HMAC_KEY", environment)
	if err != nil {
		return Config{}, err
	}
	pinPepper, err := secretKeyEnv("PIN_PEPPER", environment)
	if err != nil {
		return Config{}, err
	}
	storageBackend := strings.ToLower(envOr("STORAGE_BACKEND", "local"))
	if storageBackend != "local" && storageBackend != "s3" {
		return Config{}, errors.New("STORAGE_BACKEND must be local or s3")
	}
	localStorageRoot := envOr("LOCAL_STORAGE_ROOT", "/var/lib/makerspace/files")
	s3PathStyle, err := strconv.ParseBool(envOr("S3_USE_PATH_STYLE", "false"))
	if err != nil {
		return Config{}, fmt.Errorf("parse S3_USE_PATH_STYLE: %w", err)
	}
	s3DisableTLS, err := strconv.ParseBool(envOr("S3_DISABLE_TLS", "false"))
	if err != nil {
		return Config{}, fmt.Errorf("parse S3_DISABLE_TLS: %w", err)
	}
	if storageBackend == "s3" && (strings.TrimSpace(os.Getenv("S3_REGION")) == "" || strings.TrimSpace(os.Getenv("S3_BUCKET")) == "") {
		return Config{}, errors.New("S3_REGION and S3_BUCKET are required for S3 storage")
	}
	if environment == "production" && storageBackend == "s3" && s3DisableTLS {
		return Config{}, errors.New("S3_DISABLE_TLS cannot be true in production")
	}
	s3Endpoint := strings.TrimSpace(os.Getenv("S3_ENDPOINT"))
	if storageBackend == "s3" && s3Endpoint != "" {
		endpoint := s3Endpoint
		if !strings.Contains(endpoint, "://") {
			endpoint = "https://" + endpoint
		}
		parsed, err := url.Parse(endpoint)
		if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
			return Config{}, errors.New("S3_ENDPOINT must be an HTTP(S) endpoint without credentials, query, or fragment")
		}
		if environment == "production" && parsed.Scheme != "https" {
			return Config{}, errors.New("S3_ENDPOINT must use HTTPS in production")
		}
	}
	encryptionKeys, err := encryptionKeyListEnv("APP_ENCRYPTION_KEYS", environment)
	if err != nil {
		return Config{}, err
	}

	sessionName := "makerspace_session"
	csrfName := "makerspace_csrf"
	deviceName := "makerspace_device"
	oidcFlowName := "makerspace_oidc_flow"
	enrollmentName := "makerspace_enrollment"
	enrollmentCSRFName := "makerspace_enrollment_csrf"
	if secure {
		sessionName = "__Host-makerspace_session"
		csrfName = "__Host-makerspace_csrf"
		deviceName = "__Host-makerspace_device"
		oidcFlowName = "__Host-makerspace_oidc_flow"
		enrollmentName = "__Host-makerspace_enrollment"
		enrollmentCSRFName = "__Host-makerspace_enrollment_csrf"
	}

	return Config{
		DatabaseURL:             strings.TrimSpace(os.Getenv("DATABASE_URL")),
		HTTPAddr:                envOr("HTTP_ADDR", ":8080"),
		HTTPTrustedProxies:      trustedProxies,
		Environment:             environment,
		PublicBaseURL:           base,
		SessionCookieName:       sessionName,
		CSRFCookieName:          csrfName,
		ManagedDeviceCookieName: deviceName,
		OIDCFlowCookieName:      oidcFlowName,
		EnrollmentCookieName:    enrollmentName,
		EnrollmentCSRFName:      enrollmentCSRFName,
		SessionCookieSecure:     secure,
		SessionIdleTTL:          idle,
		SessionAbsoluteTTL:      absolute,
		PasswordResetTTL:        resetTTL,
		AuditRetention:          auditRetention,
		ShutdownTimeout:         10 * time.Second,
		MakerspaceTimeZone:      timeZone,
		HolidayCountry:          holidayCountry,
		HolidaySubdivision:      holidaySubdivision,
		HolidayLanguage:         holidayLanguage,
		ChallengeHMACKey:        challengeKey,
		PINPepper:               pinPepper,
		StorageBackend:          storageBackend,
		LocalStorageRoot:        localStorageRoot,
		S3Endpoint:              s3Endpoint,
		S3Region:                strings.TrimSpace(os.Getenv("S3_REGION")),
		S3Bucket:                strings.TrimSpace(os.Getenv("S3_BUCKET")),
		S3AccessKeyID:           strings.TrimSpace(os.Getenv("S3_ACCESS_KEY_ID")),
		S3SecretAccessKey:       os.Getenv("S3_SECRET_ACCESS_KEY"),
		S3UsePathStyle:          s3PathStyle,
		S3DisableTLS:            s3DisableTLS,
		EncryptionKeys:          encryptionKeys,
	}, nil
}

func encryptionKeyListEnv(name, environment string) ([][]byte, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		if environment != "production" {
			return [][]byte{[]byte("development-only-encryption-key!")}, nil
		}
		return nil, nil
	}
	parts := strings.Split(raw, ",")
	keys := make([][]byte, 0, len(parts))
	for _, part := range parts {
		decoded, err := base64.RawStdEncoding.DecodeString(strings.TrimSpace(part))
		if err != nil {
			decoded, err = base64.StdEncoding.DecodeString(strings.TrimSpace(part))
		}
		if err != nil || len(decoded) != 32 {
			return nil, fmt.Errorf("%s must contain comma-separated base64-encoded 32-byte keys", name)
		}
		keys = append(keys, decoded)
	}
	return keys, nil
}

func secretKeyEnv(name, environment string) ([]byte, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		if environment == "production" {
			return nil, fmt.Errorf("%s is required in production", name)
		}
		return []byte("development-only-challenge-key-32"), nil
	}
	key, err := base64.StdEncoding.DecodeString(raw)
	if err != nil || len(key) < 32 {
		return nil, fmt.Errorf("%s must be base64 for at least 32 bytes", name)
	}
	return key, nil
}

func prefixListEnv(name string) ([]netip.Prefix, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return nil, nil
	}

	parts := strings.Split(raw, ",")
	prefixes := make([]netip.Prefix, 0, len(parts))
	for _, part := range parts {
		value := strings.TrimSpace(part)
		if value == "" {
			return nil, fmt.Errorf("parse %s: empty CIDR", name)
		}
		prefix, err := netip.ParsePrefix(value)
		if err != nil {
			return nil, fmt.Errorf("parse %s CIDR %q: %w", name, value, err)
		}
		prefixes = append(prefixes, prefix.Masked())
	}
	return prefixes, nil
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
