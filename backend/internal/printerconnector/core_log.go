package printerconnector

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

// credentialRejectedLogInterval limits the actionable "credential rejected" error to one line per interval.
const credentialRejectedLogInterval = 5 * time.Minute

// enrollmentDigest identifies an enrollment secret without storing it.
func enrollmentDigest(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

// credentialRejected reports whether Core refused the connector's own credential (revoked, deleted or inactive).
func credentialRejected(err error) bool {
	var coreErr *CoreError
	if !errors.As(err, &coreErr) {
		return false
	}
	return coreErr.Status == 401 || coreErr.Status == 403 || strings.Contains(coreErr.Code, "inactive")
}

// safeCode keeps Core's error code short and single-line before it is logged.
func safeCode(code string) string {
	code = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, code)
	if len(code) > 64 {
		code = code[:64]
	}
	return code
}

// logFailure logs a failed Core call with safe fields only: the HTTP status and Core's error code for
// answers from Core, the error type otherwise. A rejected credential additionally gets the rate-limited
// actionable error.
func (r *Runtime) logFailure(message string, err error) {
	var coreErr *CoreError
	if errors.As(err, &coreErr) {
		r.logger.Warn(
			message,
			"error_type",
			fmt.Sprintf("%T", err),
			"status",
			coreErr.Status,
			"code",
			safeCode(coreErr.Code),
		)
	} else {
		r.logger.Warn(message, "error_type", fmt.Sprintf("%T", err))
	}
	if credentialRejected(err) {
		r.logCredentialRejected()
	}
}

func (r *Runtime) logCredentialRejected() {
	now := time.Now
	if r.now != nil {
		now = r.now
	}
	r.mu.Lock()
	due := r.lastRejectedLog.IsZero() || now().Sub(r.lastRejectedLog) >= credentialRejectedLogInterval
	if due {
		r.lastRejectedLog = now()
	}
	r.mu.Unlock()
	if due {
		r.logger.Error(
			"Core rejects this connector's credential (revoked or deleted). Create or pick a connector in Core, put a new CONNECTOR_ENROLLMENT_SECRET into .env and restart.",
		)
	}
}

// enrollmentFailureReason explains why Core refused an enrollment secret.
func enrollmentFailureReason(err error) string {
	var coreErr *CoreError
	if !errors.As(err, &coreErr) {
		return "Core could not be reached; the secret was not checked"
	}
	switch {
	case coreErr.Status == 401:
		return "the secret is invalid, expired, already used or revoked"
	case coreErr.Status == 403:
		return "the connector is inactive or deleted in Core"
	case coreErr.Status == 429:
		return "Core is rate limiting enrollment attempts; try again later"
	case coreErr.Status >= 500:
		return "Core failed to process the request; try again later"
	default:
		return "Core refused the secret"
	}
}
