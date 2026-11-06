-- name: GetOwnCalendarFeedForUpdate :one
-- Locks the person's feed row so that a concurrent rotation or revocation waits.
SELECT person_id, created_at, last_used_at
FROM calendar_feeds
WHERE person_id = sqlc.arg(person_id)
FOR UPDATE;

-- name: GetOwnCalendarFeed :one
SELECT person_id, created_at, last_used_at
FROM calendar_feeds
WHERE person_id = sqlc.arg(person_id);

-- name: UpsertCalendarFeed :one
-- One feed per person: a new token replaces the old digest, so the previous link stops working at once.
INSERT INTO calendar_feeds (person_id, token_digest, created_at)
VALUES (sqlc.arg(person_id), sqlc.arg(token_digest), sqlc.arg(created_at))
ON CONFLICT (person_id) DO UPDATE
SET token_digest = EXCLUDED.token_digest, created_at = EXCLUDED.created_at, last_used_at = NULL
RETURNING person_id, created_at, last_used_at;

-- name: DeleteCalendarFeed :execrows
DELETE FROM calendar_feeds WHERE person_id = sqlc.arg(person_id);

-- name: GetCalendarFeedOwnerByDigest :one
-- Resolves a token digest to its owner. A person whose account is not enabled has no feed.
SELECT f.person_id
FROM calendar_feeds f
WHERE f.token_digest = sqlc.arg(token_digest)
  AND EXISTS (SELECT 1 FROM accounts a WHERE a.person_id = f.person_id AND a.status = 'enabled');

-- name: TouchCalendarFeed :exec
-- Coarse usage time: written at most once per interval.
UPDATE calendar_feeds
SET last_used_at = sqlc.arg(used_at)::timestamptz
WHERE person_id = sqlc.arg(person_id)
  AND (last_used_at IS NULL OR last_used_at < sqlc.arg(stale_before)::timestamptz);

-- name: ListCalendarFeedOpenDays :many
-- The person's open-day timeslots that ended no earlier than since, with the kind of place held.
SELECT t.id AS timeslot_id, t.starts_at, t.ends_at, d.status, d.version, d.updated_at, r.kind
FROM open_day_assignments a
JOIN open_day_timeslots t ON t.id = a.timeslot_id
JOIN open_days d ON d.id = a.open_day_id
JOIN open_day_staff_requirements r ON r.id = a.requirement_id
WHERE a.person_id = sqlc.arg(person_id) AND t.ends_at >= sqlc.arg(since)
ORDER BY t.starts_at, t.id;

-- name: ListCalendarFeedShifts :many
-- The person's active event shift sign-ups that ended no earlier than since. Draft events are not shown. The location
-- is the session's, else the event's.
SELECT s.id AS shift_id, s.name AS shift_name, s.starts_at, s.ends_at, s.status AS shift_status,
       s.version AS shift_version, s.updated_at AS shift_updated_at,
       e.name AS event_name, e.status AS event_status, e.version AS event_version, e.updated_at AS event_updated_at,
       COALESCE(NULLIF(btrim(es.location), ''), NULLIF(btrim(e.location), ''), '')::text AS location
FROM event_shift_assignments a
JOIN event_shifts s ON s.id = a.shift_id
JOIN events e ON e.id = s.event_id
LEFT JOIN event_sessions es ON es.id = s.session_id
WHERE a.person_id = sqlc.arg(person_id)::uuid
  AND a.status = 'active'
  AND e.status <> 'draft'
  AND s.ends_at >= sqlc.arg(since)
ORDER BY s.starts_at, s.id;
