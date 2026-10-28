-- Read model of the configuration export and import. Every write goes through the owning feature's service, so
-- these queries only read. They run inside the import transaction, which is why they do not reuse the services'
-- pool-bound list methods. Orderings are by natural key so exports are stable.

-- name: ListDeviceTypes :many
SELECT id, name, description, version FROM device_types ORDER BY lower(name), id;

-- name: DeviceTypeInUse :one
SELECT (
    EXISTS (SELECT 1 FROM managed_devices md WHERE md.device_type_id = sqlc.arg(id))
    OR EXISTS (SELECT 1 FROM role_permission_grant_device_types gd WHERE gd.device_type_id = sqlc.arg(id))
    OR EXISTS (SELECT 1 FROM visitor_enrollment_device_types vd WHERE vd.device_type_id = sqlc.arg(id))
)::boolean AS in_use;

-- name: ListSessionPolicies :many
SELECT id, name, idle_timeout_seconds, absolute_lifetime_seconds, post_session_destination, is_default, version
FROM session_policies
ORDER BY lower(name), id;

-- name: ListRoles :many
SELECT id, name, description, system_key, profile_image_required, laborordnung_mode, staffing_level,
    min_open_days_per_semester, version
FROM roles
ORDER BY lower(name), id;

-- name: ListRolePermissionGrants :many
SELECT g.role_id, g.id, g.permission_id, g.scope, g.minimum_assurance, g.reauth_within_minutes, dt.name AS device_type_name
FROM role_permission_grants g
LEFT JOIN role_permission_grant_device_types gdt ON gdt.grant_id = g.id
LEFT JOIN device_types dt ON dt.id = gdt.device_type_id
ORDER BY g.role_id, g.permission_id, g.scope, g.minimum_assurance, g.id, lower(dt.name);

-- name: RoleInUse :one
-- A role in use is kept by an overwrite: deleting it would silently take it away from people or requirements.
SELECT (
    EXISTS (SELECT 1 FROM person_roles pr WHERE pr.role_id = sqlc.arg(id))
    OR EXISTS (SELECT 1 FROM visitor_enrollment_configuration vc WHERE vc.initial_role_id = sqlc.arg(id))
    OR EXISTS (SELECT 1 FROM event_shift_requirement_roles er WHERE er.role_id = sqlc.arg(id))
    OR EXISTS (SELECT 1 FROM open_day_staff_requirement_roles orr WHERE orr.role_id = sqlc.arg(id))
)::boolean AS in_use;

-- name: ListMachineTypes :many
SELECT id, name, process, active, version FROM machine_types ORDER BY lower(name), id;

-- name: ListMachines :many
SELECT m.id, m.name, t.name AS machine_type_name, m.status, m.external_identifier, m.automatic_collection_enabled,
    m.version
FROM machines m
JOIN machine_types t ON t.id = m.machine_type_id
ORDER BY lower(m.name), m.id;

-- name: MachineInUse :one
-- Machines with history, connector assignments, cameras or mounted spools are retired instead of deleted.
SELECT (
    EXISTS (SELECT 1 FROM machine_jobs j WHERE j.machine_id = sqlc.arg(id))
    OR EXISTS (SELECT 1 FROM machine_runs mr WHERE mr.machine_id = sqlc.arg(id))
    OR EXISTS (SELECT 1 FROM printer_connector_assignments ca WHERE ca.machine_id = sqlc.arg(id))
    OR EXISTS (SELECT 1 FROM printer_events pe WHERE pe.machine_id = sqlc.arg(id))
    OR EXISTS (SELECT 1 FROM printer_error_occurrences eo WHERE eo.machine_id = sqlc.arg(id))
    OR EXISTS (SELECT 1 FROM streaming_cameras sc WHERE sc.machine_id = sqlc.arg(id))
    OR EXISTS (
        SELECT 1 FROM printer_spool_assignments a
        JOIN printer_slots s ON s.id = a.slot_id
        JOIN printer_input_units u ON u.id = s.input_unit_id
        WHERE u.machine_id = sqlc.arg(id)
    )
)::boolean AS in_use;

