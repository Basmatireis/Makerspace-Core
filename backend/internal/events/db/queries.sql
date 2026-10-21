-- name: CreateEvent :one
INSERT INTO events (
    id, name, internal_description, location, owner_person_id, public_id, created_by_account_id
) VALUES (
    sqlc.arg(id), sqlc.arg(name), sqlc.narg(internal_description), sqlc.narg(location),
    sqlc.narg(owner_person_id), sqlc.arg(public_id), sqlc.narg(created_by_account_id)
) RETURNING *;

-- name: GetEvent :one
SELECT * FROM events WHERE id = sqlc.arg(id);

-- name: GetEventForUpdate :one
SELECT * FROM events WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: GetEventByPublicID :one
SELECT * FROM events WHERE public_id = sqlc.arg(public_id) AND is_public;

-- name: UpdateEvent :one
UPDATE events
SET name = sqlc.arg(name), internal_description = sqlc.narg(internal_description),
    location = sqlc.narg(location), owner_person_id = sqlc.narg(owner_person_id),
    public_title = sqlc.narg(public_title), public_description = sqlc.narg(public_description),
    public_location = sqlc.narg(public_location), public_signup_enabled = sqlc.arg(public_signup_enabled),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND status NOT IN ('completed', 'cancelled')
RETURNING *;

-- name: TransitionEvent :one
UPDATE events
SET status = sqlc.arg(status), closed_at = sqlc.narg(closed_at),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: SetEventPublication :one
UPDATE events
SET is_public = sqlc.arg(is_public),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: RotateEventPublicID :one
UPDATE events SET public_id = sqlc.arg(public_id), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND status NOT IN ('completed', 'cancelled')
RETURNING *;

-- name: CountEventAssignmentHistory :one
SELECT count(*) FROM event_shift_assignments WHERE event_id = sqlc.arg(event_id);

-- name: DeleteDraftEvent :one
DELETE FROM events
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND status = 'draft'
RETURNING id;

-- name: EventPublicationFacts :one
SELECT
    EXISTS (SELECT 1 FROM event_sessions es WHERE es.event_id = sqlc.arg(event_id) AND es.status = 'scheduled') AS has_session,
    EXISTS (SELECT 1 FROM event_shifts esh WHERE esh.event_id = sqlc.arg(event_id) AND esh.status <> 'cancelled') AS has_shift,
    EXISTS (SELECT 1 FROM event_sessions es WHERE es.event_id = sqlc.arg(event_id) AND es.status = 'scheduled' AND es.is_public) AS has_public_session,
    EXISTS (SELECT 1 FROM event_shifts esh WHERE esh.event_id = sqlc.arg(event_id) AND esh.status <> 'cancelled' AND esh.is_public) AS has_public_shift,
    EXISTS (
        SELECT 1 FROM event_shifts sh
        JOIN event_shift_requirements r ON r.shift_id = sh.id
        WHERE sh.event_id = sqlc.arg(event_id) AND sh.status <> 'cancelled' AND sh.is_public
    ) AS has_public_requirement;

-- name: CreateEventSession :one
INSERT INTO event_sessions (id, event_id, name, location, description, starts_at, ends_at, is_public, status)
VALUES (sqlc.arg(id), sqlc.arg(event_id), sqlc.narg(name), sqlc.narg(location), sqlc.narg(description),
        sqlc.arg(starts_at), sqlc.arg(ends_at), sqlc.arg(is_public), sqlc.arg(status))
RETURNING *;

-- name: ListEventSessions :many
SELECT * FROM event_sessions WHERE event_id = sqlc.arg(event_id) ORDER BY starts_at, id;

-- name: GetEventSession :one
SELECT * FROM event_sessions WHERE id = sqlc.arg(id) AND event_id = sqlc.arg(event_id);

