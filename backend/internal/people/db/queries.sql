-- name: CreatePerson :one
INSERT INTO people (id, first_name, last_name, email, phone, matriculation_number, photo_reference, member_since)
VALUES (sqlc.arg(id), sqlc.arg(first_name), sqlc.arg(last_name), sqlc.narg(email), sqlc.narg(phone), sqlc.narg(matriculation_number), sqlc.narg(photo_reference), sqlc.arg(member_since))
RETURNING *;

-- name: GetPerson :one
SELECT * FROM people WHERE id = sqlc.arg(id);

-- name: GetPersonForUpdate :one
SELECT * FROM people WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: PersonHasAccount :one
SELECT EXISTS (SELECT 1 FROM accounts WHERE person_id = sqlc.arg(person_id));

-- name: GetPersonForDeletion :one
SELECT * FROM people WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: PersonHasSCIMProvisioning :one
SELECT EXISTS (SELECT 1 FROM scim_users WHERE person_id = sqlc.arg(person_id));

-- name: ListPeople :many
WITH current_laborordnung_version AS (
    SELECT id
    FROM laborordnung_versions
    WHERE status = 'published' AND effective_at <= now()
    ORDER BY effective_at DESC, id DESC
    LIMIT 1
)
SELECT p.*
FROM people p
LEFT JOIN accounts a ON a.person_id = p.id
LEFT JOIN current_laborordnung_version current_laborordnung ON true
LEFT JOIN LATERAL (
    SELECT CASE COALESCE(max(CASE r.laborordnung_mode WHEN 'blocking' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END), 0)
        WHEN 2 THEN 'blocking' WHEN 1 THEN 'warning' ELSE 'not_required' END::text AS mode
    FROM person_roles pr
    JOIN roles r ON r.id = pr.role_id
    WHERE pr.person_id = p.id
) laborordnung_mode ON true
LEFT JOIN LATERAL (
    SELECT required_version_id
    FROM laborordnung_requests
    WHERE person_id = p.id AND status = 'completed'
    ORDER BY completed_at DESC, id DESC
    LIMIT 1
) latest_confirmation ON true
LEFT JOIN LATERAL (
    SELECT required_version_id
    FROM laborordnung_requests
    WHERE person_id = p.id AND status = 'pending'
    LIMIT 1
) pending_confirmation ON true
WHERE (
       sqlc.arg(search)::text = ''
       OR p.first_name ILIKE '%' || sqlc.arg(search)::text || '%'
       OR p.last_name ILIKE '%' || sqlc.arg(search)::text || '%'
       OR (p.first_name || ' ' || p.last_name) ILIKE '%' || sqlc.arg(search)::text || '%'
       OR (p.last_name || ' ' || p.first_name) ILIKE '%' || sqlc.arg(search)::text || '%'
       OR COALESCE(p.email, '') ILIKE '%' || sqlc.arg(search)::text || '%'
       OR COALESCE(p.phone, '') ILIKE '%' || sqlc.arg(search)::text || '%'
       OR (sqlc.arg(include_matriculation)::boolean AND COALESCE(p.matriculation_number, '') ILIKE '%' || sqlc.arg(search)::text || '%')
   )
  AND (
       COALESCE(cardinality(sqlc.arg(role_ids)::text[]), 0) = 0
       OR EXISTS (
           SELECT 1
           FROM person_roles pr
           WHERE pr.person_id = p.id AND pr.role_id = ANY((sqlc.arg(role_ids)::text[])::uuid[])
       )
   )
  AND (
       COALESCE(cardinality(sqlc.arg(account_statuses)::text[]), 0) = 0
       OR (CASE WHEN a.id IS NULL THEN 'no_account' ELSE a.status END) = ANY(sqlc.arg(account_statuses)::text[])
   )
  AND (
       COALESCE(cardinality(sqlc.arg(laborordnung_statuses)::text[]), 0) = 0
       OR (CASE
           WHEN laborordnung_mode.mode = 'not_required' THEN 'not_required'
           WHEN current_laborordnung.id IS NULL THEN 'no_published_version'
           WHEN latest_confirmation.required_version_id = current_laborordnung.id THEN 'current'
           WHEN pending_confirmation.required_version_id = current_laborordnung.id THEN 'pending'
           ELSE 'outdated'
       END) = ANY(sqlc.arg(laborordnung_statuses)::text[])
   )