-- name: ListPrinterProfiles :many
SELECT machine_id, enabled, model, version FROM printer_profiles ORDER BY machine_id;

-- name: ListPrinterInputUnits :many
SELECT id, machine_id, name, position, nozzle, external_identifier, enabled
FROM printer_input_units
ORDER BY machine_id, position, id;

-- name: ListPrinterSlots :many
SELECT id, input_unit_id, name, position, external_identifier, status
FROM printer_slots
ORDER BY input_unit_id, position, id;

-- name: ListMaterialTypes :many
SELECT t.id, t.name, t.kind, t.unit, t.active, t.version,
    COALESCE(
        (SELECT array_agg(p.process ORDER BY p.process) FROM material_type_processes p WHERE p.material_type_id = t.id),
        '{}'
    )::text[] AS processes
FROM material_types t
ORDER BY lower(t.name), t.id;

-- name: ListMaterials :many
SELECT m.id, m.name, t.name AS material_type_name, m.active, m.low_stock_threshold,
    m.color_name, m.color_hex, m.variant, m.manufacturer, m.sale_price,
    m.package_size, m.storage_location, m.notes, fp.diameter_mm AS filament_diameter_mm,
    m.version
FROM materials m
JOIN material_types t ON t.id = m.material_type_id
LEFT JOIN material_filament_properties fp ON fp.material_id = m.id
ORDER BY lower(m.name), m.id;

-- name: ListPricingGroups :many
SELECT id, name, description, active, is_default, version FROM pricing_groups ORDER BY lower(name), id;

-- name: ListActivePricingRules :many
SELECT r.id, r.pricing_group_id, r.kind, mt.name AS machine_type_name, mat.name AS material_type_name,
    r.measure, r.rate, r.machine_type_id, r.material_type_id, r.version
FROM pricing_rules r
LEFT JOIN machine_types mt ON mt.id = r.machine_type_id
LEFT JOIN material_types mat ON mat.id = r.material_type_id
WHERE r.active
ORDER BY r.pricing_group_id, r.kind, lower(COALESCE(mt.name, mat.name)), r.measure, r.id;

-- name: ListRolePricingGroups :many
SELECT r.id AS role_id, r.name AS role_name, g.id AS pricing_group_id, g.name AS pricing_group_name, rpg.priority
FROM role_pricing_groups rpg
JOIN roles r ON r.id = rpg.role_id
JOIN pricing_groups g ON g.id = rpg.pricing_group_id
ORDER BY rpg.priority DESC, r.id;

-- name: GetOpenDayRequirements :one
SELECT o.min_open_days_per_semester, o.trainee_open_days_for_promotion, o.supervisor_role_id,
    r.name AS supervisor_role_name, o.version
FROM open_day_requirements o
LEFT JOIN roles r ON r.id = o.supervisor_role_id;

-- name: GetVisitorEnrollmentConfiguration :one
SELECT c.enabled, c.initial_role_id, r.name AS initial_role_name, c.allowed_methods, c.version
FROM visitor_enrollment_configuration c
LEFT JOIN roles r ON r.id = c.initial_role_id;

-- name: ListVisitorEnrollmentDeviceTypes :many
SELECT dt.id, dt.name
FROM visitor_enrollment_device_types v
JOIN device_types dt ON dt.id = v.device_type_id
ORDER BY lower(dt.name), dt.id;

-- name: GetBrandingConfiguration :one
SELECT * FROM branding_configuration;

-- name: ListBrandingAssetOverrides :many
SELECT o.slot, o.mode, o.file_id, f.original_filename, f.content_type,
    f.sha256
FROM branding_asset_overrides o
LEFT JOIN files f ON f.id = o.file_id
ORDER BY o.slot;

-- name: ListLabRulesVersions :many
SELECT v.id, v.human_revision, v.status, v.effective_at, v.pdf_sha256, v.pdf_file_id, f.original_filename
FROM laborordnung_versions v
JOIN files f ON f.id = v.pdf_file_id
ORDER BY lower(v.human_revision), v.id;

