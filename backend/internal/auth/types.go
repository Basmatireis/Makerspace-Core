package auth

// ChallengeKind is the purpose of a one-time authentication challenge.
type ChallengeKind string

const (
	ChallengePasswordReset     ChallengeKind = "password_reset"
	ChallengeInvitation        ChallengeKind = "invitation"
	ChallengeEmailVerification ChallengeKind = "email_verification"
	ChallengePINEnrollment     ChallengeKind = "pin_enrollment"
)

// DeliveryStatus is the outcome of delivering a challenge code to its recipient.
type DeliveryStatus string

const (
	DeliverySent   DeliveryStatus = "sent"
	DeliveryManual DeliveryStatus = "manual"
	DeliveryFailed DeliveryStatus = "failed"
)
