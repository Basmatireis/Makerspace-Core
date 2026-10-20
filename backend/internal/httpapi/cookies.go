package httpapi

import (
	"net/http"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
)

// cookieNoContentResponse implements the generated response interfaces that
// need two Set-Cookie header lines. A generated scalar header cannot represent
// both the HttpOnly session cookie and the readable CSRF cookie.
type cookieNoContentResponse struct {
	config  config.Config
	session *auth.Session
	clear   bool
}

func (response cookieNoContentResponse) VisitLoginResponse(w http.ResponseWriter) error {
	return response.write(w)
}

func (response cookieNoContentResponse) VisitLoginWithPinResponse(w http.ResponseWriter) error {
	return response.write(w)
}

func (response cookieNoContentResponse) VisitLogoutResponse(w http.ResponseWriter) error {
	return response.write(w)
}

func (response cookieNoContentResponse) VisitChangeOwnPasswordResponse(w http.ResponseWriter) error {
	return response.write(w)
}

func (response cookieNoContentResponse) VisitRemoveOwnPasswordResponse(w http.ResponseWriter) error {
	return response.write(w)
}

func (response cookieNoContentResponse) VisitCompletePasswordResetResponse(w http.ResponseWriter) error {
	return response.write(w)
}

func (response cookieNoContentResponse) write(w http.ResponseWriter) error {
	w.Header().Set("Cache-Control", "no-store")
	if response.clear {
		clearSessionCookies(w, response.config)
	} else if response.session != nil {
		setSessionCookies(w, response.config, *response.session)
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// applicationCookie builds every first-party cookie the same way: path "/", SameSite=Lax and
// Secure from configuration. Only the CSRF cookie is readable by scripts (httpOnly false).
func applicationCookie(cfg config.Config, name, value string, httpOnly bool, expires time.Time, maxAge int) *http.Cookie {
	//nolint:gosec // Secure follows config, HttpOnly and SameSite are explicit; the CSRF cookie is readable by design
	return &http.Cookie{
		Name: name, Value: value, Path: "/", Expires: expires, MaxAge: maxAge,
		HttpOnly: httpOnly, Secure: cfg.SessionCookieSecure, SameSite: http.SameSiteLaxMode,
	}
}

// expiringCookie expires the named application cookie in the browser.
func expiringCookie(cfg config.Config, name string, httpOnly bool) *http.Cookie {
	return applicationCookie(cfg, name, "", httpOnly, time.Unix(1, 0).UTC(), -1)
}

// cookieMaxAge is the Max-Age for a cookie that must live until expires, at least one second.
func cookieMaxAge(expires time.Time) int {
	return max(1, int(time.Until(expires).Seconds()))
}

func setSessionCookies(w http.ResponseWriter, cfg config.Config, session auth.Session) {
	maxAge := cookieMaxAge(session.AbsoluteExpiry)
	http.SetCookie(w, applicationCookie(cfg, cfg.SessionCookieName, session.Token, true, session.AbsoluteExpiry, maxAge))
	http.SetCookie(w, applicationCookie(cfg, cfg.CSRFCookieName, session.CSRFToken, false, session.AbsoluteExpiry, maxAge))
}

func clearSessionCookies(w http.ResponseWriter, cfg config.Config) {
	http.SetCookie(w, expiringCookie(cfg, cfg.SessionCookieName, true))
	http.SetCookie(w, expiringCookie(cfg, cfg.CSRFCookieName, false))
}
