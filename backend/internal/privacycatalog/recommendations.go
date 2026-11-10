package privacycatalog

import "github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"

// Legal bases shared by several recommendations.
const (
	basisLabUse      = "Art. 6(1)(b) GDPR: use of the lab under the Lab Rules"
	basisSecurity    = "Art. 6(1)(f) GDPR and Art. 32 GDPR: security of the service"
	basisInterest    = "Art. 6(1)(f) GDPR: legitimate interest in running the lab"
	basisBookkeeping = "Art. 6(1)(c) GDPR with § 132 BAO: seven-year retention of accounting records"
	basisNoSubject   = "Not personal data: no person is linked"
	sevenYears       = 2557 // seven years counted generously, since § 132 BAO runs from the end of the calendar year
	threeYears       = 1095 // the limitation period for damages under § 1489 ABGB
)

// recommendations are the retention decisions the project proposes: personal data goes as soon as its purpose
// is served, legal periods are kept, and data without a person link or with the link removed stays as long as it
// is useful. They are seeded as complete drafts and take effect only once approved and activated. Stored files
// have none: they go with the record that references them, which no period from their creation describes.
var recommendations = map[privacy.CategoryID]privacy.Recommendation{
	PeopleIdentity: {
		Trigger: privacy.TriggerLastUsedAt, PeriodDays: 365, Action: privacy.ActionDelete,
		Purpose: "Know who may use the lab and reach them", LegalBasis: basisLabUse,
		Reason: "A person who has not visited for two semesters has left the lab; the deletion takes their trainings and Lab Rules confirmations with it. Applied by hand until the category has a retention routine.",
	},
	AccountsCredentials: {
		Trigger: privacy.TriggerAccountClosedAt, PeriodDays: 0, Action: privacy.ActionDelete,
		Purpose: "Sign in", LegalBasis: basisLabUse, Reason: "Credentials have no use once the account is closed.",
	},
	AuthSessions: {
		Trigger: privacy.TriggerExpiredAt, PeriodDays: 0, Action: privacy.ActionDelete,
		Purpose: "Keep people signed in", LegalBasis: basisLabUse, Reason: "An expired or revoked session has no use.",
	},
	AuthPendingState: {
		Trigger: privacy.TriggerExpiredAt, PeriodDays: 1, Action: privacy.ActionDelete,
		Purpose: "Complete a sign-in or an enrollment", LegalBasis: basisLabUse,
		Reason: "One day is enough to look into a sign-in that got stuck.",
	},
	SCIMMappings: {
		Trigger: privacy.TriggerAccountClosedAt, PeriodDays: 0, Action: privacy.ActionRetainWithReview,
		Purpose: "Provision accounts from the identity provider", LegalBasis: basisLabUse,
		Reason: "The mapping is removed by deprovisioning in the identity provider, not by this app.",
	},
	AttendanceVisits: {
		Trigger: privacy.TriggerCompletedAt, PeriodDays: 0, Action: privacy.ActionAnonymize,
		Purpose: "Know who is in the lab right now", LegalBasis: basisLabUse,
		Reason: "Once a person has left, only the anonymous daily figures are needed.",
	},
	SurveyInvitations: {
		Trigger: privacy.TriggerExpiredAt, PeriodDays: 7, Action: privacy.ActionUnlink,
		Purpose: "Invite visitors to a survey", LegalBasis: basisInterest,
		Reason: "A week after expiry the invitation is only needed for the response rate, without the person.",
	},
	SurveyOffers: {
		Trigger: privacy.TriggerExpiredAt, PeriodDays: 1, Action: privacy.ActionDelete,
		Purpose: "Offer a survey on the tablet", LegalBasis: basisInterest, Reason: "An expired offer has no use.",
	},
	SurveyResponses: {
		Trigger: privacy.TriggerCreatedAt, PeriodDays: 0, Action: privacy.ActionRetainWithReview,
		Purpose: "Improve the lab from visitor feedback", LegalBasis: basisInterest,
		Reason: "Results are anonymous unless the respondent chose to be identified; they stay useful for comparing semesters.",
	},
	EventExternalSignups: {
		Trigger: privacy.TriggerCompletedAt, PeriodDays: 90, Action: privacy.ActionRedact,
		Purpose: "Run events with outside participants", LegalBasis: basisLabUse,
		Reason: "Ninety days cover questions and settling costs after the event; the number of participants stays.",
	},
	EventContent: {
		Trigger: privacy.TriggerCompletedAt, PeriodDays: 0, Action: privacy.ActionRetainWithReview,
		Purpose: "Plan and document events", LegalBasis: basisInterest,
		Reason: "Event plans are reused for later events; the person links go when the person is deleted.",
	},
	OpenDayAssignments: {
		Trigger: privacy.TriggerCompletedAt, PeriodDays: 0, Action: privacy.ActionRetainWithReview,
		Purpose: "Staff open days and check the semester minimum", LegalBasis: basisLabUse,
		Reason: "Needed for staffing and promotion decisions while the person is a member; deleted with the person.",
	},
	StaffingExcusals: {
		Trigger: privacy.TriggerCreatedAt, PeriodDays: 0, Action: privacy.ActionRetainWithReview,
		Purpose: "Excuse supervisors from the semester minimum", LegalBasis: basisLabUse,
		Reason: "Needed for the staffing review of the semester; deleted with the person. Review whether old reasons can go.",
	},
	TrainingRecords: {
		Trigger: privacy.TriggerAccountClosedAt, PeriodDays: 0, Action: privacy.ActionRetainWithReview,
		Purpose: "Know who may use which machine", LegalBasis: basisLabUse,
		Reason: "Proof of instruction for as long as the person exists; deleted with the person.",
	},
	LabRulesConfirmations: {
		Trigger: privacy.TriggerAccountClosedAt, PeriodDays: 0, Action: privacy.ActionRetainWithReview,
		Purpose: "Prove that the Lab Rules were accepted", LegalBasis: basisLabUse,
		Reason: "Proof of acceptance for as long as the person exists; deleted with the person.",
	},
	AuditEvents: {
		Trigger: privacy.TriggerCreatedAt, PeriodDays: 365, Action: privacy.ActionDelete,
		Purpose: "Trace changes and security incidents", LegalBasis: basisSecurity + " and Art. 5(2) GDPR: accountability",
		Reason: "One year covers incidents noticed late and the review of a whole academic year.",
	},
	OrdersFinancialRecords: {
		Trigger: privacy.TriggerLegalPeriodEnd, PeriodDays: sevenYears, Action: privacy.ActionRetainWithReview,
		Purpose: "Invoice sales and keep the books", LegalBasis: basisBookkeeping,
		Reason: "Accounting records must be kept for seven years; they cannot be changed and lose the person link on deletion.",
	},
	OrdersIdempotency: {
		Trigger: privacy.TriggerCreatedAt, PeriodDays: sevenYears, Action: privacy.ActionRetainWithReview,
		Purpose: "Prevent double bookings", LegalBasis: basisBookkeeping,
		Reason: "Part of the evidence for the bookings it protects.",
	},
	OrganizationContacts: {
		Trigger: privacy.TriggerLastUsedAt, PeriodDays: threeYears, Action: privacy.ActionRetainWithReview,
		Purpose: "Invoice and contact partner organizations", LegalBasis: basisInterest,
		Reason: "Review contacts that were not used for three years.",
	},
	MachineJobs: {
		Trigger: privacy.TriggerCompletedAt, PeriodDays: 0, Action: privacy.ActionRetainWithReview,
		Purpose: "Record machine use, material and costs", LegalBasis: basisLabUse,
		Reason: "Jobs and runs feed the machine statistics and material accounting; the person link goes with the person.",
	},
	InventoryNotes: {
		Trigger: privacy.TriggerLegalPeriodEnd, PeriodDays: sevenYears, Action: privacy.ActionRetainWithReview,
		Purpose: "Account for material stock", LegalBasis: basisBookkeeping,
		Reason: "Stock movements are accounting records.",
	},
	PrintArtifacts: {
		Trigger: privacy.TriggerCreatedAt, PeriodDays: 365, Action: privacy.ActionDelete,
		Purpose: "Show and reprint print jobs", LegalBasis: basisNoSubject,
		Reason: "A year allows reprints and previews in the job history while bounding storage.",
	},
	PrinterTelemetry: {
		Trigger: privacy.TriggerCreatedAt, PeriodDays: 90, Action: privacy.ActionDelete,
		Purpose: "Diagnose printers", LegalBasis: basisNoSubject,
		Reason: "Ninety days cover printer faults over a semester; the statistics live in jobs and runs.",
	},
	RunTimelapses: {
		Trigger: privacy.TriggerCreatedAt, PeriodDays: 90, Action: privacy.ActionDelete,
		Purpose: "Show how a print went", LegalBasis: basisInterest,
		Reason: "Cameras face the print bed. If people are recognizable, shorten this: the Austrian data protection authority uses 72 hours as a benchmark for image recordings.",
	},
	InboxNotifications: {
		Trigger: privacy.TriggerCreatedAt, PeriodDays: 90, Action: privacy.ActionDelete,
		Purpose: "Inform people in the app", LegalBasis: basisLabUse, Reason: "Ninety days keep a semester's messages at hand.",
	},
	GuideProgress: {
		Trigger: privacy.TriggerAccountClosedAt, PeriodDays: 0, Action: privacy.ActionDelete,
		Purpose: "Remember finished guided tours", LegalBasis: basisLabUse, Reason: "Has no use without the account.",
	},
	AccountPreferences: {
		Trigger: privacy.TriggerAccountClosedAt, PeriodDays: 0, Action: privacy.ActionDelete,
		Purpose: "Remember interface preferences", LegalBasis: basisLabUse, Reason: "Has no use without the account.",
	},
	CalendarFeeds: {
		Trigger: privacy.TriggerAccountClosedAt, PeriodDays: 0, Action: privacy.ActionDelete,
		Purpose: "Publish a personal calendar feed", LegalBasis: basisLabUse, Reason: "Has no use without the person.",
	},
	NotificationConsents: {
		Trigger: privacy.TriggerEndedAt, PeriodDays: threeYears, Action: privacy.ActionDelete,
		Purpose: "Prove consent to notifications", LegalBasis: "Art. 6(1)(c) GDPR with Art. 7(1) GDPR: proof of consent",
		Reason: "A withdrawal stays provable until claims under § 1489 ABGB are time-barred.",
	},
	NotificationRules: {
		Trigger: privacy.TriggerAccountClosedAt, PeriodDays: 0, Action: privacy.ActionDelete,
		Purpose: "Send the notifications a person chose", LegalBasis: basisLabUse, Reason: "Has no use without the account.",
	},
	NotificationDeliveries: {
		Trigger: privacy.TriggerCreatedAt, PeriodDays: 90, Action: privacy.ActionDelete,
		Purpose: "Prove and debug notification delivery", LegalBasis: basisInterest,
		Reason: "Ninety days cover questions about a missing message.",
	},
	SignageAnnouncements: {
		Trigger: privacy.TriggerEndedAt, PeriodDays: 30, Action: privacy.ActionDelete,
		Purpose: "Show announcements on displays", LegalBasis: basisInterest,
		Reason: "Thirty days allow reusing an announcement; older ones have no use.",
	},
	DeviceCredentials: {
		Trigger: privacy.TriggerExpiredAt, PeriodDays: 0, Action: privacy.ActionDelete,
		Purpose: "Connect devices and services", LegalBasis: basisSecurity, Reason: "An expired or revoked credential has no use.",
	},
	ActorReferences: {
		Trigger: privacy.TriggerAccountClosedAt, PeriodDays: 0, Action: privacy.ActionUnlink,
		Purpose: "Record who changed a record", LegalBasis: basisInterest,
		Reason: "The records stay; who changed them is removed with the account.",
	},
	PrivacyRecords: {
		Trigger: privacy.TriggerCompletedAt, PeriodDays: threeYears, Action: privacy.ActionDelete,
		Purpose: "Prove how data-subject requests were answered", LegalBasis: "Art. 6(1)(c) GDPR with Art. 5(2) and Art. 12 GDPR: accountability",
		Reason: "Proof of the answer until claims under § 1489 ABGB are time-barred.",
	},
	ConfigurationContacts: {
		Trigger: privacy.TriggerLastUsedAt, PeriodDays: threeYears, Action: privacy.ActionRetainWithReview,
		Purpose: "Send mail and invoices", LegalBasis: basisInterest,
		Reason: "Review addresses that were not used for three years.",
	},
}
