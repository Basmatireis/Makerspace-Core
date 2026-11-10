package auth

// ChallengeKind is the purpose of a one-time authentication challenge.
type ChallengeKind string

const (
	ChallengePasswordReset     ChallengeKind = "password_reset"
	ChallengeInvitation        ChallengeKind = "invitation"
	ChallengeEmailVerification ChallengeKind = "email_verification"
	ChallengePINEnrollment     ChallengeKind = "pin_enrollment"
	ChallengeEmailLogin        ChallengeKind = "email_login"
)

// LoginMethod is how the login email identity proved itself when a session or pending login was created.
type LoginMethod string

const (
	MethodPassword  LoginMethod = "password"
	MethodEmailCode LoginMethod = "email_code"
)

// DeliveryStatus is the outcome of delivering a challenge code to its recipient.
type DeliveryStatus string

const (
	DeliverySent   DeliveryStatus = "sent"
	DeliveryManual DeliveryStatus = "manual"
	DeliveryFailed DeliveryStatus = "failed"
)