ORDER BY lower(p.last_name), lower(p.first_name), p.id
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: CountPeople :one
WITH current_laborordnung_version AS (
    SELECT id
    FROM laborordnung_versions
    WHERE status = 'published' AND effective_at <= now()
    ORDER BY effective_at DESC, id DESC
    LIMIT 1
)
SELECT count(*)
FROM people p
LEFT JOIN accounts a ON a.person_id = p.id
LEFT JOIN current_laborordnung_version current_laborordnung ON true
LEFT JOIN LATERAL (
    SELECT CASE COALESCE(max(CASE r.laborordnung_mode WHEN 'blocking' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END), 0)
        WHEN 2 THEN 'blocking' WHEN 1 THEN 'warning' ELSE 'not_required' END::text AS mode
    FROM person_roles pr
    JOIN roles r ON r.id = pr.role_id
    WHERE pr.person_id = p.id
) laborordnung_mode ON true
LEFT JOIN LATERAL (
    SELECT required_version_id
    FROM laborordnung_requests
    WHERE person_id = p.id AND status = 'completed'
    ORDER BY completed_at DESC, id DESC
    LIMIT 1
) latest_confirmation ON true
LEFT JOIN LATERAL (
    SELECT required_version_id
    FROM laborordnung_requests
    WHERE person_id = p.id AND status = 'pending'
    LIMIT 1
) pending_confirmation ON true
WHERE (
       sqlc.arg(search)::text = ''
       OR p.first_name ILIKE '%' || sqlc.arg(search)::text || '%'
       OR p.last_name ILIKE '%' || sqlc.arg(search)::text || '%'
       OR (p.first_name || ' ' || p.last_name) ILIKE '%' || sqlc.arg(search)::text || '%'
       OR (p.last_name || ' ' || p.first_name) ILIKE '%' || sqlc.arg(search)::text || '%'
       OR COALESCE(p.email, '') ILIKE '%' || sqlc.arg(search)::text || '%'
       OR COALESCE(p.phone, '') ILIKE '%' || sqlc.arg(search)::text || '%'
       OR (sqlc.arg(include_matriculation)::boolean AND COALESCE(p.matriculation_number, '') ILIKE '%' || sqlc.arg(search)::text || '%')
   )
  AND (
       COALESCE(cardinality(sqlc.arg(role_ids)::text[]), 0) = 0
       OR EXISTS (
           SELECT 1
           FROM person_roles pr
           WHERE pr.person_id = p.id AND pr.role_id = ANY((sqlc.arg(role_ids)::text[])::uuid[])
       )
   )
  AND (
       COALESCE(cardinality(sqlc.arg(account_statuses)::text[]), 0) = 0
       OR (CASE WHEN a.id IS NULL THEN 'no_account' ELSE a.status END) = ANY(sqlc.arg(account_statuses)::text[])
   )
  AND (
       COALESCE(cardinality(sqlc.arg(laborordnung_statuses)::text[]), 0) = 0
       OR (CASE
           WHEN laborordnung_mode.mode = 'not_required' THEN 'not_required'
           WHEN current_laborordnung.id IS NULL THEN 'no_published_version'
           WHEN latest_confirmation.required_version_id = current_laborordnung.id THEN 'current'
           WHEN pending_confirmation.required_version_id = current_laborordnung.id THEN 'pending'
           ELSE 'outdated'
       END) = ANY(sqlc.arg(laborordnung_statuses)::text[])
   );

-- name: UpdatePerson :one
UPDATE people
SET first_name = sqlc.arg(first_name), last_name = sqlc.arg(last_name),
    email = sqlc.narg(email), phone = sqlc.narg(phone),
    matriculation_number = sqlc.narg(matriculation_number), photo_reference = sqlc.narg(photo_reference),
    member_since = sqlc.arg(member_since),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: DeletePerson :one
DELETE FROM people WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING id;

-- name: SetProfileImage :one
UPDATE people
SET profile_image_file_id = sqlc.narg(profile_image_file_id),
    profile_image_source = sqlc.narg(profile_image_source),
    version = version + 1,
    updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: GetProfileImage :one
SELECT profile_image_file_id, profile_image_source
FROM people
WHERE id = sqlc.arg(id);

-- name: PersonRequiresProfileImage :one
SELECT COALESCE(bool_or(r.profile_image_required), false)::boolean
FROM person_roles pr
JOIN roles r ON r.id = pr.role_id
WHERE pr.person_id = sqlc.arg(person_id);

-- name: ListProfileImageRequirements :many
SELECT p.id AS person_id, COALESCE(bool_or(r.profile_image_required), false)::boolean AS required
FROM people p
LEFT JOIN person_roles pr ON pr.person_id = p.id
LEFT JOIN roles r ON r.id = pr.role_id
WHERE p.id = ANY((sqlc.arg(person_ids)::text[])::uuid[])
GROUP BY p.id;

-- name: ListPersonRoles :many
SELECT r.* FROM roles r
JOIN person_roles pr ON pr.role_id = r.id
WHERE pr.person_id = sqlc.arg(person_id)
ORDER BY r.system_key DESC NULLS LAST, lower(r.name), r.id;

-- name: ListPersonRolesByPeople :many
SELECT pr.person_id, r.* FROM roles r
JOIN person_roles pr ON pr.role_id = r.id
WHERE pr.person_id = ANY((sqlc.arg(person_ids)::text[])::uuid[])
ORDER BY pr.person_id, r.system_key DESC NULLS LAST, lower(r.name), r.id;

-- name: GetRoleForAssignment :one
SELECT * FROM roles WHERE id = sqlc.arg(id) FOR SHARE;

-- name: GetRolePermissionGrantsForAssignment :many
SELECT g.id, g.permission_id, g.scope, g.minimum_assurance, g.reauth_within_minutes, gdt.device_type_id
FROM role_permission_grants g
LEFT JOIN role_permission_grant_device_types gdt ON gdt.grant_id = g.id
WHERE g.role_id = sqlc.arg(role_id)
ORDER BY g.permission_id, g.id, gdt.device_type_id;

-- name: IsPersonRoleAssigned :one
SELECT EXISTS (
    SELECT 1 FROM person_roles
    WHERE person_id = sqlc.arg(person_id) AND role_id = sqlc.arg(role_id)
);

-- name: AssignPersonRole :execrows
INSERT INTO person_roles (person_id, role_id, assigned_by_account_id)
VALUES (sqlc.arg(person_id), sqlc.arg(role_id), sqlc.narg(assigned_by_account_id))
ON CONFLICT (person_id, role_id) DO NOTHING;

-- name: RemovePersonRole :execrows
DELETE FROM person_roles
WHERE person_id = sqlc.arg(person_id) AND role_id = sqlc.arg(role_id);

-- name: BumpPersonVersion :one
UPDATE people SET version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: AcquireMasterInvariantLock :exec
SELECT pg_advisory_xact_lock(5577006791947779410);

