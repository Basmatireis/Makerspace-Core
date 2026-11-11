package auth

// ChallengeKind is the purpose of a one-time authentication challenge.
type ChallengeKind string

const (
	ChallengePasswordReset     ChallengeKind = "password_reset"
	ChallengeInvitation        ChallengeKind = "invitation"
	ChallengeEmailVerification ChallengeKind = "email_verification"
	ChallengePINEnrollment     ChallengeKind = "pin_enrollment"
	ChallengeEmailLogin        ChallengeKind = "email_login"
	ChallengeEmailCheckIn      ChallengeKind = "email_check_in"
)

// LoginMethod is how the login email identity proved itself when a session or pending login was created.
type LoginMethod string

const (
	MethodPassword  LoginMethod = "password"
	MethodEmailCode LoginMethod = "email_code"
)

// SessionRestriction confines a session to one purpose; the empty value is a normal session.
type SessionRestriction string

const (
	// RestrictionNotificationSettings lets an account without web.sign_in (a visitor) read and change only its own
	// notification settings. The HTTP layer derives the operations it may call from the contract.
	RestrictionNotificationSettings SessionRestriction = "notification_settings"
)

// Valid reports whether the restriction is empty or a known one.
func (r SessionRestriction) Valid() bool {
	return r == "" || r == RestrictionNotificationSettings
}

func (r SessionRestriction) column() *string {
	if r == "" {
		return nil
	}
	value := string(r)
	return &value
}

// restrictionMetadata marks a restricted sign-in in its audit event; a normal one carries none.
func restrictionMetadata(restriction SessionRestriction) map[string]any {
	if restriction == "" {
		return nil
	}
	return map[string]any{"restriction": string(restriction)}
}

func restrictionFromColumn(value *string) SessionRestriction {
	if value == nil {
		return ""
	}
	return SessionRestriction(*value)
}

// DeliveryStatus is the outcome of delivering a challenge code to its recipient.
type DeliveryStatus string

const (
	DeliverySent   DeliveryStatus = "sent"
	DeliveryManual DeliveryStatus = "manual"
	DeliveryFailed DeliveryStatus = "failed"
)