-- name: UpdateEventSession :one
UPDATE event_sessions
SET name = sqlc.narg(name), location = sqlc.narg(location), description = sqlc.narg(description),
    starts_at = sqlc.arg(starts_at), ends_at = sqlc.arg(ends_at), is_public = sqlc.arg(is_public),
    status = sqlc.arg(status), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND event_id = sqlc.arg(event_id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: DeleteEventSession :one
DELETE FROM event_sessions
WHERE id = sqlc.arg(id) AND event_id = sqlc.arg(event_id) AND version = sqlc.arg(expected_version)
RETURNING id;

-- name: CreateEventTaskList :one
INSERT INTO event_task_lists (id, event_id, name, description, sort_order)
VALUES (sqlc.arg(id), sqlc.arg(event_id), sqlc.arg(name), sqlc.narg(description), sqlc.arg(sort_order)) RETURNING *;

-- name: ListEventTaskLists :many
SELECT * FROM event_task_lists WHERE event_id = sqlc.arg(event_id) ORDER BY sort_order, id;

-- name: GetEventTaskList :one
SELECT * FROM event_task_lists WHERE id = sqlc.arg(id) AND event_id = sqlc.arg(event_id);

-- name: UpdateEventTaskList :one
UPDATE event_task_lists
SET name = sqlc.arg(name), description = sqlc.narg(description), sort_order = sqlc.arg(sort_order),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND event_id = sqlc.arg(event_id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: DeleteEventTaskList :one
DELETE FROM event_task_lists
WHERE id = sqlc.arg(id) AND event_id = sqlc.arg(event_id) AND version = sqlc.arg(expected_version)
RETURNING id;

-- name: CreateEventTask :one
INSERT INTO event_tasks (
    id, event_id, task_list_id, title, description, status, important, assignee_person_id,
    due_at, completed_at, completed_by_account_id, sort_order, created_by_account_id
) VALUES (
    sqlc.arg(id), sqlc.arg(event_id), sqlc.narg(task_list_id), sqlc.arg(title), sqlc.narg(description),
    sqlc.arg(status), sqlc.arg(important), sqlc.narg(assignee_person_id), sqlc.narg(due_at),
    sqlc.narg(completed_at), sqlc.narg(completed_by_account_id), sqlc.arg(sort_order), sqlc.narg(created_by_account_id)
) RETURNING *;

-- name: ListEventTasks :many
SELECT * FROM event_tasks WHERE event_id = sqlc.arg(event_id) ORDER BY task_list_id NULLS FIRST, sort_order, id;

-- name: ListFilteredEventTasks :many
-- assignee_person_id narrows to one assignee, overdue_before to open tasks due before that time.
SELECT * FROM event_tasks
WHERE event_id = sqlc.arg(event_id)
  AND (sqlc.narg(assignee_person_id)::uuid IS NULL OR assignee_person_id = sqlc.narg(assignee_person_id)::uuid)
  AND (sqlc.arg(include_done)::boolean OR status <> 'done')
  AND (sqlc.narg(overdue_before)::timestamptz IS NULL
       OR (status = 'open' AND due_at < sqlc.narg(overdue_before)::timestamptz))
ORDER BY task_list_id NULLS FIRST, sort_order, id;

-- name: GetEventTask :one
SELECT * FROM event_tasks WHERE id = sqlc.arg(id) AND event_id = sqlc.arg(event_id);

-- name: UpdateEventTask :one
UPDATE event_tasks
SET task_list_id = sqlc.narg(task_list_id), title = sqlc.arg(title), description = sqlc.narg(description),
    status = sqlc.arg(status), important = sqlc.arg(important), assignee_person_id = sqlc.narg(assignee_person_id),
    due_at = sqlc.narg(due_at), completed_at = sqlc.narg(completed_at),
    completed_by_account_id = sqlc.narg(completed_by_account_id), sort_order = sqlc.arg(sort_order),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND event_id = sqlc.arg(event_id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: DeleteEventTask :one
DELETE FROM event_tasks
WHERE id = sqlc.arg(id) AND event_id = sqlc.arg(event_id) AND version = sqlc.arg(expected_version)
RETURNING id;

-- name: CreateEventShift :one
INSERT INTO event_shifts (
    id, event_id, session_id, name, description, starts_at, ends_at,
    signup_opens_at, signup_closes_at, is_public, status
) VALUES (
    sqlc.arg(id), sqlc.arg(event_id), sqlc.narg(session_id), sqlc.arg(name), sqlc.narg(description),
    sqlc.arg(starts_at), sqlc.arg(ends_at), sqlc.narg(signup_opens_at), sqlc.narg(signup_closes_at),
    sqlc.arg(is_public), sqlc.arg(status)
) RETURNING *;

-- name: ListEventShifts :many
SELECT sh.*, s.status AS session_status
FROM event_shifts sh
LEFT JOIN event_sessions s ON s.id = sh.session_id
WHERE sh.event_id = sqlc.arg(event_id)
ORDER BY sh.starts_at, sh.id;

-- name: GetEventShift :one
SELECT sh.*, s.status AS session_status
FROM event_shifts sh
LEFT JOIN event_sessions s ON s.id = sh.session_id
WHERE sh.id = sqlc.arg(id) AND sh.event_id = sqlc.arg(event_id);

-- name: UpdateEventShift :one
UPDATE event_shifts
SET session_id = sqlc.narg(session_id), name = sqlc.arg(name), description = sqlc.narg(description),
    starts_at = sqlc.arg(starts_at), ends_at = sqlc.arg(ends_at),
    signup_opens_at = sqlc.narg(signup_opens_at), signup_closes_at = sqlc.narg(signup_closes_at),
    is_public = sqlc.arg(is_public), status = sqlc.arg(status), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND event_id = sqlc.arg(event_id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: DeleteEventShift :one
DELETE FROM event_shifts
WHERE id = sqlc.arg(id) AND event_id = sqlc.arg(event_id) AND version = sqlc.arg(expected_version)
RETURNING id;

-- name: CreateEventRequirement :one
INSERT INTO event_shift_requirements (id, event_id, shift_id, name, description, required_count, eligibility_mode)
VALUES (sqlc.arg(id), sqlc.arg(event_id), sqlc.arg(shift_id), sqlc.arg(name), sqlc.narg(description),
        sqlc.arg(required_count), sqlc.arg(eligibility_mode)) RETURNING *;

-- name: ListEventRequirements :many
SELECT r.*,
       count(a.id) FILTER (WHERE a.status = 'active')::bigint AS filled_count
FROM event_shift_requirements r
LEFT JOIN event_shift_assignments a ON a.requirement_id = r.id
WHERE r.event_id = sqlc.arg(event_id)
GROUP BY r.id
ORDER BY r.shift_id, lower(r.name), r.id;

-- name: GetEventRequirement :one
SELECT * FROM event_shift_requirements
WHERE id = sqlc.arg(id) AND shift_id = sqlc.arg(shift_id) AND event_id = sqlc.arg(event_id);

-- name: GetEventRequirementForUpdate :one
SELECT * FROM event_shift_requirements
WHERE id = sqlc.arg(id) AND shift_id = sqlc.arg(shift_id) AND event_id = sqlc.arg(event_id)
FOR UPDATE;

-- name: UpdateEventRequirement :one
UPDATE event_shift_requirements
SET name = sqlc.arg(name), description = sqlc.narg(description), required_count = sqlc.arg(required_count),
    eligibility_mode = sqlc.arg(eligibility_mode), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND shift_id = sqlc.arg(shift_id) AND event_id = sqlc.arg(event_id)
  AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: DeleteEventRequirement :one
DELETE FROM event_shift_requirements
WHERE id = sqlc.arg(id) AND shift_id = sqlc.arg(shift_id) AND event_id = sqlc.arg(event_id)
  AND version = sqlc.arg(expected_version)
RETURNING id;

-- name: ReplaceEventRequirementRoles :exec
DELETE FROM event_shift_requirement_roles WHERE requirement_id = sqlc.arg(requirement_id);

-- name: AddEventRequirementRole :exec
INSERT INTO event_shift_requirement_roles (requirement_id, role_id)
VALUES (sqlc.arg(requirement_id), sqlc.arg(role_id));

-- name: ListEventRequirementRoleIDs :many
SELECT role_id FROM event_shift_requirement_roles WHERE requirement_id = sqlc.arg(requirement_id) ORDER BY role_id;

-- name: CountActiveEventRequirementAssignments :one
SELECT count(*) FROM event_shift_assignments WHERE requirement_id = sqlc.arg(requirement_id) AND status = 'active';

-- name: PersonEligibleForEventRequirement :one
SELECT r.eligibility_mode = 'anyone' OR EXISTS (
    SELECT 1 FROM event_shift_requirement_roles rr
    JOIN person_roles pr ON pr.role_id = rr.role_id
    WHERE rr.requirement_id = r.id AND pr.person_id = sqlc.arg(person_id)
) AS eligible
FROM event_shift_requirements r WHERE r.id = sqlc.arg(requirement_id);

-- name: CountEventRequirementRoles :one
SELECT count(*) FROM event_shift_requirement_roles WHERE requirement_id = sqlc.arg(requirement_id);

-- name: CreateEventAssignment :one
INSERT INTO event_shift_assignments (
    id, event_id, shift_id, requirement_id, person_id,
    first_name_snapshot, last_name_snapshot, email_snapshot, email_normalized, phone_snapshot, phone_normalized,
    source, created_by_account_id, management_token_digest, conflict_overridden_by_account_id
) VALUES (
    sqlc.arg(id), sqlc.arg(event_id), sqlc.arg(shift_id), sqlc.arg(requirement_id), sqlc.narg(person_id),
    sqlc.arg(first_name_snapshot), sqlc.arg(last_name_snapshot), sqlc.narg(email_snapshot), sqlc.narg(email_normalized),
    sqlc.narg(phone_snapshot), sqlc.narg(phone_normalized), sqlc.arg(source), sqlc.narg(created_by_account_id),
    sqlc.narg(management_token_digest), sqlc.narg(conflict_overridden_by_account_id)
) RETURNING *;

-- name: ListEventAssignments :many
SELECT a.*, p.first_name AS person_first_name, p.last_name AS person_last_name
FROM event_shift_assignments a
LEFT JOIN people p ON p.id = a.person_id
WHERE a.event_id = sqlc.arg(event_id)
ORDER BY a.created_at, a.id;

-- name: ListOwnEventAssignments :many
SELECT a.* FROM event_shift_assignments a
JOIN events e ON e.id = a.event_id
WHERE e.public_id = sqlc.arg(public_id) AND e.is_public AND a.person_id = sqlc.arg(person_id)
ORDER BY a.created_at, a.id;

-- name: GetEventAssignment :one
SELECT * FROM event_shift_assignments WHERE id = sqlc.arg(id) AND event_id = sqlc.arg(event_id);

-- name: GetEventAssignmentForUpdate :one
SELECT * FROM event_shift_assignments WHERE id = sqlc.arg(id) AND event_id = sqlc.arg(event_id) FOR UPDATE;

-- name: GetEventAssignmentByTokenDigest :one
SELECT * FROM event_shift_assignments WHERE management_token_digest = sqlc.arg(management_token_digest);

-- name: GetEventAssignmentByTokenDigestForUpdate :one
SELECT * FROM event_shift_assignments WHERE management_token_digest = sqlc.arg(management_token_digest) FOR UPDATE;

-- name: UpdateEventAssignmentContact :one
UPDATE event_shift_assignments
SET first_name_snapshot = sqlc.arg(first_name_snapshot), last_name_snapshot = sqlc.arg(last_name_snapshot),
    email_snapshot = sqlc.narg(email_snapshot), email_normalized = sqlc.narg(email_normalized),
    phone_snapshot = sqlc.narg(phone_snapshot), phone_normalized = sqlc.narg(phone_normalized),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND status = 'active' AND personal_data_erased_at IS NULL
RETURNING *;

-- name: MoveEventAssignment :one
UPDATE event_shift_assignments
SET shift_id = sqlc.arg(shift_id), requirement_id = sqlc.arg(requirement_id),
    conflict_overridden_by_account_id = sqlc.narg(conflict_overridden_by_account_id),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND status = 'active' AND personal_data_erased_at IS NULL
RETURNING *;

-- name: CancelEventAssignment :one
UPDATE event_shift_assignments
SET status = 'cancelled', cancelled_at = now(), cancelled_by_account_id = sqlc.narg(cancelled_by_account_id),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND status = 'active'
RETURNING *;

-- name: LinkEventAssignmentPerson :one
UPDATE event_shift_assignments
SET person_id = sqlc.arg(person_id), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND status = 'active' AND personal_data_erased_at IS NULL
RETURNING *;

-- name: LockPersonForEventAssignment :one
SELECT id FROM people WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: LockEventRequirement :one
SELECT * FROM event_shift_requirements
WHERE id = sqlc.arg(id)
FOR UPDATE;

-- name: FindPersonEventShiftConflicts :many
SELECT a.id, sh.starts_at, sh.ends_at
FROM event_shift_assignments a
JOIN event_shifts sh ON sh.id = a.shift_id
WHERE a.person_id = sqlc.arg(person_id) AND a.status = 'active'
  AND a.id <> sqlc.arg(exclude_assignment_id)
  AND sh.status <> 'cancelled'
  AND sh.starts_at < sqlc.arg(ends_at) AND sh.ends_at > sqlc.arg(starts_at)
ORDER BY sh.starts_at, a.id;

-- name: FindContactEventShiftConflicts :many
SELECT a.id, sh.starts_at, sh.ends_at
FROM event_shift_assignments a
JOIN event_shifts sh ON sh.id = a.shift_id
WHERE a.status = 'active' AND a.id <> sqlc.arg(exclude_assignment_id)
  AND sh.status <> 'cancelled'
  AND ((sqlc.narg(email_normalized)::text IS NOT NULL AND a.email_normalized = sqlc.narg(email_normalized))
       OR (sqlc.narg(phone_normalized)::text IS NOT NULL AND a.phone_normalized = sqlc.narg(phone_normalized)))
  AND sh.starts_at < sqlc.arg(ends_at) AND sh.ends_at > sqlc.arg(starts_at)
ORDER BY sh.starts_at, a.id;

-- name: AdvisoryLockEventContact :exec
SELECT pg_advisory_xact_lock(sqlc.arg(lock_key));

-- name: ListEventEligibilityRoles :many
SELECT id, name FROM roles ORDER BY system_key DESC NULLS LAST, lower(name), id;

-- name: FindEventPeople :many
SELECT p.id, p.first_name, p.last_name, p.email, p.phone
FROM people p
WHERE sqlc.arg(search)::text = ''
   OR lower(p.first_name || ' ' || p.last_name) LIKE '%' || lower(sqlc.arg(search)::text) || '%'
   OR lower(COALESCE(p.email, '')) = lower(sqlc.arg(search)::text)
   OR COALESCE(p.phone, '') = sqlc.arg(search)::text
ORDER BY p.last_name, p.first_name, p.id
LIMIT sqlc.arg(page_limit);

-- name: GetEventPerson :one
SELECT id, first_name, last_name, email, phone FROM people WHERE id = sqlc.arg(id);

-- name: FindEventPeopleByExactContact :many
WITH normalized_people AS (
    SELECT p.*,
           lower(btrim(p.email)) AS normalized_email,
           CASE
               WHEN regexp_replace(p.phone, '[^0-9+]', '', 'g') LIKE '00%'
                   THEN '+' || substr(regexp_replace(p.phone, '[^0-9+]', '', 'g'), 3)
               ELSE regexp_replace(p.phone, '[^0-9+]', '', 'g')
           END AS normalized_phone
    FROM people p
)
SELECT p.id, p.first_name, p.last_name, p.email, p.phone
FROM normalized_people p
WHERE (sqlc.narg(email_normalized)::text IS NOT NULL AND p.normalized_email = sqlc.narg(email_normalized))
   OR (sqlc.narg(phone_normalized)::text IS NOT NULL AND p.normalized_phone = sqlc.narg(phone_normalized))
ORDER BY p.last_name, p.first_name, p.id
LIMIT 20;

-- name: CreateEventFile :one
INSERT INTO event_files (id, event_id, file_id, description, visibility, is_banner)
VALUES (sqlc.arg(id), sqlc.arg(event_id), sqlc.arg(file_id), sqlc.narg(description), sqlc.arg(visibility), sqlc.arg(is_banner))
RETURNING *;

-- name: ListEventFiles :many
SELECT ef.*, f.original_filename, f.content_type, f.size_bytes, f.created_at AS file_created_at
FROM event_files ef JOIN files f ON f.id = ef.file_id
WHERE ef.event_id = sqlc.arg(event_id)
ORDER BY ef.created_at, ef.id;

-- name: GetEventFile :one
SELECT ef.*, f.original_filename, f.content_type, f.size_bytes, f.storage_key
FROM event_files ef JOIN files f ON f.id = ef.file_id
WHERE ef.id = sqlc.arg(id) AND ef.event_id = sqlc.arg(event_id);

-- name: GetPublicEventFile :one
SELECT ef.*, f.original_filename, f.content_type, f.size_bytes, f.storage_key
FROM event_files ef JOIN files f ON f.id = ef.file_id JOIN events e ON e.id = ef.event_id
WHERE ef.id = sqlc.arg(id) AND e.public_id = sqlc.arg(public_id) AND e.is_public AND ef.visibility = 'public';

-- name: EventBannerExists :one
SELECT EXISTS (
    SELECT 1 FROM event_files WHERE event_id = sqlc.arg(event_id) AND is_banner
);

-- name: ClearOtherEventBanners :exec
UPDATE event_files
SET is_banner = false, version = version + 1, updated_at = now()
WHERE event_id = sqlc.arg(event_id) AND is_banner AND id <> sqlc.arg(excluded_id);

-- name: GetEventBanner :one
SELECT ef.*, f.original_filename, f.content_type, f.size_bytes, f.storage_key
FROM event_files ef JOIN files f ON f.id = ef.file_id
WHERE ef.event_id = sqlc.arg(event_id) AND ef.is_banner;

-- name: GetPublicEventBanner :one
SELECT ef.*, f.original_filename, f.content_type, f.size_bytes, f.storage_key
FROM event_files ef JOIN files f ON f.id = ef.file_id JOIN events e ON e.id = ef.event_id
WHERE e.public_id = sqlc.arg(public_id) AND e.is_public AND ef.is_banner AND ef.visibility = 'public';

-- name: UpdateEventFile :one
UPDATE event_files
SET description = sqlc.narg(description), visibility = sqlc.arg(visibility), is_banner = sqlc.arg(is_banner),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND event_id = sqlc.arg(event_id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: DeleteEventFile :one
DELETE FROM event_files
WHERE id = sqlc.arg(id) AND event_id = sqlc.arg(event_id) AND version = sqlc.arg(expected_version)
RETURNING file_id;

-- name: ListEventFileIDsForDelete :many
SELECT file_id FROM event_files WHERE event_id = sqlc.arg(event_id) ORDER BY id;

-- name: ScrubEventAssignmentsForPerson :many
UPDATE event_shift_assignments
SET person_id = NULL, first_name_snapshot = NULL, last_name_snapshot = NULL,
    email_snapshot = NULL, email_normalized = NULL, phone_snapshot = NULL, phone_normalized = NULL,
    management_token_digest = NULL, personal_data_erased_at = COALESCE(personal_data_erased_at, now()),
    version = version + 1, updated_at = now()
WHERE person_id = sqlc.arg(person_id)
RETURNING id, event_id;

-- name: ListExpiredEventAssignmentsForUpdate :many
SELECT a.id, a.event_id
FROM event_shift_assignments a
JOIN events e ON e.id = a.event_id
WHERE e.closed_at IS NOT NULL AND e.closed_at < sqlc.arg(cutoff)
  AND a.personal_data_erased_at IS NULL
ORDER BY a.id
FOR UPDATE OF a;

-- name: EraseEventAssignmentPersonalData :one
UPDATE event_shift_assignments
SET first_name_snapshot = NULL, last_name_snapshot = NULL,
    email_snapshot = NULL, email_normalized = NULL, phone_snapshot = NULL, phone_normalized = NULL,
    management_token_digest = NULL, personal_data_erased_at = now(),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND personal_data_erased_at IS NULL
RETURNING *;

-- name: ListUpcomingPublicEventSessions :many
-- One row per event: its next public scheduled session. Only already publicly visible events
-- (published, with a public title) that are still draft or confirmed; returns nothing internal.
SELECT title, starts_at, location FROM (
    SELECT DISTINCT ON (e.id) e.public_title::text AS title, es.starts_at,
           COALESCE(NULLIF(btrim(es.location), ''), e.public_location, '')::text AS location
    FROM events e JOIN event_sessions es ON es.event_id = e.id
    WHERE e.is_public AND e.public_title IS NOT NULL AND e.status IN ('draft', 'confirmed')
      AND es.is_public AND es.status = 'scheduled' AND es.ends_at > sqlc.arg(now)::timestamptz
    ORDER BY e.id, es.starts_at
) upcoming
ORDER BY starts_at, title
LIMIT sqlc.arg(row_limit)::int;

-- name: ListOwnComingUpShifts :many
-- Active shift assignments of the person on shifts that have not ended, across confirmed and completed events (drafts
-- are invisible to helpers, cancelled events do not take place). public_id is returned only for public events.
SELECT a.id AS assignment_id, e.id AS event_id,
       COALESCE(CASE WHEN e.is_public THEN e.public_id END, '')::text AS public_id,
       COALESCE(e.public_title, e.name)::text AS event_title, s.name AS shift_name, s.starts_at, s.ends_at
FROM event_shift_assignments a
JOIN event_shifts s ON s.id = a.shift_id AND s.status <> 'cancelled'
JOIN events e ON e.id = a.event_id AND e.status IN ('confirmed', 'completed')
WHERE a.person_id = sqlc.arg(person_id) AND a.status = 'active' AND s.ends_at > sqlc.arg(now)
ORDER BY s.starts_at, a.id;

-- name: GetOwnShiftStatistics :one
-- Ended shifts the person was actively assigned to, all time, with their scheduled duration in seconds.
SELECT count(*)::bigint AS shifts,
       COALESCE(sum(extract(epoch FROM s.ends_at - s.starts_at)), 0)::float8 AS scheduled_seconds
FROM event_shift_assignments a
JOIN event_shifts s ON s.id = a.shift_id AND s.status <> 'cancelled'
WHERE a.person_id = sqlc.arg(person_id) AND a.status = 'active' AND s.ends_at <= sqlc.arg(now);

-- name: ListEventPage :many
-- Events of one list scope with their date range, filtered, sorted by start and paged. The range spans scheduled
-- sessions and shifts that are not cancelled, or the whole programme when all of it was cancelled. Without
-- organizer rights (helper_person_id set) drafts never match and past events need an active assignment of the person.
WITH ranged AS (
    SELECT e.id, e.name, e.status, e.owner_person_id, e.public_title, e.location,
           COALESCE(live.starts_at, total.starts_at) AS range_starts_at,
           COALESCE(live.ends_at, total.ends_at) AS range_ends_at
    FROM events e
    LEFT JOIN LATERAL (
        SELECT min(p.starts_at) AS starts_at, max(p.ends_at) AS ends_at FROM (
            SELECT es.starts_at, es.ends_at FROM event_sessions es WHERE es.event_id = e.id AND es.status = 'scheduled'
            UNION ALL
            SELECT sh.starts_at, sh.ends_at FROM event_shifts sh WHERE sh.event_id = e.id AND sh.status <> 'cancelled'
        ) p
    ) live ON true
    LEFT JOIN LATERAL (
        SELECT min(p.starts_at) AS starts_at, max(p.ends_at) AS ends_at FROM (
            SELECT es.starts_at, es.ends_at FROM event_sessions es WHERE es.event_id = e.id
            UNION ALL
            SELECT sh.starts_at, sh.ends_at FROM event_shifts sh WHERE sh.event_id = e.id
        ) p
    ) total ON true
)
SELECT r.id, count(*) OVER ()::bigint AS total
FROM ranged r
WHERE CASE sqlc.arg(scope)::text
        WHEN 'drafts' THEN r.status = 'draft' AND sqlc.narg(helper_person_id)::uuid IS NULL
        WHEN 'past' THEN (r.status IN ('completed', 'cancelled')
                          OR (r.status = 'confirmed' AND r.range_ends_at < sqlc.arg(now)::timestamptz))
                         AND (sqlc.narg(helper_person_id)::uuid IS NULL OR EXISTS (
                             SELECT 1 FROM event_shift_assignments a
                             WHERE a.event_id = r.id AND a.person_id = sqlc.narg(helper_person_id)::uuid
                               AND a.status = 'active'))
        ELSE r.status = 'confirmed' AND (r.range_ends_at IS NULL OR r.range_ends_at >= sqlc.arg(now)::timestamptz)
      END
  AND (sqlc.narg(owner_person_id)::uuid IS NULL OR r.owner_person_id = sqlc.narg(owner_person_id)::uuid)
  AND (sqlc.arg(search)::text = ''
       OR lower(r.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%'
       OR lower(COALESCE(r.public_title, '')) LIKE '%' || lower(sqlc.arg(search)::text) || '%'
       OR lower(COALESCE(r.location, '')) LIKE '%' || lower(sqlc.arg(search)::text) || '%')
ORDER BY CASE WHEN sqlc.arg(scope)::text = 'past' THEN r.range_starts_at END DESC NULLS LAST,
         CASE WHEN sqlc.arg(scope)::text <> 'past' THEN r.range_starts_at END ASC NULLS LAST,
         lower(r.name), r.id
LIMIT sqlc.arg(page_limit)::int OFFSET sqlc.arg(page_offset)::int;

-- name: ListOwnEventShiftAssignments :many
SELECT a.id, a.shift_id, a.requirement_id, a.version, sh.name AS shift_name, r.name AS requirement_name,
       sh.starts_at, sh.ends_at, sh.status AS shift_status
FROM event_shift_assignments a
JOIN event_shifts sh ON sh.id = a.shift_id
JOIN event_shift_requirements r ON r.id = a.requirement_id
WHERE a.event_id = sqlc.arg(event_id) AND a.person_id = sqlc.arg(person_id) AND a.status = 'active'
ORDER BY sh.starts_at, a.id;

-- name: ListEventRequirementRoles :many
-- Eligibility roles of the event's positions and whether the person holds each of them.
SELECT rr.requirement_id, ro.name,
       EXISTS (SELECT 1 FROM person_roles pr WHERE pr.role_id = ro.id AND pr.person_id = sqlc.arg(person_id)) AS held
FROM event_shift_requirement_roles rr
JOIN event_shift_requirements r ON r.id = rr.requirement_id
JOIN roles ro ON ro.id = rr.role_id
WHERE r.event_id = sqlc.arg(event_id)
ORDER BY lower(ro.name), ro.id;

-- name: PersonHasActiveShiftAssignment :one
SELECT EXISTS (
    SELECT 1 FROM event_shift_assignments
    WHERE shift_id = sqlc.arg(shift_id) AND person_id = sqlc.arg(person_id) AND status = 'active'
);

-- name: ListEventShiftRequirementsForUpdate :many
SELECT * FROM event_shift_requirements
WHERE shift_id = sqlc.arg(shift_id) AND event_id = sqlc.arg(event_id)
ORDER BY id
FOR UPDATE;

-- name: CountEventRequirementAssignmentHistory :one
SELECT count(*) FROM event_shift_assignments WHERE requirement_id = sqlc.arg(requirement_id);