-- name: GetAccountByPersonForMutation :one
SELECT * FROM accounts WHERE person_id = sqlc.arg(person_id) FOR UPDATE;

-- name: CountEnabledMasters :one
SELECT count(*) FROM accounts a
JOIN person_roles pr ON pr.person_id = a.person_id
JOIN roles r ON r.id = pr.role_id
WHERE a.status = 'enabled' AND r.system_key = 'master';

-- name: CountMasterAssignments :one
SELECT count(*) FROM person_roles pr
JOIN roles r ON r.id = pr.role_id
WHERE r.system_key = 'master';

-- name: GetMasterRole :one
SELECT * FROM roles WHERE system_key = 'master';

-- name: GetPromotionSupervisorRole :one
-- Not locked on purpose: the role itself is locked by the assignment check, which re-validates its staffing level.
SELECT supervisor_role_id FROM open_day_requirements WHERE singleton = true;

-- name: ListPersonStaffingRoles :many
SELECT r.id, r.staffing_level::text AS staffing_level
FROM roles r
JOIN person_roles pr ON pr.role_id = r.id
WHERE pr.person_id = sqlc.arg(person_id) AND r.staffing_level IS NOT NULL
ORDER BY r.id;

-- People merge (people.merge). Every query below is part of PreviewMerge or Merge; see docs/people-merge.md.

-- name: LockPeopleForMerge :many
-- Locks every Person of a merge in id order. People are locked before the master invariant lock and accounts.
SELECT * FROM people WHERE id = ANY((sqlc.arg(ids)::text[])::uuid[]) ORDER BY id FOR UPDATE;

-- name: ListPeopleForMerge :many
SELECT * FROM people WHERE id = ANY((sqlc.arg(ids)::text[])::uuid[]) ORDER BY id;

-- name: LockAccountsForMerge :many
-- Locks the Accounts of the merged People in id order after the people and the master invariant lock.
SELECT * FROM accounts WHERE person_id = ANY((sqlc.arg(person_ids)::text[])::uuid[]) ORDER BY id FOR UPDATE;

-- name: ListAccountsForMerge :many
SELECT * FROM accounts WHERE person_id = ANY((sqlc.arg(person_ids)::text[])::uuid[]) ORDER BY id;

-- name: ListMergePersonFacts :many
SELECT p.id AS person_id,
    EXISTS (SELECT 1 FROM scim_users su WHERE su.person_id = p.id) AS scim_managed,
    EXISTS (SELECT 1 FROM visits v WHERE v.person_id = p.id AND v.status = 'checked_in') AS open_visit,
    EXISTS (SELECT 1 FROM attendance_holds h WHERE h.person_id = p.id) AS attendance_hold
FROM people p
WHERE p.id = ANY((sqlc.arg(ids)::text[])::uuid[])
ORDER BY p.id;

-- name: ListMergeAccountMethods :many
SELECT a.id AS account_id,
    pw.id AS password_identity_id,
    pw.identifier_display AS login_email,
    EXISTS (SELECT 1 FROM password_credentials pc WHERE pc.auth_identity_id = pw.id) AS password_set,
    EXISTS (SELECT 1 FROM auth_identities pin WHERE pin.account_id = a.id AND pin.kind = 'pin') AS has_pin,
    (SELECT count(*) FROM auth_identities o WHERE o.account_id = a.id AND o.kind = 'oidc') AS oidc_identities,
    EXISTS (
        SELECT 1 FROM mfa_totp_credentials t WHERE t.account_id = a.id AND t.confirmed_at IS NOT NULL
    ) AS totp_enrolled,
    (SELECT count(*) FROM webauthn_credentials w WHERE w.account_id = a.id) AS passkeys
FROM accounts a
LEFT JOIN auth_identities pw ON pw.account_id = a.id AND pw.kind = 'password'
WHERE a.id = ANY((sqlc.arg(account_ids)::text[])::uuid[])
ORDER BY a.id;

-- name: ListMergeOpenDayConflicts :many
-- Open Days on which the merged People hold different positions; one Person can hold only one.
SELECT open_day_id FROM open_day_assignments
WHERE person_id = ANY((sqlc.arg(ids)::text[])::uuid[])
GROUP BY open_day_id
HAVING count(DISTINCT requirement_id) > 1
ORDER BY open_day_id;

-- name: CountMergePendingLabRulesVersions :one
SELECT count(DISTINCT required_version_id) FROM laborordnung_requests
WHERE person_id = ANY((sqlc.arg(ids)::text[])::uuid[]) AND status = 'pending';

-- name: CountEnabledMastersOutsideMerge :one
SELECT count(*) FROM accounts a
JOIN person_roles pr ON pr.person_id = a.person_id
JOIN roles r ON r.id = pr.role_id
WHERE a.status = 'enabled' AND r.system_key = 'master'
  AND NOT (a.person_id = ANY((sqlc.arg(ids)::text[])::uuid[]));

