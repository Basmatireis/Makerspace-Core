// Package privacycatalog declares the data categories of the built-in
// modules: which columns hold personal data, which module owns them, which
// retention triggers and actions the data supports, and how the installation
// handled the data before the privacy registry existed. It holds declarations
// only; retention handlers live with the owning modules.
package privacycatalog

import (
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
)

// Category identifiers.
const (
	PeopleIdentity         privacy.CategoryID = "people.identity"
	AccountsCredentials    privacy.CategoryID = "accounts.credentials"
	AuthSessions           privacy.CategoryID = "auth.sessions"
	AuthPendingState       privacy.CategoryID = "auth.pending_state"
	SCIMMappings           privacy.CategoryID = "scim.mappings"
	AttendanceVisits       privacy.CategoryID = "attendance.visits"
	SurveyInvitations      privacy.CategoryID = "surveys.invitations"
	SurveyResponses        privacy.CategoryID = "surveys.responses"
	EventExternalSignups   privacy.CategoryID = "events.external_signups"
	EventContent           privacy.CategoryID = "events.content"
	OpenDayAssignments     privacy.CategoryID = "opendays.assignments"
	TrainingRecords        privacy.CategoryID = "trainings.records"
	LabRulesRequests       privacy.CategoryID = "laborordnung.requests"
	AuditEvents            privacy.CategoryID = "audit.events"
	OrdersFinancialRecords privacy.CategoryID = "orders.financial_records"
	OrdersIdempotency      privacy.CategoryID = "orders.idempotency"
	OrganizationContacts   privacy.CategoryID = "organizations.contacts"
	MachineJobs            privacy.CategoryID = "machinelogbook.jobs"
	InventoryNotes         privacy.CategoryID = "machinelogbook.inventory"
	PrintArtifacts         privacy.CategoryID = "printing.artifacts"
	PrinterTelemetry       privacy.CategoryID = "printing.telemetry"
	RunTimelapses          privacy.CategoryID = "runrecordings.timelapses"
	InboxNotifications     privacy.CategoryID = "inbox.notifications"
	SignageAnnouncements   privacy.CategoryID = "signage.announcements"
	DeviceCredentials      privacy.CategoryID = "devices.credentials" //nolint:gosec // a category identifier, not a credential
	ActorReferences        privacy.CategoryID = "platform.actor_references"
	FileBlobs              privacy.CategoryID = "files.blobs"
	ConfigurationContacts  privacy.CategoryID = "configuration.contacts"
	PrivacyRecords         privacy.CategoryID = "privacy.records"
)

// Owner modules: the built-in feature areas that own data categories.
const (
	Identity     privacy.ModuleID = "identity"
	Platform     privacy.ModuleID = "platform"
	Laborordnung privacy.ModuleID = "laborordnung"
	Attendance   privacy.ModuleID = "attendance"
	Trainings    privacy.ModuleID = "trainings"
	OpenDays     privacy.ModuleID = "open_days"
	Events       privacy.ModuleID = "events"
	Orders       privacy.ModuleID = "orders"
	Machines     privacy.ModuleID = "machines"
	Signage      privacy.ModuleID = "signage"
)

const day = 24 * time.Hour

// Catalog returns the validated privacy catalog.
func Catalog() (*privacy.Catalog, error) {
	return privacy.NewCatalog(Definitions()...)
}

