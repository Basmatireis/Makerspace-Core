package notifyrules

import (
	"slices"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
)

// triggers is every event a rule can start from: the core triggers of catalog.go followed by those of visits, accounts,
// sales and security below.
var triggers = slices.Concat(coreTriggers, activityTriggers)

var checkInMethodOptions = options(
	"password", "Password", "pin", "PIN", "supervised", "Checked in by a supervisor", "enrollment", "Enrolment",
)

var checkOutMethodOptions = options(
	"self", "Signed out with their credentials", "tap", "Tapped their name", "supervised", "Checked out by a supervisor",
)

var customerTypeOptions = options("person", "A person", "organization", "An organization")

// activityTriggers are the triggers of everyday activity. Each is raised from the transaction of the mutation that
// causes it, by a method of SystemEvents in system_events_activity.go.
var activityTriggers = []Trigger{
	{
		Key: "check_in", Area: "People", Label: "Someone checks in",
		Help: "Fires when a visit starts: at a terminal with a password or PIN, when a supervisor checks someone in, " +
			"or when a new visitor finishes the enrolment.",
		Subject: SubjectLab, Permission: authorization.AttendanceRead,
		Fields: []Field{
			{Key: "systemRole", Label: "System role", Type: FieldEnum, Options: membershipOptions},
			{Key: "labRules", Label: "Lab Rules", Type: FieldEnum, Options: options(
				"confirmed", "Confirmed", "not_confirmed", "Not confirmed yet",
			)},
			{Key: "firstVisit", Label: "First visit ever", Type: FieldBool},
			{Key: "method", Label: "Checked in with", Type: FieldEnum, Options: checkInMethodOptions},
			{Key: "device", Label: "Terminal", Type: FieldText},
		},
		Recipients: triggerSubjects(
			"self", "The person who checks in", "on_duty", "Supervisors who are checked in right now",
		),
		Placeholders: []Placeholder{
			{"person", "Name of the person", "Mia Gruber"},
			{"systemRole", "System role", "Trainee"},
			{"method", "How they checked in", "with their PIN"},
			{"device", "Terminal, empty when not at a terminal", "Entrance terminal"},
			{"deviceNote", "\" at …\", empty when not at a terminal", " at Entrance terminal"},
		},
		ThrottleSubjects: triggerSubjects("person", "person"),
	},
	{
		Key: "check_out", Area: "People", Label: "Someone checks out",
		Help: "Fires when a visit ends: signed out at a terminal, by tapping a name, or by a supervisor. Visits are not " +
			"closed automatically, so there is no automatic check-out.",
		Subject: SubjectLab, Permission: authorization.AttendanceRead,
		Fields: []Field{
			{Key: "systemRole", Label: "System role", Type: FieldEnum, Options: membershipOptions},
			{Key: "stayed", Label: "Stayed", Type: FieldNumber, Unit: "h"},
			{Key: "method", Label: "Checked out", Type: FieldEnum, Options: checkOutMethodOptions},
		},
		Recipients: triggerSubjects(
			"self", "The person who checks out", "on_duty", "Supervisors who are checked in right now",
		),
		Placeholders: []Placeholder{
			{"person", "Name of the person", "Mia Gruber"},
			{"systemRole", "System role", "Trainee"},
			{"stayed", "How long the visit lasted", "2 h 15 min"},
			{"device", "Terminal, empty when not at a terminal", "Entrance terminal"},
		},
		ThrottleSubjects: triggerSubjects("person", "person"),
	},
	{
		Key: "account_created", Area: "People", Label: "A new account is created",
		Help:    "Fires when staff create an account for a person. Accounts that appear through enrolment are not raised here.",
		Subject: SubjectLab, Permission: authorization.AccountsRead,
		Fields: []Field{
			{Key: "systemRole", Label: "System role", Type: FieldEnum, Options: membershipOptions},
		},
		Recipients: triggerSubjects("self", "The new person"),
		Placeholders: []Placeholder{
			{"person", "Name of the person", "Tobias Lang"},
			{"systemRole", "System role, empty without one", "Trainee"},
		},
	},
	{
		Key: "training_recorded", Area: "People", Label: "A training is recorded for someone",
		Help: "Fires when a person is recorded as trained or as trainer for a training. Corrections of the date or the " +
			"notes and removals stay quiet.",
		Subject: SubjectLab, Permission: authorization.TrainingRecordsReadAll,
		Fields: []Field{
			{Key: "training", Label: "Training", Type: FieldEnum, OptionsFrom: SourceTrainings},
			{Key: "status", Label: "Recorded as", Type: FieldEnum, Options: options("trained", "Trained", "trainer", "Trainer")},
		},
		Recipients: triggerSubjects("self", "The trained person", "trainers", "Trainers of that training"),
		Placeholders: []Placeholder{
			{"person", "Name of the person", "Tobias Lang"},
			{"training", "Training", "3D printing basics"},
			{"status", "\"trained\" or \"trainer\"", "trained"},
		},
		ThrottleSubjects: triggerSubjects("training", "training"),
	},
	{
		Key: "survey_answered", Area: "People", Label: "Someone answers a survey",
		Help: "Fires on each submitted survey response. It never names the respondent, whether the survey is anonymous " +
			"or not, and carries no free text; choose roles or people to tell.",
		Subject: SubjectLab, Permission: authorization.SurveysRead,
		Fields: []Field{
			{Key: "survey", Label: "Survey", Type: FieldText},
			{Key: "rating", Label: "Rating of the first rating question", Type: FieldNumber},
			{Key: "anonymous", Label: "Survey is anonymous", Type: FieldBool},
		},
		Placeholders: []Placeholder{
			{"survey", "Name of the survey", "Visit feedback"},
			{"rating", "Rating of the first rating question, empty without one", "2"},
			{"ratingNote", "\" rated …\", empty without a rating", " rated 2"},
		},
	},
	{
		Key: "role_changed", Area: "Security", Label: "Someone's roles change",
		Help: "Fires when a role is added to or removed from a person. Switching the system role raises it for the " +
			"new role. A role is privileged when it is the master role or grants a permission that manages something.",
		Subject: SubjectLab, Permission: authorization.RolesRead,
		Fields: []Field{
			{Key: "change", Label: "Change", Type: FieldEnum, Options: options("assigned", "Role added", "removed", "Role removed")},
			{Key: "role", Label: "Role", Type: FieldEnum, OptionsFrom: SourceRoles},
			{Key: "privileged", Label: "Role is privileged", Type: FieldBool},
		},
		Recipients: triggerSubjects("self", "The person whose roles change"),
		Placeholders: []Placeholder{
			{"person", "Name of the person", "Sophie Berger"},
			{"role", "Role", "Workshop lead"},
			{"change", "\"added\" or \"removed\"", "added"},
			{"by", "Who changed it", "Jana Huber"},
		},
		ThrottleSubjects: triggerSubjects("role", "role"),
	},
	{
		Key: "privacy_request_created", Area: "Security", Label: "A privacy request arrives",
		Help:    "Fires when staff record that someone asks for their data or for their data to be deleted.",
		Subject: SubjectLab, Permission: authorization.PrivacyRequestsManage,
		Fields: []Field{
			{Key: "type", Label: "Request", Type: FieldEnum, Options: options("access", "Access", "erasure", "Deletion")},
		},
		Placeholders: []Placeholder{
			{"type", "\"access\" or \"deletion\"", "deletion"},
			{"person", "Name of the person asking", "Jonas Pichler"},
			{"reference", "Reference of the request", "PR-2026-0007"},
			{"due", "Date the answer is due", "6 Dec"},
		},
	},
	{
		Key: "open_day_signup", Area: "Open Days", Label: "Someone signs up for an open day",
		Help: "Fires when a person gets a supervisor or trainee place on an open day, by signing up or because somebody " +
			"assigned them.",
		Subject: SubjectLab, Permission: authorization.OpenDaysRead,
		Fields: []Field{
			{Key: "placeType", Label: "Place", Type: FieldEnum, Options: options("supervisor", "Supervisor place", "trainee", "Trainee place")},
			{Key: "daysUntil", Label: "Days until the open day", Type: FieldNumber, Unit: "days"},
			{Key: "weekday", Label: "Weekday", Type: FieldEnum, Options: weekdayOptions},
			{Key: "bySelf", Label: "Signed up by themselves", Type: FieldBool},
		},
		Recipients: triggerSubjects(
			"self", "The person who signs up", "day_team", "Everyone else signed up for that open day",
		),
		Placeholders: []Placeholder{
			{"person", "Name of the person", "Mia Gruber"},
			{"place", "\"supervisor place\" or \"trainee place\"", "supervisor place"},
			{"day", "Date of the open day", "Thu 13 Nov 2026"},
			{"time", "Time of the timeslot", "16:00–20:00"},
			{"daysUntil", "Days until the open day", "7"},
		},
		ThrottleSubjects: triggerSubjects("open_day", "open day"),
	},
	{
		Key: "order_created", Area: "Sales", Label: "An order is created",
		Help:    "Fires when an order leaves draft and is finalized.",
		Subject: SubjectLab, Permission: authorization.OrdersRead,
		Fields: []Field{
			{Key: "amount", Label: "Amount", Type: FieldNumber, Unit: "€"},
			{Key: "customerType", Label: "Customer is", Type: FieldEnum, Options: customerTypeOptions},
		},
		Recipients: triggerSubjects("customer", "The customer", "creator", "Who created the order"),
		Placeholders: []Placeholder{
			{"order", "Order", "O-2026-0109"},
			{"amount", "Total of the order", "€ 32.00"},
			{"customer", "Customer, empty for a sale without a customer", "Tobias Lang"},
		},
	},
	{
		Key: "payment_recorded", Area: "Sales", Label: "A payment is recorded",
		Help:    "Fires on every cash or card payment booked on an order, and when a wiRef invoice settles one.",
		Subject: SubjectLab, Permission: authorization.PaymentsRead,
		Fields: []Field{
			{Key: "method", Label: "Method", Type: FieldEnum, Options: options(
				"cash", "Cash", "card", "Card", "external", "wiRef invoice",
			)},
			{Key: "amount", Label: "Amount", Type: FieldNumber, Unit: "€"},
		},
		Recipients: triggerSubjects("booker", "Who recorded it", "customer", "The customer"),
		Placeholders: []Placeholder{
			{"order", "Order", "O-2026-0104"},
			{"amount", "Amount paid", "€ 18.20"},
			{"method", "How it was paid", "cash"},
		},
	},
	{
		Key: "cash_count_difference", Area: "Sales", Label: "A cash count differs",
		Help:    "Fires when a counted cash register differs from the expected amount.",
		Subject: SubjectLab, Permission: authorization.CashMovementsRead,
		Fields: []Field{
			{Key: "difference", Label: "Difference (negative when cash is missing)", Type: FieldNumber, Unit: "€"},
		},
		Recipients: triggerSubjects("counter", "Who counted the cash"),
		Placeholders: []Placeholder{
			{"count", "Reference of the count", "C-2026-0012"},
			{"difference", "Size of the difference", "€ 7.50"},
			{"direction", "\"short\" or \"over\"", "short"},
			{"expected", "Expected amount", "€ 212.40"},
			{"counted", "Counted amount", "€ 204.90"},
			{"counter", "Who counted", "Lukas Wagner"},
		},
	},
	{
		Key: "wiref_invoice_status", Area: "Sales", Label: "A wiRef invoice changes status",
		Help:    "Fires when a wiRef invoice request is submitted, issued, returned to draft or cancelled, or a cancellation is requested.",
		Subject: SubjectLab, Permission: authorization.ExternalInvoiceRequestsRead,
		Fields: []Field{
			{Key: "status", Label: "New status", Type: FieldEnum, Options: options(
				"draft", "Draft", "submitted", "Waiting for approval", "issued", "Issued",
				"cancellation_requested", "Cancellation requested", "cancelled", "Cancelled",
			)},
		},
		Recipients: triggerSubjects("creator", "Who created the order"),
		Placeholders: []Placeholder{
			{"invoice", "Reference of the request", "WR-2026-0012"},
			{"order", "Order", "O-2026-0102"},
			{"status", "New status", "issued"},
		},
	},
	{
		Key: "job_created", Area: "Workshop", Label: "A job is created",
		Help:    "Fires when a job is created, by hand or from an existing run.",
		Subject: SubjectLab, Permission: authorization.MachineJobsRead,
		Fields: []Field{
			{Key: "machine", Label: "Machine", Type: FieldEnum, OptionsFrom: SourceMachines},
			{Key: "recipientType", Label: "Job's recipient is", Type: FieldEnum, Options: customerTypeOptions},
		},
		Recipients: triggerSubjects("operator", "Operator of the job", "recipient", "Job's recipient"),
		Placeholders: []Placeholder{
			{"job", "Job title, or its number without a title", "Phone stand"},
			{"machine", "Machine", "Prusa CORE One"},
			{"operator", "Operator, empty without one", "Tobias Lang"},
		},
		ThrottleSubjects: triggerSubjects("machine", "machine"),
	},
}
