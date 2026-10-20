package surveys

// QuestionKind is the answer format of a survey question.
type QuestionKind string

const (
	QuestionSingleChoice   QuestionKind = "single_choice"
	QuestionMultipleChoice QuestionKind = "multiple_choice"
	QuestionFreeText       QuestionKind = "free_text"
	QuestionRating         QuestionKind = "rating"
	QuestionYesNo          QuestionKind = "yes_no"
)

// Status is the publication state of a survey.
type Status string

const (
	StatusDraft     Status = "draft"
	StatusPublished Status = "published"
	StatusClosed    Status = "closed"
)

// TriggerKind is the event that makes Core invite a person to a survey.
type TriggerKind string

const TriggerVisitCheckedOut TriggerKind = "visit_checked_out"

// InvitationStatus is the delivery and redemption state of a survey invitation.
type InvitationStatus string

const (
	InvitationPending    InvitationStatus = "pending"
	InvitationDelivering InvitationStatus = "delivering"
	InvitationSent       InvitationStatus = "sent"
	InvitationFailed     InvitationStatus = "failed"
	InvitationRedeemed   InvitationStatus = "redeemed"
	InvitationExpired    InvitationStatus = "expired"
	InvitationCancelled  InvitationStatus = "cancelled"
)