-- name: GetCurrentLabRulesEffectiveAt :one
-- The export carries the version in force and every later published one; older versions are evidence only.
SELECT effective_at
FROM laborordnung_versions
WHERE status = 'published' AND effective_at <= now()
ORDER BY effective_at DESC, id DESC
LIMIT 1;

-- name: ListSurveys :many
SELECT s.id, s.name, s.description, s.status, s.anonymous, s.version, sv.id AS survey_version_id, sv.title,
    sv.introduction
FROM surveys s
JOIN LATERAL (
    SELECT * FROM survey_versions WHERE survey_id = s.id ORDER BY revision DESC LIMIT 1
) sv ON true
ORDER BY lower(s.name), s.id;

-- name: ListSurveyQuestions :many
SELECT id, survey_version_id, kind, prompt, required, position, rating_min, rating_max
FROM survey_questions
WHERE survey_version_id = ANY(sqlc.arg(version_ids)::uuid[])
ORDER BY survey_version_id, position;

-- name: ListSurveyOptions :many
SELECT o.question_id, o.label, o.position
FROM survey_question_options o
JOIN survey_questions q ON q.id = o.question_id
WHERE q.survey_version_id = ANY(sqlc.arg(version_ids)::uuid[])
ORDER BY o.question_id, o.position;

-- name: ListSurveyTriggers :many
SELECT survey_id, enabled, delay_seconds, cooldown_days, version
FROM survey_triggers
WHERE kind = 'visit_checked_out'
ORDER BY survey_id;

-- name: GetMailConfiguration :one
-- The encrypted SMTP password is never selected; only whether one is stored.
SELECT enabled, smtp_host, smtp_port, smtp_tls_mode, smtp_username, from_address, from_name, base_url, version,
    (encrypted_smtp_password IS NOT NULL AND octet_length(encrypted_smtp_password) > 0)::boolean AS password_configured
FROM mail_configuration;

-- name: GetWirefDeliverySettings :one
SELECT enabled, recipient_email, cc_emails, reply_to_email, mail_subject, mail_intro, mail_closing, pdf_title, pdf_intro, pdf_closing,
    show_contact_person, show_approver, show_purchase_order, show_service_period, show_service_description, version
FROM wiref_delivery_settings WHERE singleton = true;

-- name: ListCompetencyCategories :many
SELECT c.id, c.name, c.description, c.active, c.sort_order, c.version,
       (SELECT count(*) FROM training_competencies tc WHERE tc.competency_id = c.id)::bigint AS training_count
FROM competency_categories c ORDER BY lower(c.name), c.id;

-- name: ListTrainings :many
-- Trainings with their competency and machine type names, the natural keys the file uses.
SELECT t.id, t.name, t.description, t.active, t.sort_order, t.version,
       (SELECT count(*) FROM training_records r WHERE r.training_id = t.id)::bigint AS record_count,
       ARRAY(SELECT c.name FROM training_competencies tc JOIN competency_categories c ON c.id = tc.competency_id
             WHERE tc.training_id = t.id ORDER BY lower(c.name))::text[] AS competencies,
       ARRAY(SELECT m.name FROM training_machine_types tm JOIN machine_types m ON m.id = tm.machine_type_id
             WHERE tm.training_id = t.id ORDER BY lower(m.name))::text[] AS machine_types
FROM trainings t ORDER BY lower(t.name), t.id;

-- Privacy: the controller, every retention decision that is not retired, and the record of processing activities.

-- name: GetPrivacySettingsForTransfer :one
SELECT controller_name, controller_address, data_protection_contact, automatic_runs_enabled, run_interval_minutes, version
FROM privacy_settings;

-- name: ListTransferablePolicies :many
SELECT id, category_id, version, trigger, period_days, action, purpose, legal_basis, reason, status
FROM privacy_policy_versions WHERE status <> 'retired' ORDER BY category_id, version;

-- name: ListProcessingActivitiesForTransfer :many
SELECT id, name, purpose, legal_basis, category_ids, recipients, retention_note, version
FROM privacy_processing_activities ORDER BY lower(name), id;
