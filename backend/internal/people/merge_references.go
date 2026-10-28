package people

// MergeReference is a foreign-key column that references people(id) or accounts(id) and how a merge treats it.
// TestPeopleMergeHandlesEveryReference compares this list with the database, so a migration that adds such a
// column fails until the merge handles it here and in merge_execute.go.
type MergeReference struct {
	Table, Column, Referenced string
	Rule                      string
}

const (
	ruleMoved         = "moved to the target"
	ruleDeduplicated  = "moved to the target; duplicates resolved as documented"
	ruleConflict      = "moved to the target; more than one blocks the merge"
	ruleActor         = "re-pointed to the surviving account"
	ruleSecondFactor  = "moved to the surviving account"
	ruleTransient     = "deleted for every merged account"
	ruleSessions      = "revoked for every merged account; deleted with the source account"
	ruleSCIM          = "a SCIM-managed source blocks the merge; the target's mapping stays"
	ruleAttached      = "the first source account becomes the target's account when the target has none"
	ruleUnionedRoles  = "roles united on the target"
	ruleKeptIdentity  = "the chosen login email's identity moves to the surviving account; others are deleted"
	ruleInboxMoved    = "moved to the surviving account; duplicate deliveries dropped"
	ruleAuditRepoint  = "re-pointed to the surviving account (resource IDs of the merged person/account too)"
	ruleSurveyPreserv = "moved to the target; anonymous responses never carry a person"
)

