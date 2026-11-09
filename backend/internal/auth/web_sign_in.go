package auth

import (
	"context"
	"net/http"

	authdb "github.com/Basmatireis/Makerspace-Core/backend/internal/auth/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

// WebSignInNotPermittedCode is the error code of an account whose roles do not grant web.sign_in.
const WebSignInNotPermittedCode = "web_sign_in_not_permitted"

// webSignInNotPermitted is returned for every web sign-in path and for sessions of accounts that lost the right.
// Terminal check-in (attendance) never creates a web session and is not affected.
func webSignInNotPermitted() *apperror.Error {
	return apperror.New(
		http.StatusForbidden,
		WebSignInNotPermittedCode,
		"This account may not sign in to the web application. Use the terminal at the makerspace instead.",
	)
}

// requireWebSignIn refuses an account whose roles do not grant web.sign_in. Permissions are re-read from the
// database through db, so a caller inside a transaction sees the state it holds locks on. A sign-in on a verified
// managed device (the tablet terminal, where visitors identify themselves by PIN) is the terminal flow and needs no
// web access.
func requireWebSignIn(ctx context.Context, db authdb.DBTX, accountID uuid.UUID) error {
	if managedDeviceFromContext(ctx) != nil {
		return nil
	}
	principal, err := authorization.LoadPermissionsFrom(ctx, db, authorization.Principal{AccountID: accountID})
	if err != nil {
		return err
	}
	if !principal.MaySignInToWeb() {
		return webSignInNotPermitted()
	}
	return nil
}