-- name: CountMergeHistory :one
-- History of the source People that a merge moves to the target, per category.
SELECT
    (SELECT count(*) FROM visits WHERE person_id = ANY((sqlc.arg(ids)::text[])::uuid[]))::bigint AS visits,
    (SELECT count(*) FROM attendance_holds WHERE person_id = ANY((sqlc.arg(ids)::text[])::uuid[]))::bigint AS attendance_holds,
    (SELECT count(*) FROM training_records WHERE person_id = ANY((sqlc.arg(ids)::text[])::uuid[]))::bigint AS training_records,
    (SELECT count(*) FROM laborordnung_requests WHERE person_id = ANY((sqlc.arg(ids)::text[])::uuid[]))::bigint AS lab_rules_requests,
    (SELECT count(*) FROM open_day_assignments WHERE person_id = ANY((sqlc.arg(ids)::text[])::uuid[]))::bigint AS open_day_assignments,
    (SELECT count(*) FROM event_shift_assignments WHERE person_id = ANY((sqlc.arg(ids)::text[])::uuid[]))::bigint AS event_shift_assignments,
    ((SELECT count(*) FROM events WHERE owner_person_id = ANY((sqlc.arg(ids)::text[])::uuid[]))
        + (SELECT count(*) FROM event_tasks WHERE assignee_person_id = ANY((sqlc.arg(ids)::text[])::uuid[])))::bigint AS event_planning,
    (SELECT count(*) FROM orders WHERE customer_person_id = ANY((sqlc.arg(ids)::text[])::uuid[]))::bigint AS orders,
    (SELECT count(*) FROM machine_jobs
        WHERE customer_person_id = ANY((sqlc.arg(ids)::text[])::uuid[])
           OR operator_person_id = ANY((sqlc.arg(ids)::text[])::uuid[]))::bigint AS machine_jobs,
    (SELECT count(*) FROM external_invoice_request_details
        WHERE recipient_person_id = ANY((sqlc.arg(ids)::text[])::uuid[])
           OR contact_person_id = ANY((sqlc.arg(ids)::text[])::uuid[]))::bigint AS invoice_requests,
    (SELECT count(*) FROM cash_movements WHERE recorded_by_person_id = ANY((sqlc.arg(ids)::text[])::uuid[]))::bigint AS cash_movements,
    (SELECT count(*) FROM survey_invitations WHERE person_id = ANY((sqlc.arg(ids)::text[])::uuid[]))::bigint AS survey_invitations,
    (SELECT count(*) FROM survey_responses WHERE identified_person_id = ANY((sqlc.arg(ids)::text[])::uuid[]))::bigint AS survey_responses,
    (SELECT count(*) FROM organization_members WHERE person_id = ANY((sqlc.arg(ids)::text[])::uuid[]))::bigint AS organization_memberships,
    (SELECT count(*) FROM inbox_recipients WHERE account_id = ANY((sqlc.arg(account_ids)::text[])::uuid[]))::bigint AS notifications,
    ((SELECT count(*) FROM privacy_retention_holds WHERE subject_person_id = ANY((sqlc.arg(ids)::text[])::uuid[]))
        + (SELECT count(*) FROM privacy_subject_requests WHERE subject_person_id = ANY((sqlc.arg(ids)::text[])::uuid[])))::bigint AS privacy_holds;

-- name: EnablePeopleMergeMode :exec
-- Transaction-local: lets the history guards accept re-pointed person/account references (migration 00077).
SELECT set_config('makerspace.people_merge', 'on', true);

-- name: AddMergedPersonRoles :execrows
INSERT INTO person_roles (person_id, role_id, assigned_by_account_id)
SELECT sqlc.arg(target_person_id), source.role_id, sqlc.narg(assigned_by_account_id)
FROM person_roles source WHERE source.person_id = sqlc.arg(source_person_id)
ON CONFLICT (person_id, role_id) DO NOTHING;

-- name: DeleteSupersededMergeTrainingRecords :execrows
-- Keeps one record per training: the higher status (trainer over trained), then the most recently updated one.
DELETE FROM training_records loser
USING training_records winner
WHERE loser.training_id = winner.training_id
  AND loser.person_id IN (sqlc.arg(source_person_id), sqlc.arg(target_person_id))
  AND winner.person_id IN (sqlc.arg(source_person_id), sqlc.arg(target_person_id))
  AND loser.person_id <> winner.person_id
  AND (
      (CASE winner.status WHEN 'trainer' THEN 2 ELSE 1 END, winner.updated_at, winner.person_id = sqlc.arg(target_person_id))
      > (CASE loser.status WHEN 'trainer' THEN 2 ELSE 1 END, loser.updated_at, loser.person_id = sqlc.arg(target_person_id))
  );

-- name: MoveMergeTrainingRecords :execrows
UPDATE training_records SET person_id = sqlc.arg(target_person_id) WHERE person_id = sqlc.arg(source_person_id);

-- name: DeleteDuplicateMergeLabRulesRequests :execrows
-- One pending request per Person: the target's pending request for the same version wins.
DELETE FROM laborordnung_requests source
USING laborordnung_requests target
WHERE source.person_id = sqlc.arg(source_person_id) AND target.person_id = sqlc.arg(target_person_id)
  AND source.status = 'pending' AND target.status = 'pending';

-- name: MoveMergeLabRulesRequests :execrows
UPDATE laborordnung_requests SET person_id = sqlc.arg(target_person_id), updated_at = now()
WHERE person_id = sqlc.arg(source_person_id);

-- name: DeleteDuplicateMergeOpenDayAssignments :execrows
DELETE FROM open_day_assignments source
USING open_day_assignments target
WHERE source.person_id = sqlc.arg(source_person_id) AND target.person_id = sqlc.arg(target_person_id)
  AND source.open_day_id = target.open_day_id AND source.requirement_id = target.requirement_id;

-- name: MoveMergeOpenDayAssignments :execrows
UPDATE open_day_assignments SET person_id = sqlc.arg(target_person_id) WHERE person_id = sqlc.arg(source_person_id);

-- name: DeleteDuplicateMergeShiftAssignments :execrows
-- One active assignment per shift and Person: the target's assignment wins.
DELETE FROM event_shift_assignments source
USING event_shift_assignments target
WHERE source.person_id = sqlc.arg(source_person_id) AND target.person_id = sqlc.arg(target_person_id)
  AND source.shift_id = target.shift_id AND source.status = 'active' AND target.status = 'active';