// MergeReferences lists every handled reference column.
var MergeReferences = []MergeReference{
	{"accounts", "person_id", "people", ruleAttached},
	{"attendance_holds", "person_id", "people", ruleConflict},
	{"cash_movements", "recorded_by_person_id", "people", ruleMoved},
	{"event_shift_assignments", "person_id", "people", ruleDeduplicated},
	{"event_tasks", "assignee_person_id", "people", ruleMoved},
	{"events", "owner_person_id", "people", ruleMoved},
	{"external_invoice_request_details", "contact_person_id", "people", ruleMoved},
	{"external_invoice_request_details", "recipient_person_id", "people", ruleMoved},
	{"laborordnung_requests", "person_id", "people", ruleDeduplicated},
	{"machine_jobs", "customer_person_id", "people", ruleMoved},
	{"machine_jobs", "operator_person_id", "people", ruleMoved},
	{"open_day_assignments", "person_id", "people", ruleDeduplicated},
	{"orders", "customer_person_id", "people", ruleMoved},
	{"organization_members", "person_id", "people", ruleDeduplicated},
	{"person_roles", "person_id", "people", ruleUnionedRoles},
	{"scim_users", "person_id", "people", ruleSCIM},
	{"survey_invitations", "person_id", "people", ruleMoved},
	{"survey_responses", "identified_person_id", "people", ruleSurveyPreserv},
	{"training_records", "person_id", "people", ruleDeduplicated},
	{"visits", "person_id", "people", ruleConflict},

	{"attendance_holds", "checked_in_by_account_id", "accounts", ruleActor},
	{"audit_events", "actor_account_id", "accounts", ruleAuditRepoint},
	{"auth_challenges", "account_id", "accounts", ruleTransient},
	{"auth_challenges", "created_by_account_id", "accounts", ruleActor},
	{"auth_identities", "account_id", "accounts", ruleKeptIdentity},
	{"branding_asset_overrides", "updated_by_account_id", "accounts", ruleActor},
	{"branding_configuration", "updated_by_account_id", "accounts", ruleActor},
	{"event_shift_assignments", "cancelled_by_account_id", "accounts", ruleActor},
	{"event_shift_assignments", "conflict_overridden_by_account_id", "accounts", ruleActor},
	{"event_shift_assignments", "created_by_account_id", "accounts", ruleActor},
	{"event_tasks", "completed_by_account_id", "accounts", ruleActor},
	{"event_tasks", "created_by_account_id", "accounts", ruleActor},
	{"events", "created_by_account_id", "accounts", ruleActor},
	{"external_invoice_request_events", "actor_account_id", "accounts", ruleActor},
	{"files", "created_by_account_id", "accounts", ruleActor},
	{"inbox_notifications", "created_by_account_id", "accounts", ruleActor},
	{"inbox_recipients", "account_id", "accounts", ruleInboxMoved},
	{"inventory_transactions", "actor_account_id", "accounts", ruleActor},
	{"laborordnung_requests", "confirmed_by_account_id", "accounts", ruleActor},
	{"laborordnung_versions", "created_by_account_id", "accounts", ruleActor},
	{"machine_job_pricing_snapshots", "captured_by_account_id", "accounts", ruleActor},
	{"machine_jobs", "deleted_by", "accounts", ruleActor},
	{"machine_jobs", "price_adjusted_by_account_id", "accounts", ruleActor},
	{"machine_runs", "deleted_by", "accounts", ruleActor},
	{"mail_configuration", "updated_by_account_id", "accounts", ruleActor},
	{"mfa_recovery_codes", "account_id", "accounts", ruleSecondFactor},
	{"mfa_totp_credentials", "account_id", "accounts", ruleSecondFactor},
	{"oidc_flows", "account_id", "accounts", ruleTransient},
	{"open_day_assignments", "created_by_account_id", "accounts", ruleActor},
	{"open_day_requirements", "updated_by_account_id", "accounts", ruleActor},
	{"order_adjustments", "actor_account_id", "accounts", ruleActor},
	{"order_items", "created_by_account_id", "accounts", ruleActor},
	{"order_items", "removed_by_account_id", "accounts", ruleActor},
	{"order_operations", "actor_account_id", "accounts", ruleActor},
	{"orders", "created_by_account_id", "accounts", ruleActor},
	{"organization_invoicing_requirements", "updated_by_account_id", "accounts", ruleActor},
	{"organization_pricing_group_assignments", "assigned_by_account_id", "accounts", ruleActor},
	{"password_reset_tokens", "account_id", "accounts", ruleTransient},
	{"password_reset_tokens", "created_by_account_id", "accounts", ruleActor},
	{"payment_allocations", "actor_account_id", "accounts", ruleActor},
	{"payments", "actor_account_id", "accounts", ruleActor},
	{"pending_logins", "account_id", "accounts", ruleTransient},
	{"person_roles", "assigned_by_account_id", "accounts", ruleActor},
	{"privacy_policy_versions", "activated_by_account_id", "accounts", ruleActor},
	{"privacy_policy_versions", "approved_by_account_id", "accounts", ruleActor},
	{"privacy_policy_versions", "created_by_account_id", "accounts", ruleActor},
	{"privacy_retention_holds", "created_by_account_id", "accounts", ruleActor},
	{"privacy_retention_holds", "released_by_account_id", "accounts", ruleActor},
	{"privacy_retention_holds", "subject_person_id", "people", ruleMoved},
	{"privacy_subject_requests", "subject_person_id", "people", ruleMoved},
	{"privacy_retention_runs", "actor_account_id", "accounts", ruleActor},
	{"privacy_processing_activities", "updated_by_account_id", "accounts", ruleActor},
	{"privacy_settings", "updated_by_account_id", "accounts", ruleActor},
	{"privacy_subject_request_steps", "actor_account_id", "accounts", ruleActor},
	{"privacy_subject_requests", "approved_by_account_id", "accounts", ruleActor},
	{"privacy_subject_requests", "created_by_account_id", "accounts", ruleActor},
	{"privacy_subject_requests", "executed_by_account_id", "accounts", ruleActor},
	{"privacy_subject_requests", "identity_verified_by_account_id", "accounts", ruleActor},
	{"printer_connector_enrollments", "created_by_account_id", "accounts", ruleActor},
	{"printer_connectors", "events_cleared_by", "accounts", ruleActor},
	{"printer_discovery_requests", "requested_by_account_id", "accounts", ruleActor},
	{"printer_spool_assignments", "mounted_by_account_id", "accounts", ruleActor},
	{"printer_spool_assignments", "unmounted_by_account_id", "accounts", ruleActor},
	{"role_pricing_groups", "updated_by_account_id", "accounts", ruleActor},
	{"scim_connector_tokens", "created_by_account_id", "accounts", ruleActor},
	{"scim_users", "account_id", "accounts", ruleSCIM},
	{"second_factor_throttles", "account_id", "accounts", ruleTransient},
	{"sessions", "account_id", "accounts", ruleSessions},
	{"signage_announcements", "created_by_account_id", "accounts", ruleActor},
	{"signage_assets", "created_by_account_id", "accounts", ruleActor},
	{"signage_publications", "published_by_account_id", "accounts", ruleActor},
	{"streaming_gateway_enrollments", "created_by_account_id", "accounts", ruleActor},
	{"training_records", "recorded_by_account_id", "accounts", ruleActor},
	{"visitor_enrollment_configuration", "updated_by_account_id", "accounts", ruleActor},
	{"visits", "checked_in_by_account_id", "accounts", ruleActor},
	{"visits", "checked_out_by_account_id", "accounts", ruleActor},
	{"webauthn_challenges", "account_id", "accounts", ruleTransient},
	{"webauthn_credentials", "account_id", "accounts", ruleSecondFactor},
	{"wiref_delivery_settings", "updated_by_account_id", "accounts", ruleActor},
}
