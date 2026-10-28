package privacycatalog

import (
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
)

func TestCatalogIsValid(t *testing.T) {
	if _, err := Catalog(); err != nil {
		t.Fatal(err)
	}
}

// personalDataColumns is the inventory of columns that hold personal data,
// secrets or digests (from the Phase 0 data inventory). Every one of them must
// belong to exactly one category; extend this list with every migration that
// adds such a column.
var personalDataColumns = []string{
	"people.first_name", "people.last_name", "people.email", "people.phone", "people.matriculation_number",
	"people.profile_image_file_id", "people.photo_reference",
	"auth_identities.identifier_display", "auth_identities.identifier_normalized", "auth_identities.subject",
	"password_credentials.password_hash", "pin_credentials.pin_hash",
	"sessions.token_digest", "sessions.csrf_digest", "password_reset_tokens.token_digest",
	"auth_challenges.delivery_address", "auth_challenges.code_digest", "auth_rate_limits.key_digest",
	"pin_login_throttles.key_digest", "pending_logins.token_digest", "webauthn_challenges.challenge_digest",
	"webauthn_credentials.credential_id", "mfa_totp_credentials.secret_ciphertext", "mfa_recovery_codes.code_digest",
	"oidc_flows.state_digest", "scim_users.external_id", "scim_users.user_name", "scim_users.provisioning_data",
	"scim_connector_tokens.token_digest", "visitor_enrollment_contexts.token_digest",
	"visits.person_id", "attendance_holds.person_id", "laborordnung_requests.physical_document_reference",
	"laborordnung_requests.archive_note", "open_day_assignments.person_id", "events.owner_person_id",
	"event_tasks.assignee_person_id", "event_shift_assignments.first_name_snapshot",
	"event_shift_assignments.email_snapshot", "event_shift_assignments.phone_snapshot",
	"event_shift_assignments.management_token_digest", "training_records.notes",
	"survey_invitations.recipient_email", "survey_invitations.token_digest", "survey_responses.identified_person_id",
	"survey_answers.text_value", "inbox_notifications.body", "inbox_recipients.account_id",
	"orders.customer_person_id", "order_customer_snapshots.display_name", "order_items.description",
	"payments.reason", "payments.external_reference", "order_adjustments.reason", "cash_movements.note",
	"cash_movements.recorded_by_person_id", "external_invoice_request_details.recipient_name",
	"external_invoice_request_details.address_line1", "external_invoice_request_details.contact_name",
	"external_invoice_request_events.reason", "organizations.contact_name", "organizations.contact_email",
	"organization_members.person_id", "machine_jobs.customer_person_id", "machine_jobs.operator_person_id",
	"machine_jobs.notes", "machine_runs.file_name", "inventory_transactions.note", "inventory_transactions.supplier",
	"print_artifacts.metadata", "printer_events.payload", "printer_live_statuses.snapshot",
	"machine_run_timelapses.file_id", "signage_announcement_values.value", "managed_devices.token_digest",
	"files.original_filename", "audit_events.actor_account_id", "mail_configuration.from_address",
	"wiref_delivery_settings.recipient_email", "order_operations.request_fingerprint",
}

func TestEveryPersonalDataColumnBelongsToACategory(t *testing.T) {
	catalog, err := Catalog()
	if err != nil {
		t.Fatal(err)
	}
	for _, column := range personalDataColumns {
		if _, ok := catalog.Covers(column); !ok {
			t.Errorf("%s belongs to no data category", column)
		}
	}
	// Every foreign key to people is a person link that data-subject requests must find.
	for _, reference := range people.MergeReferences {
		if reference.Referenced != "people" {
			continue
		}
		field := reference.Table + "." + reference.Column
		if _, ok := catalog.Covers(field); !ok {
			t.Errorf("person reference %s belongs to no data category", field)
		}
	}
}

func TestLegacyDefaultsMatchTheRoutinesTheyReplace(t *testing.T) {
	want := map[string]string{
		string(AuditEvents):          "AUDIT_RETENTION",
		string(EventExternalSignups): "EVENT_SIGNUP_RETENTION",
		string(AttendanceVisits):     "admin cleanup (code)",
		string(SurveyInvitations):    "admin cleanup (code)",
		string(AuthSessions):         "admin cleanup (code)",
		string(RunTimelapses):        "run_recording_settings.timelapse_retention_days",
	}
	for _, definition := range Definitions() {
		source, expected := want[string(definition.ID)]
		if !expected {
			continue
		}
		if definition.Legacy == nil || definition.Legacy.Source != source {
			t.Errorf("%s: legacy source = %+v, want %q", definition.ID, definition.Legacy, source)
		}
	}
}