-- name: MoveMergeShiftAssignments :execrows
UPDATE event_shift_assignments SET person_id = sqlc.arg(target_person_id), updated_at = now()
WHERE person_id = sqlc.arg(source_person_id);

-- name: DeleteDuplicateMergeOrganizationMembers :execrows
DELETE FROM organization_members source
USING organization_members target
WHERE source.person_id = sqlc.arg(source_person_id) AND target.person_id = sqlc.arg(target_person_id)
  AND source.organization_id = target.organization_id;

-- name: MoveMergeOrganizationMembers :execrows
UPDATE organization_members SET person_id = sqlc.arg(target_person_id) WHERE person_id = sqlc.arg(source_person_id);

-- name: RepointMergePersonReferences :one
-- Re-points the person references that carry no uniqueness rule. Conflicting open visits and attendance holds are
-- rejected before this runs.
WITH visits_moved AS (
    UPDATE visits SET person_id = sqlc.arg(target_person_id)::uuid WHERE person_id = sqlc.arg(source_person_id)::uuid RETURNING 1
), holds_moved AS (
    UPDATE attendance_holds SET person_id = sqlc.arg(target_person_id)::uuid WHERE person_id = sqlc.arg(source_person_id)::uuid RETURNING 1
), invitations_moved AS (
    UPDATE survey_invitations SET person_id = sqlc.arg(target_person_id)::uuid WHERE person_id = sqlc.arg(source_person_id)::uuid RETURNING 1
), responses_moved AS (
    UPDATE survey_responses SET identified_person_id = sqlc.arg(target_person_id)::uuid
    WHERE identified_person_id = sqlc.arg(source_person_id)::uuid RETURNING 1
), events_moved AS (
    UPDATE events SET owner_person_id = sqlc.arg(target_person_id)::uuid WHERE owner_person_id = sqlc.arg(source_person_id)::uuid RETURNING 1
), tasks_moved AS (
    UPDATE event_tasks SET assignee_person_id = sqlc.arg(target_person_id)::uuid
    WHERE assignee_person_id = sqlc.arg(source_person_id)::uuid RETURNING 1
), orders_moved AS (
    UPDATE orders SET customer_person_id = sqlc.arg(target_person_id)::uuid
    WHERE customer_person_id = sqlc.arg(source_person_id)::uuid RETURNING 1
), jobs_moved AS (
    UPDATE machine_jobs SET
        customer_person_id = CASE WHEN customer_person_id = sqlc.arg(source_person_id)::uuid THEN sqlc.arg(target_person_id)::uuid ELSE customer_person_id END,
        operator_person_id = CASE WHEN operator_person_id = sqlc.arg(source_person_id)::uuid THEN sqlc.arg(target_person_id)::uuid ELSE operator_person_id END
    WHERE customer_person_id = sqlc.arg(source_person_id)::uuid OR operator_person_id = sqlc.arg(source_person_id)::uuid RETURNING 1
), invoice_details_moved AS (
    UPDATE external_invoice_request_details SET
        recipient_person_id = CASE WHEN recipient_person_id = sqlc.arg(source_person_id)::uuid THEN sqlc.arg(target_person_id)::uuid ELSE recipient_person_id END,
        contact_person_id = CASE WHEN contact_person_id = sqlc.arg(source_person_id)::uuid THEN sqlc.arg(target_person_id)::uuid ELSE contact_person_id END
    WHERE recipient_person_id = sqlc.arg(source_person_id)::uuid OR contact_person_id = sqlc.arg(source_person_id)::uuid RETURNING 1
), cash_moved AS (
    UPDATE cash_movements SET recorded_by_person_id = sqlc.arg(target_person_id)::uuid
    WHERE recorded_by_person_id = sqlc.arg(source_person_id)::uuid RETURNING 1
), privacy_holds_moved AS (
    UPDATE privacy_retention_holds SET subject_person_id = sqlc.arg(target_person_id)::uuid
    WHERE subject_person_id = sqlc.arg(source_person_id)::uuid RETURNING 1
), privacy_requests_moved AS (
    UPDATE privacy_subject_requests SET subject_person_id = sqlc.arg(target_person_id)::uuid
    WHERE subject_person_id = sqlc.arg(source_person_id)::uuid RETURNING 1
)
SELECT
    ((SELECT count(*) FROM privacy_holds_moved) + (SELECT count(*) FROM privacy_requests_moved))::bigint AS privacy_holds,
    (SELECT count(*) FROM visits_moved)::bigint AS visits,
    (SELECT count(*) FROM holds_moved)::bigint AS attendance_holds,
    (SELECT count(*) FROM invitations_moved)::bigint AS survey_invitations,
    (SELECT count(*) FROM responses_moved)::bigint AS survey_responses,
    ((SELECT count(*) FROM events_moved) + (SELECT count(*) FROM tasks_moved))::bigint AS event_planning,
    (SELECT count(*) FROM orders_moved)::bigint AS orders,
    (SELECT count(*) FROM jobs_moved)::bigint AS machine_jobs,
    (SELECT count(*) FROM invoice_details_moved)::bigint AS invoice_requests,
    (SELECT count(*) FROM cash_moved)::bigint AS cash_movements;

