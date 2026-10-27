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

// ConditionOperator compares the answer to an earlier question with the value stored in a display condition.
type ConditionOperator string

const (
	ConditionOneOf       ConditionOperator = "one_of"       // single choice: the answer is one of the options
	ConditionIncludesAny ConditionOperator = "includes_any" // multiple choice: a selected option is one of the options
	ConditionLessEqual   ConditionOperator = "lte"          // rating <= value
	ConditionGreaterEq   ConditionOperator = "gte"          // rating >= value
	ConditionEquals      ConditionOperator = "eq"           // rating == value, or yes/no == boolean
)

// ResponseSource says how a respondent reached the survey.
type ResponseSource string

const (
	SourceInvitation ResponseSource = "invitation"
	SourceLink       ResponseSource = "link"
)

// LinkState is the derived availability of a share link (the survey must additionally be published).
type LinkState string

const (
	LinkOpen     LinkState = "open"
	LinkInactive LinkState = "inactive"
	LinkExpired  LinkState = "expired"
	LinkFull     LinkState = "full"
)