// Definitions lists every built-in data category.
func Definitions() []privacy.Definition {
	return []privacy.Definition{
		{
			ID: PeopleIdentity, Owner: Identity, Name: "Person records",
			Description: "Names, contact details, matriculation numbers, membership start, profile images and role assignments of people.",
			Fields: []string{
				"people.first_name", "people.last_name", "people.email", "people.phone", "people.matriculation_number",
				"people.member_since", "people.profile_image_file_id", "people.profile_image_source", "people.photo_reference",
				"person_roles.person_id", "accounts.person_id",
			},
			Triggers: []privacy.Trigger{privacy.TriggerAccountClosedAt, privacy.TriggerLastUsedAt},
			Actions:  []privacy.Action{privacy.ActionRetainWithReview, privacy.ActionDelete},
			Subject:  privacy.SubjectPerson,
			RetentionNote: "Deleting a person hard-deletes the record and cascades its account, visits and assignments; " +
				"financial snapshots and audit identifiers stay.",
		},
		{
			ID: AccountsCredentials, Owner: Identity, Name: "Account credentials",
			Description: "Login identities, password and PIN hashes, authenticator secrets, recovery codes and passkeys.",
			Fields: []string{
				"auth_identities.identifier_display", "auth_identities.identifier_normalized", "auth_identities.subject",
				"auth_identities.issuer", "password_credentials.password_hash", "pin_credentials.pin_hash",
				"mfa_totp_credentials.secret_ciphertext", "mfa_recovery_codes.code_digest", "webauthn_credentials.*",
			},
			Triggers: []privacy.Trigger{privacy.TriggerAccountClosedAt},
			Actions:  []privacy.Action{privacy.ActionDelete},
			Subject:  privacy.SubjectAccount,
		},
		{
			ID: AuthSessions, Owner: Identity, Name: "Sessions and sign-in state",
			Description: "Session and CSRF digests, password-reset tokens, delivery addresses and codes of sign-in challenges, and throttle keys.",
			Fields: []string{
				"sessions.token_digest", "sessions.csrf_digest", "password_reset_tokens.token_digest",
				"auth_challenges.delivery_address", "auth_challenges.code_digest", "auth_rate_limits.key_digest",
				"pin_login_throttles.key_digest",
			},
			Triggers: []privacy.Trigger{privacy.TriggerExpiredAt},
			Actions:  []privacy.Action{privacy.ActionDelete},
			Subject:  privacy.SubjectAccount,
			Legacy:   &privacy.LegacyDefault{Trigger: privacy.TriggerExpiredAt, Period: 0, Action: privacy.ActionDelete, Source: "admin cleanup (code)"},
		},
		{
			ID: AuthPendingState, Owner: Identity, Name: "Pending sign-in and enrollment state",
			Description: "Pending second-factor logins, passkey challenges, OIDC flows and kiosk enrollment contexts that expired.",
			Fields: []string{
				"pending_logins.token_digest", "webauthn_challenges.*", "oidc_flows.*", "visitor_enrollment_contexts.*",
			},
			Triggers:      []privacy.Trigger{privacy.TriggerExpiredAt},
			Actions:       []privacy.Action{privacy.ActionDelete},
			Subject:       privacy.SubjectAccount,
			RetentionNote: "Not pruned by any routine before the privacy registry.",
		},
		{
			ID: SCIMMappings, Owner: Identity, Name: "SCIM provisioning mappings",
			Description: "External identifiers and provisioning data of people managed by a SCIM connector; they block deletion until deprovisioned.",
			Fields: []string{
				"scim_users.person_id", "scim_users.external_id", "scim_users.user_name", "scim_users.provisioning_data",
				"scim_connector_tokens.token_digest",
			},
			Triggers: []privacy.Trigger{privacy.TriggerAccountClosedAt},
			Actions:  []privacy.Action{privacy.ActionRetainWithReview},
			Subject:  privacy.SubjectPerson,
		},
		{
			ID: AttendanceVisits, Owner: Attendance, Name: "Visits and holds",
			Description: "Who was in the lab when, including kiosk check-ins, corrections and admission holds.",
			Fields:      []string{"visits.*", "attendance_holds.*"},
			Triggers:    []privacy.Trigger{privacy.TriggerCompletedAt},
			Actions:     []privacy.Action{privacy.ActionAnonymize, privacy.ActionDelete},
			Subject:     privacy.SubjectPerson,
			Legacy:      &privacy.LegacyDefault{Trigger: privacy.TriggerCompletedAt, Period: 90 * day, Action: privacy.ActionAnonymize, Source: "admin cleanup (code)"},
			RetentionNote: "Completed visits are rolled into non-identifying daily aggregates before their detail is deleted; " +
				"open visits are never removed.",
		},
		{
			ID: SurveyInvitations, Owner: Attendance, Name: "Survey invitations",
			Description: "Delivery identity of post-visit survey invitations: recipient address and the link to person and visit.",
			Fields:      []string{"survey_invitations.recipient_email", "survey_invitations.person_id", "survey_invitations.visit_id", "survey_invitations.token_digest"},
			Triggers:    []privacy.Trigger{privacy.TriggerExpiredAt},
			Actions:     []privacy.Action{privacy.ActionUnlink, privacy.ActionDelete},
			Subject:     privacy.SubjectPerson,
			Legacy:      &privacy.LegacyDefault{Trigger: privacy.TriggerExpiredAt, Period: 7 * day, Action: privacy.ActionUnlink, Source: "admin cleanup (code)"},
		},
		{
			ID: SurveyResponses, Owner: Attendance, Name: "Survey responses",
			Description: "Identified survey responses and free-text answers.",
			Fields:      []string{"survey_responses.identified_person_id", "survey_answers.text_value"},
			Triggers:    []privacy.Trigger{privacy.TriggerCreatedAt},
			Actions:     []privacy.Action{privacy.ActionUnlink, privacy.ActionRetainWithReview},
			Subject:     privacy.SubjectPerson,
		},
		{
			ID: EventExternalSignups, Owner: Events, Name: "External event sign-ups",
			Description: "Name and contact snapshots of external people who signed up for an event shift, with their management token.",
			Fields: []string{
				"event_shift_assignments.first_name_snapshot", "event_shift_assignments.last_name_snapshot",
				"event_shift_assignments.email_snapshot", "event_shift_assignments.email_normalized",
				"event_shift_assignments.phone_snapshot", "event_shift_assignments.phone_normalized",
				"event_shift_assignments.management_token_digest", "event_shift_assignments.person_id",
			},
			Triggers: []privacy.Trigger{privacy.TriggerCompletedAt, privacy.TriggerCancelledAt},
			Actions:  []privacy.Action{privacy.ActionRedact},
			Subject:  privacy.SubjectPerson,
			Legacy: &privacy.LegacyDefault{
				Trigger: privacy.TriggerCompletedAt, Period: 180 * day, Action: privacy.ActionRedact,
				Source: "EVENT_SIGNUP_RETENTION", ZeroDisables: true,
			},
		},
		{
			ID: EventContent, Owner: Events, Name: "Event planning content",
			Description: "Event owners, task assignees and free-text descriptions.",
			Fields:      []string{"events.owner_person_id", "events.internal_description", "event_tasks.assignee_person_id", "event_tasks.title", "event_tasks.description"},
			Triggers:    []privacy.Trigger{privacy.TriggerCompletedAt},
			Actions:     []privacy.Action{privacy.ActionRetainWithReview},
			Subject:     privacy.SubjectPerson,
		},
		{
			ID: OpenDayAssignments, Owner: OpenDays, Name: "Open day assignments",
			Description: "Who staffed which open day.",
			Fields:      []string{"open_day_assignments.person_id"},
			Triggers:    []privacy.Trigger{privacy.TriggerCompletedAt},
			Actions:     []privacy.Action{privacy.ActionRetainWithReview},
			Subject:     privacy.SubjectPerson,
		},
		{
			ID: TrainingRecords, Owner: Trainings, Name: "Training records",
			Description: "Training status per person with internal notes.",
			Fields:      []string{"training_records.person_id", "training_records.notes", "training_records.completed_on"},
			Triggers:    []privacy.Trigger{privacy.TriggerAccountClosedAt},
			Actions:     []privacy.Action{privacy.ActionRetainWithReview},
			Subject:     privacy.SubjectPerson,
		},
		{
			ID: LabRulesRequests, Owner: Laborordnung, Name: "Lab Rules confirmations",
			Description: "Physical document references, signed dates and archive notes of Lab Rules confirmations.",
			Fields:      []string{"laborordnung_requests.person_id", "laborordnung_requests.physical_document_reference", "laborordnung_requests.signed_date", "laborordnung_requests.archive_note"},
			Triggers:    []privacy.Trigger{privacy.TriggerAccountClosedAt, privacy.TriggerLegalPeriodEnd},
			Actions:     []privacy.Action{privacy.ActionRetainWithReview},
			Subject:     privacy.SubjectPerson,
		},
		{
			ID: AuditEvents, Owner: Platform, Name: "Audit events",
			Description: "Who did what when, as identifiers and changed field names only.",
			Fields:      []string{"audit_events.*"},
			Triggers:    []privacy.Trigger{privacy.TriggerCreatedAt},
			Actions:     []privacy.Action{privacy.ActionDelete, privacy.ActionRetainWithReview},
			Subject:     privacy.SubjectAccount,
			Legacy: &privacy.LegacyDefault{
				Trigger: privacy.TriggerCreatedAt, Period: 365 * day, Action: privacy.ActionDelete,
				Source: "AUDIT_RETENTION", ZeroDisables: true,
			},
		},
		{
			ID: OrdersFinancialRecords, Owner: Orders, Name: "Financial records",
			Description: "Orders, their customer snapshots, payments, cash movements and invoice requests with recipient and service details.",
			Fields: []string{
				"orders.customer_person_id", "order_customer_snapshots.display_name", "order_items.description",
				"order_items.machine_job_snapshot", "order_adjustments.reason", "payments.reason", "payments.external_reference",
				"cash_movements.reason", "cash_movements.note", "cash_movements.recorded_by_person_id",
				"external_invoice_request_details.*", "external_invoice_request_events.reason",
				"external_invoice_request_events.external_reference",
			},
			Triggers: []privacy.Trigger{privacy.TriggerLegalPeriodEnd},
			Actions:  []privacy.Action{privacy.ActionRetainWithReview},
			Subject:  privacy.SubjectPerson,
			RetentionNote: "Immutable by database triggers; person links detach on deletion, text snapshots stay until a " +
				"reviewed legal retention period ends.",
		},
		{
			ID: OrdersIdempotency, Owner: Orders, Name: "Idempotency evidence",
			Description: "Operation keys and request fingerprints that make financial commands safe to retry.",
			Fields:      []string{"order_operations.*"},
			Triggers:    []privacy.Trigger{privacy.TriggerCreatedAt},
			Actions:     []privacy.Action{privacy.ActionDelete, privacy.ActionRetainWithReview},
			Subject:     privacy.SubjectAccount,
		},
		{
			ID: OrganizationContacts, Owner: Machines, Name: "Organization contacts",
			Description: "Contact and address details of billing organizations and their associated people.",
			Fields: []string{
				"organizations.contact_name", "organizations.contact_email", "organizations.address_line",
				"organizations.postal_code", "organizations.locality", "organization_members.person_id",
			},
			Triggers: []privacy.Trigger{privacy.TriggerLastUsedAt},
			Actions:  []privacy.Action{privacy.ActionRetainWithReview},
			Subject:  privacy.SubjectPerson,
		},
		{
			ID: MachineJobs, Owner: Machines, Name: "Machine jobs and runs",
			Description: "Customer and operator links, job titles and notes, and file names of recorded runs.",
			Fields: []string{
				"machine_jobs.customer_person_id", "machine_jobs.operator_person_id", "machine_jobs.title",
				"machine_jobs.notes", "machine_jobs.price_adjustment_reason", "machine_runs.file_name", "machine_runs.vendor_job_id",
			},
			Triggers: []privacy.Trigger{privacy.TriggerCompletedAt},
			Actions:  []privacy.Action{privacy.ActionRedact, privacy.ActionRetainWithReview},
			Subject:  privacy.SubjectPerson,
			RetentionNote: "Jobs with recorded material consumption cannot be hard-deleted; free text can be redacted and " +
				"person links detach on deletion.",
		},
		{
			ID: InventoryNotes, Owner: Machines, Name: "Inventory ledger notes",
			Description: "Supplier, purchase reference and notes on inventory transactions.",
			Fields:      []string{"inventory_transactions.note", "inventory_transactions.supplier", "inventory_transactions.purchase_reference"},
			Triggers:    []privacy.Trigger{privacy.TriggerLegalPeriodEnd},
			Actions:     []privacy.Action{privacy.ActionRetainWithReview},
			Subject:     privacy.SubjectNone,
		},
		{
			ID: PrintArtifacts, Owner: Machines, Name: "Print files and previews",
			Description:   "3MF files with their embedded metadata and the preview images generated from them.",
			Fields:        []string{"print_artifacts.*", "print_artifact_previews.*"},
			Triggers:      []privacy.Trigger{privacy.TriggerCompletedAt},
			Actions:       []privacy.Action{privacy.ActionDelete, privacy.ActionRetainWithReview},
			Subject:       privacy.SubjectNone,
			RetentionNote: "No deletion routine existed before the privacy registry.",
		},
		{
			ID: PrinterTelemetry, Owner: Machines, Name: "Printer telemetry",
			Description: "Printer events, live status snapshots, error context and connector activity.",
			Fields:      []string{"printer_events.*", "printer_live_statuses.*", "printer_error_occurrences.*", "printer_connector_activity.*"},
			Triggers:    []privacy.Trigger{privacy.TriggerCreatedAt},
			Actions:     []privacy.Action{privacy.ActionDelete},
			Subject:     privacy.SubjectNone,
			Legacy:      &privacy.LegacyDefault{Trigger: privacy.TriggerCreatedAt, Period: 30 * day, Action: privacy.ActionDelete, Source: "lazy prune of connector activity (code)"},
		},
		{
			ID: RunTimelapses, Owner: Machines, Name: "Run timelapses",
			Description: "Timelapse videos of recorded runs.",
			Fields:      []string{"machine_run_timelapses.*"},
			Triggers:    []privacy.Trigger{privacy.TriggerCreatedAt},
			Actions:     []privacy.Action{privacy.ActionDelete},
			Subject:     privacy.SubjectNone,
			Legacy: &privacy.LegacyDefault{
				Trigger: privacy.TriggerCreatedAt, Period: 90 * day, Action: privacy.ActionDelete,
				Source: "run_recording_settings.timelapse_retention_days", ZeroDisables: true,
			},
		},
		{
			ID: InboxNotifications, Owner: Platform, Name: "In-app notifications",
			Description: "Notification titles, bodies and who received and read them.",
			Fields:      []string{"inbox_notifications.*", "inbox_recipients.*"},
			Triggers:    []privacy.Trigger{privacy.TriggerCreatedAt},
			Actions:     []privacy.Action{privacy.ActionDelete},
			Subject:     privacy.SubjectAccount,
			Legacy:      &privacy.LegacyDefault{Trigger: privacy.TriggerCreatedAt, Period: 90 * day, Action: privacy.ActionDelete, Source: "lazy sweep on read (code)"},
		},
		{
			ID: SignageAnnouncements, Owner: Signage, Name: "Signage announcements",
			Description: "Announcement texts shown on displays.",
			Fields:      []string{"signage_announcements.*", "signage_announcement_values.*"},
			Triggers:    []privacy.Trigger{privacy.TriggerEndedAt},
			Actions:     []privacy.Action{privacy.ActionDelete},
			Subject:     privacy.SubjectNone,
			Legacy:      &privacy.LegacyDefault{Trigger: privacy.TriggerEndedAt, Period: 30 * day, Action: privacy.ActionDelete, Source: "lazy sweep on read (code)"},
		},
		{
			ID: DeviceCredentials, Owner: Platform, Name: "Device and service credentials",
			Description: "Token digests of managed devices, printer connectors, streaming gateways and signage displays.",
			Fields: []string{
				"managed_devices.token_digest", "printer_connector_credentials.*", "printer_connector_enrollments.*",
				"streaming_gateway_credentials.*", "streaming_gateway_enrollments.*", "signage_pairing_requests.*",
				"signage_display_states.*",
			},
			Triggers: []privacy.Trigger{privacy.TriggerExpiredAt},
			Actions:  []privacy.Action{privacy.ActionDelete},
			Subject:  privacy.SubjectNone,
		},
		{
			ID: ActorReferences, Owner: Platform, Name: "Actor references",
			Description: "Columns that name the account which created or changed a record; they become NULL when the account is deleted.",
			Fields: []string{
				"privacy_settings.updated_by_account_id", "privacy_policy_versions.created_by_account_id",
				"privacy_policy_versions.approved_by_account_id", "privacy_policy_versions.activated_by_account_id",
				"privacy_retention_holds.created_by_account_id", "privacy_retention_holds.released_by_account_id",
				"privacy_retention_runs.actor_account_id",
			},
			Triggers: []privacy.Trigger{privacy.TriggerAccountClosedAt},
			Actions:  []privacy.Action{privacy.ActionUnlink},
			Subject:  privacy.SubjectAccount,
		},
		{
			ID: FileBlobs, Owner: Platform, Name: "Stored files",
			Description:   "File rows with the original file names clients supplied, and the private objects behind them.",
			Fields:        []string{"files.original_filename", "files.created_by_account_id", "file_blob_deletions.*"},
			Triggers:      []privacy.Trigger{privacy.TriggerCreatedAt},
			Actions:       []privacy.Action{privacy.ActionDelete},
			Subject:       privacy.SubjectNone,
			RetentionNote: "Files are deleted with the record that references them; queued blob deletions are drained by the scheduler.",
		},
		{
			ID: PrivacyRecords, Owner: Platform, Name: "Privacy registry records",
			Description:   "Retention holds naming a person, retention runs and, later, data-subject requests of the privacy registry itself.",
			Fields:        []string{"privacy_retention_holds.subject_person_id", "privacy_retention_holds.reason", "privacy_retention_run_items.*"},
			Triggers:      []privacy.Trigger{privacy.TriggerCompletedAt},
			Actions:       []privacy.Action{privacy.ActionRetainWithReview, privacy.ActionDelete},
			Subject:       privacy.SubjectPerson,
			RetentionNote: "Runs and released holds are evidence of what retention did; keep them as long as the audit log.",
		},
		{
			ID: ConfigurationContacts, Owner: Platform, Name: "Configured contact addresses",
			Description: "Sender, recipient and reply-to addresses in email and invoicing settings.",
			Fields: []string{
				"mail_configuration.from_address", "mail_configuration.smtp_username", "wiref_delivery_settings.recipient_email",
				"wiref_delivery_settings.cc_emails", "wiref_delivery_settings.reply_to_email",
			},
			Triggers: []privacy.Trigger{privacy.TriggerLastUsedAt},
			Actions:  []privacy.Action{privacy.ActionRetainWithReview},
			Subject:  privacy.SubjectNone,
		},
	}
}