-- name: RepointMergeAccountReferences :one
-- Re-points every "who did it" reference of a merged Account to the surviving Account.
WITH c01 AS (
    UPDATE password_reset_tokens SET created_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE created_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c02 AS (
    UPDATE open_day_assignments SET created_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE created_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c03 AS (
    UPDATE auth_challenges SET created_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE created_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c04 AS (
    UPDATE files SET created_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE created_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c05 AS (
    UPDATE laborordnung_versions SET created_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE created_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c06 AS (
    UPDATE laborordnung_requests SET confirmed_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE confirmed_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c07 AS (
    UPDATE scim_connector_tokens SET created_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE created_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c08 AS (
    UPDATE visitor_enrollment_configuration SET updated_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE updated_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c09 AS (
    UPDATE mail_configuration SET updated_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE updated_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c10 AS (
    UPDATE organization_pricing_group_assignments SET assigned_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE assigned_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c11 AS (
    UPDATE machine_jobs SET
        deleted_by = CASE WHEN deleted_by = sqlc.arg(source_account_id)::uuid THEN sqlc.arg(target_account_id)::uuid ELSE deleted_by END,
        price_adjusted_by_account_id = CASE WHEN price_adjusted_by_account_id = sqlc.arg(source_account_id)::uuid
            THEN sqlc.arg(target_account_id)::uuid ELSE price_adjusted_by_account_id END
    WHERE deleted_by = sqlc.arg(source_account_id)::uuid OR price_adjusted_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c12 AS (
    UPDATE machine_job_pricing_snapshots SET captured_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE captured_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c13 AS (
    UPDATE inventory_transactions SET actor_account_id = sqlc.arg(target_account_id)::uuid
    WHERE actor_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c14 AS (
    UPDATE branding_configuration SET updated_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE updated_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c15 AS (
    UPDATE branding_asset_overrides SET updated_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE updated_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c16 AS (
    UPDATE person_roles SET assigned_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE assigned_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c17 AS (
    UPDATE events SET created_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE created_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c18 AS (
    UPDATE event_tasks SET
        completed_by_account_id = CASE WHEN completed_by_account_id = sqlc.arg(source_account_id)::uuid
            THEN sqlc.arg(target_account_id)::uuid ELSE completed_by_account_id END,
        created_by_account_id = CASE WHEN created_by_account_id = sqlc.arg(source_account_id)::uuid
            THEN sqlc.arg(target_account_id)::uuid ELSE created_by_account_id END
    WHERE completed_by_account_id = sqlc.arg(source_account_id)::uuid OR created_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c19 AS (
    UPDATE event_shift_assignments SET
        cancelled_by_account_id = CASE WHEN cancelled_by_account_id = sqlc.arg(source_account_id)::uuid
            THEN sqlc.arg(target_account_id)::uuid ELSE cancelled_by_account_id END,
        conflict_overridden_by_account_id = CASE WHEN conflict_overridden_by_account_id = sqlc.arg(source_account_id)::uuid
            THEN sqlc.arg(target_account_id)::uuid ELSE conflict_overridden_by_account_id END,
        created_by_account_id = CASE WHEN created_by_account_id = sqlc.arg(source_account_id)::uuid
            THEN sqlc.arg(target_account_id)::uuid ELSE created_by_account_id END
    WHERE cancelled_by_account_id = sqlc.arg(source_account_id)::uuid
       OR conflict_overridden_by_account_id = sqlc.arg(source_account_id)::uuid
       OR created_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c20 AS (
    UPDATE orders SET created_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE created_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c21 AS (
    UPDATE order_items SET
        created_by_account_id = CASE WHEN created_by_account_id = sqlc.arg(source_account_id)::uuid
            THEN sqlc.arg(target_account_id)::uuid ELSE created_by_account_id END,
        removed_by_account_id = CASE WHEN removed_by_account_id = sqlc.arg(source_account_id)::uuid
            THEN sqlc.arg(target_account_id)::uuid ELSE removed_by_account_id END
    WHERE created_by_account_id = sqlc.arg(source_account_id)::uuid OR removed_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c22 AS (
    UPDATE order_adjustments SET actor_account_id = sqlc.arg(target_account_id)::uuid
    WHERE actor_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c23 AS (
    UPDATE organization_invoicing_requirements SET updated_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE updated_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c24 AS (
    UPDATE external_invoice_request_events SET actor_account_id = sqlc.arg(target_account_id)::uuid
    WHERE actor_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c25 AS (
    UPDATE payments SET actor_account_id = sqlc.arg(target_account_id)::uuid
    WHERE actor_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c26 AS (
    UPDATE payment_allocations SET actor_account_id = sqlc.arg(target_account_id)::uuid
    WHERE actor_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c27 AS (
    UPDATE order_operations SET actor_account_id = sqlc.arg(target_account_id)::uuid
    WHERE actor_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c28 AS (
    UPDATE visits SET
        checked_in_by_account_id = CASE WHEN checked_in_by_account_id = sqlc.arg(source_account_id)::uuid
            THEN sqlc.arg(target_account_id)::uuid ELSE checked_in_by_account_id END,
        checked_out_by_account_id = CASE WHEN checked_out_by_account_id = sqlc.arg(source_account_id)::uuid
            THEN sqlc.arg(target_account_id)::uuid ELSE checked_out_by_account_id END
    WHERE checked_in_by_account_id = sqlc.arg(source_account_id)::uuid OR checked_out_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c29 AS (
    UPDATE printer_spool_assignments SET
        mounted_by_account_id = CASE WHEN mounted_by_account_id = sqlc.arg(source_account_id)::uuid
            THEN sqlc.arg(target_account_id)::uuid ELSE mounted_by_account_id END,
        unmounted_by_account_id = CASE WHEN unmounted_by_account_id = sqlc.arg(source_account_id)::uuid
            THEN sqlc.arg(target_account_id)::uuid ELSE unmounted_by_account_id END
    WHERE mounted_by_account_id = sqlc.arg(source_account_id)::uuid OR unmounted_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c30 AS (
    UPDATE printer_connectors SET events_cleared_by = sqlc.arg(target_account_id)::uuid
    WHERE events_cleared_by = sqlc.arg(source_account_id)::uuid RETURNING 1
), c31 AS (
    UPDATE printer_connector_enrollments SET created_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE created_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c32 AS (
    UPDATE machine_runs SET deleted_by = sqlc.arg(target_account_id)::uuid
    WHERE deleted_by = sqlc.arg(source_account_id)::uuid RETURNING 1
), c33 AS (
    UPDATE printer_discovery_requests SET requested_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE requested_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c34 AS (
    UPDATE role_pricing_groups SET updated_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE updated_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c35 AS (
    UPDATE signage_assets SET created_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE created_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c36 AS (
    UPDATE signage_announcements SET created_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE created_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c37 AS (
    UPDATE signage_publications SET published_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE published_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c38 AS (
    UPDATE streaming_gateway_enrollments SET created_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE created_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c39 AS (
    UPDATE open_day_requirements SET updated_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE updated_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c40 AS (
    UPDATE wiref_delivery_settings SET updated_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE updated_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c41 AS (
    UPDATE inbox_notifications SET created_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE created_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c42 AS (
    UPDATE attendance_holds SET checked_in_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE checked_in_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c43 AS (
    UPDATE training_records SET recorded_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE recorded_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c44 AS (
    UPDATE privacy_settings SET updated_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE updated_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c45 AS (
    UPDATE privacy_policy_versions SET created_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE created_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c46 AS (
    UPDATE privacy_policy_versions SET approved_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE approved_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c47 AS (
    UPDATE privacy_policy_versions SET activated_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE activated_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c48 AS (
    UPDATE privacy_retention_holds SET created_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE created_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c49 AS (
    UPDATE privacy_retention_holds SET released_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE released_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c50 AS (
    UPDATE privacy_retention_runs SET actor_account_id = sqlc.arg(target_account_id)::uuid
    WHERE actor_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c51 AS (
    UPDATE privacy_processing_activities SET updated_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE updated_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c52 AS (
    UPDATE privacy_subject_requests SET identity_verified_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE identity_verified_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c53 AS (
    UPDATE privacy_subject_requests SET approved_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE approved_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c54 AS (
    UPDATE privacy_subject_requests SET executed_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE executed_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c55 AS (
    UPDATE privacy_subject_requests SET created_by_account_id = sqlc.arg(target_account_id)::uuid
    WHERE created_by_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), c56 AS (
    UPDATE privacy_subject_request_steps SET actor_account_id = sqlc.arg(target_account_id)::uuid
    WHERE actor_account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
)
SELECT (
    (SELECT count(*) FROM c01) + (SELECT count(*) FROM c02) + (SELECT count(*) FROM c03) + (SELECT count(*) FROM c04)
    + (SELECT count(*) FROM c05) + (SELECT count(*) FROM c06) + (SELECT count(*) FROM c07) + (SELECT count(*) FROM c08)
    + (SELECT count(*) FROM c09) + (SELECT count(*) FROM c10) + (SELECT count(*) FROM c11) + (SELECT count(*) FROM c12)
    + (SELECT count(*) FROM c13) + (SELECT count(*) FROM c14) + (SELECT count(*) FROM c15) + (SELECT count(*) FROM c16)
    + (SELECT count(*) FROM c17) + (SELECT count(*) FROM c18) + (SELECT count(*) FROM c19) + (SELECT count(*) FROM c20)
    + (SELECT count(*) FROM c21) + (SELECT count(*) FROM c22) + (SELECT count(*) FROM c23) + (SELECT count(*) FROM c24)
    + (SELECT count(*) FROM c25) + (SELECT count(*) FROM c26) + (SELECT count(*) FROM c27) + (SELECT count(*) FROM c28)
    + (SELECT count(*) FROM c29) + (SELECT count(*) FROM c30) + (SELECT count(*) FROM c31) + (SELECT count(*) FROM c32)
    + (SELECT count(*) FROM c33) + (SELECT count(*) FROM c34) + (SELECT count(*) FROM c35) + (SELECT count(*) FROM c36)
    + (SELECT count(*) FROM c37) + (SELECT count(*) FROM c38) + (SELECT count(*) FROM c39) + (SELECT count(*) FROM c40)
    + (SELECT count(*) FROM c41) + (SELECT count(*) FROM c42) + (SELECT count(*) FROM c43) + (SELECT count(*) FROM c44)
    + (SELECT count(*) FROM c45) + (SELECT count(*) FROM c46) + (SELECT count(*) FROM c47) + (SELECT count(*) FROM c48)
    + (SELECT count(*) FROM c49) + (SELECT count(*) FROM c50) + (SELECT count(*) FROM c51) + (SELECT count(*) FROM c52)
    + (SELECT count(*) FROM c53) + (SELECT count(*) FROM c54) + (SELECT count(*) FROM c55) + (SELECT count(*) FROM c56)
)::bigint AS moved;

-- name: RepointMergeAuditEvents :execrows
-- Keeps the activity history of a merged Person and Account (actor and resource) on the surviving records.
UPDATE audit_events SET
    actor_account_id = CASE WHEN actor_account_id = sqlc.narg(source_account_id)
        THEN sqlc.narg(target_account_id)::uuid ELSE actor_account_id END,
    resource_id = CASE
        WHEN resource_type = 'person' AND resource_id = sqlc.arg(source_person_id) THEN sqlc.arg(target_person_id)::uuid
        WHEN resource_type = 'account' AND resource_id = sqlc.narg(source_account_id) THEN sqlc.narg(target_account_id)::uuid
        ELSE resource_id END
WHERE actor_account_id = sqlc.narg(source_account_id)
   OR (resource_type = 'person' AND resource_id = sqlc.arg(source_person_id))
   OR (resource_type = 'account' AND resource_id = sqlc.narg(source_account_id));

-- name: DeleteMergeTransientAccountState :exec
-- Outstanding one-time challenges, pending logins, ceremonies and throttles of every merged Account end with the merge.
WITH pending AS (
    DELETE FROM pending_logins WHERE account_id = ANY((sqlc.arg(account_ids)::text[])::uuid[]) RETURNING 1
), ceremonies AS (
    DELETE FROM webauthn_challenges WHERE account_id = ANY((sqlc.arg(account_ids)::text[])::uuid[]) RETURNING 1
), flows AS (
    DELETE FROM oidc_flows WHERE account_id = ANY((sqlc.arg(account_ids)::text[])::uuid[]) RETURNING 1
), throttles AS (
    DELETE FROM second_factor_throttles WHERE account_id = ANY((sqlc.arg(account_ids)::text[])::uuid[]) RETURNING 1
), resets AS (
    DELETE FROM password_reset_tokens WHERE account_id = ANY((sqlc.arg(account_ids)::text[])::uuid[]) RETURNING 1
), challenges AS (
    DELETE FROM auth_challenges WHERE account_id = ANY((sqlc.arg(account_ids)::text[])::uuid[]) RETURNING 1
), totp AS (
    DELETE FROM mfa_totp_credentials
    WHERE account_id = ANY((sqlc.arg(account_ids)::text[])::uuid[]) AND confirmed_at IS NULL RETURNING 1
)
SELECT (SELECT count(*) FROM pending) + (SELECT count(*) FROM ceremonies) + (SELECT count(*) FROM flows)
    + (SELECT count(*) FROM throttles) + (SELECT count(*) FROM resets) + (SELECT count(*) FROM challenges)
    + (SELECT count(*) FROM totp);

-- name: RevokeMergeSessions :execrows
UPDATE sessions SET revoked_at = now(), revocation_reason = 'people_merged'
WHERE account_id = ANY((sqlc.arg(account_ids)::text[])::uuid[]) AND revoked_at IS NULL;

-- name: DeleteMergePasswordIdentities :execrows
-- Drops every password identity of the merged Accounts except the one kept for the login email.
DELETE FROM auth_identities
WHERE account_id = ANY((sqlc.arg(account_ids)::text[])::uuid[]) AND kind = 'password'
  AND id IS DISTINCT FROM sqlc.narg(keep_identity_id);

-- name: MoveMergeAuthIdentities :execrows
UPDATE auth_identities SET account_id = sqlc.arg(target_account_id), updated_at = now()
WHERE account_id = sqlc.arg(source_account_id);

-- name: DeleteDuplicateMergeRecoveryCodes :execrows
DELETE FROM mfa_recovery_codes source
USING mfa_recovery_codes target
WHERE source.account_id = sqlc.arg(source_account_id) AND target.account_id = sqlc.arg(target_account_id)
  AND source.code_digest = target.code_digest;

-- name: MoveMergeSecondFactors :one
WITH totp AS (
    UPDATE mfa_totp_credentials SET account_id = sqlc.arg(target_account_id)::uuid
    WHERE account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), passkeys AS (
    UPDATE webauthn_credentials SET account_id = sqlc.arg(target_account_id)::uuid
    WHERE account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
), codes AS (
    UPDATE mfa_recovery_codes SET account_id = sqlc.arg(target_account_id)::uuid
    WHERE account_id = sqlc.arg(source_account_id)::uuid RETURNING 1
)
SELECT ((SELECT count(*) FROM totp) + (SELECT count(*) FROM passkeys) + (SELECT count(*) FROM codes))::bigint AS moved;

-- name: DeleteDuplicateMergeInboxRecipients :execrows
DELETE FROM inbox_recipients source
USING inbox_recipients target
WHERE source.account_id = sqlc.arg(source_account_id) AND target.account_id = sqlc.arg(target_account_id)
  AND source.notification_id = target.notification_id;

-- name: MoveMergeInboxRecipients :execrows
UPDATE inbox_recipients SET account_id = sqlc.arg(target_account_id) WHERE account_id = sqlc.arg(source_account_id);

-- name: AttachMergeAccount :exec
-- The source Account becomes the target's Account when the target had none.
UPDATE accounts SET person_id = sqlc.arg(target_person_id), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id);

-- name: BumpMergeAccountVersion :exec
UPDATE accounts SET version = version + 1, updated_at = now() WHERE id = sqlc.arg(id);

-- name: DeleteMergedAccount :execrows
DELETE FROM accounts WHERE id = sqlc.arg(id);

-- name: DeleteMergedPerson :execrows
DELETE FROM people WHERE id = sqlc.arg(id);

-- name: ApplyMergedPerson :one
UPDATE people SET
    first_name = sqlc.arg(first_name),
    last_name = sqlc.arg(last_name),
    email = sqlc.narg(email),
    phone = sqlc.narg(phone),
    matriculation_number = sqlc.narg(matriculation_number),
    photo_reference = sqlc.narg(photo_reference),
    profile_image_file_id = sqlc.narg(profile_image_file_id),
    profile_image_source = sqlc.narg(profile_image_source),
    member_since = sqlc.arg(member_since),
    version = version + 1,
    updated_at = now()
WHERE id = sqlc.arg(id)
RETURNING *;
