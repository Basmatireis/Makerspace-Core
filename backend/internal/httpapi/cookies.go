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
		response.setCookie(w, response.config.SessionCookieName, "", true, time.Unix(1, 0).UTC(), -1)
		response.setCookie(w, response.config.CSRFCookieName, "", false, time.Unix(1, 0).UTC(), -1)
	} else if response.session != nil {
		maxAge := int(time.Until(response.session.AbsoluteExpiry).Seconds())
		if maxAge < 1 {
			maxAge = 1
		}
		response.setCookie(w, response.config.SessionCookieName, response.session.Token, true, response.session.AbsoluteExpiry, maxAge)
		response.setCookie(w, response.config.CSRFCookieName, response.session.CSRFToken, false, response.session.AbsoluteExpiry, maxAge)
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (response cookieNoContentResponse) setCookie(w http.ResponseWriter, name, value string, httpOnly bool, expires time.Time, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name: name, Value: value, Path: "/", Expires: expires, MaxAge: maxAge,
		HttpOnly: httpOnly, Secure: response.config.SessionCookieSecure, SameSite: http.SameSiteLaxMode,
	})
}
