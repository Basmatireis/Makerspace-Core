-- name: CreatePerson :one
INSERT INTO people (id, first_name, last_name, email, phone, matriculation_number, photo_reference)
VALUES (sqlc.arg(id), sqlc.arg(first_name), sqlc.arg(last_name), sqlc.narg(email), sqlc.narg(phone), sqlc.narg(matriculation_number), sqlc.narg(photo_reference))
RETURNING *;

-- name: GetPerson :one
SELECT * FROM people WHERE id = sqlc.arg(id);

-- name: GetPersonForDeletion :one
SELECT * FROM people WHERE id = sqlc.arg(id) FOR UPDATE;

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
SELECT g.id, g.permission_id, g.scope, g.minimum_assurance, gdt.device_type_id
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
