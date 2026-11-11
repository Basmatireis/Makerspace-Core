-- name: GetTerminalDevice :one
SELECT md.id, md.name, md.terminal_enabled, md.check_in_methods, md.check_out_methods,
       md.allow_tap_checkout, md.offer_surveys_at_checkout, md.kiosk_reset_seconds, md.revoked_at, md.expires_at
FROM managed_devices md
WHERE md.id = sqlc.arg(id) AND md.terminal_enabled AND md.revoked_at IS NULL
  AND (md.expires_at IS NULL OR md.expires_at > now());

-- name: ListTerminalCapabilities :many
SELECT capability FROM managed_device_capabilities
WHERE managed_device_id = sqlc.arg(managed_device_id) AND enabled ORDER BY capability;

-- name: LockPerson :one
SELECT id FROM people WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: LockEnabledAttendanceAccount :one
SELECT id FROM accounts
WHERE id = sqlc.arg(account_id) AND person_id = sqlc.arg(person_id) AND status = 'enabled'
FOR SHARE;

-- name: GetPersonDisplay :one
SELECT id, first_name, last_name, email FROM people WHERE id = sqlc.arg(id);

-- name: GetOpenVisitForPerson :one
SELECT v.*, p.first_name, p.last_name
FROM visits v JOIN people p ON p.id = v.person_id
WHERE v.person_id = sqlc.arg(person_id) AND v.status = 'checked_in'
FOR UPDATE OF v;

-- name: GetOpenVisitByID :one
SELECT v.*, p.first_name, p.last_name
FROM visits v JOIN people p ON p.id = v.person_id
WHERE v.id = sqlc.arg(id) AND v.status = 'checked_in'
FOR UPDATE OF v;

-- name: GetVisitByIDForUpdate :one
SELECT v.*, p.first_name, p.last_name
FROM visits v JOIN people p ON p.id = v.person_id
WHERE v.id = sqlc.arg(id)
FOR UPDATE OF v;

-- name: CreateVisit :one
WITH inserted AS (
  INSERT INTO visits (id, person_id, checked_in_at, check_in_device_id, check_in_method,
    check_in_assurance, admission_decision, laborordnung_version_id, checked_in_by_account_id)
  VALUES (sqlc.arg(id), sqlc.arg(person_id), now(), sqlc.narg(check_in_device_id), sqlc.arg(check_in_method),
    sqlc.arg(check_in_assurance), sqlc.arg(admission_decision), sqlc.narg(laborordnung_version_id),
    sqlc.narg(checked_in_by_account_id))
  RETURNING *
)
SELECT inserted.*, p.first_name, p.last_name FROM inserted JOIN people p ON p.id = inserted.person_id;

-- name: CheckOutVisit :one
WITH updated AS (
  UPDATE visits SET checked_out_at = now(), check_out_device_id = sqlc.narg(check_out_device_id),
    status = 'checked_out', check_out_method = sqlc.arg(check_out_method),
    check_out_assurance = sqlc.narg(check_out_assurance),
    checked_out_by_account_id = sqlc.narg(checked_out_by_account_id),
    version = version + 1, updated_at = now()
  WHERE visits.id = sqlc.arg(visit_id) AND visits.status = 'checked_in'
  RETURNING *
)
SELECT updated.*, p.first_name, p.last_name FROM updated JOIN people p ON p.id = updated.person_id;

-- name: VoidOpenVisit :one
-- A correction removes an open visit entirely: it never counted, so it adds nothing to the statistics.
WITH deleted AS (
  DELETE FROM visits
  WHERE visits.id = sqlc.arg(visit_id) AND visits.version = sqlc.arg(expected_version)
    AND visits.status = 'checked_in'
  RETURNING *
)
SELECT deleted.*, p.first_name, p.last_name FROM deleted JOIN people p ON p.id = deleted.person_id;

-- name: ListPublicPresence :many
-- The full last name only feeds the shortening in Go; the public list shows as few letters of it as tell people apart.
SELECT v.id, v.checked_in_at, p.first_name, p.last_name
FROM visits v JOIN people p ON p.id = v.person_id
WHERE v.status = 'checked_in'
ORDER BY lower(p.first_name), lower(p.last_name), v.checked_in_at, v.id;

-- name: ListVisits :many
-- Only open visits exist: check-out deletes the visit.
SELECT v.*, p.first_name, p.last_name
FROM visits v JOIN people p ON p.id = v.person_id
WHERE v.status = 'checked_in'
ORDER BY v.checked_in_at DESC, v.id DESC
LIMIT 500;

-- name: AttendanceStatistics :one
-- Completed visits come from the UTC daily statistics of every day the period touches; open visits are added live.
-- Unique visitors are the sum of the daily unique visitors.
WITH days AS (
  SELECT * FROM attendance_daily_statistics
  WHERE day >= (sqlc.arg(from_time)::timestamptz AT TIME ZONE 'UTC')::date
    AND day <= ((sqlc.arg(to_time)::timestamptz - interval '1 microsecond') AT TIME ZONE 'UTC')::date
), open_visits AS (
  SELECT v.checked_in_at, p.last_visit_on FROM visits v JOIN people p ON p.id = v.person_id
  WHERE v.status = 'checked_in'
), open_in_period AS (
  SELECT * FROM open_visits
  WHERE checked_in_at < sqlc.arg(to_time)::timestamptz AND now() > sqlc.arg(from_time)::timestamptz
)
SELECT
  ((SELECT COALESCE(sum(visitor_count), 0) FROM days)
    + (SELECT count(*) FROM open_in_period WHERE checked_in_at >= sqlc.arg(from_time)::timestamptz))::bigint AS visitor_count,
  ((SELECT COALESCE(sum(daily_unique_visitors), 0) FROM days)
    + (SELECT count(*) FROM open_in_period WHERE checked_in_at >= sqlc.arg(from_time)::timestamptz
         AND (last_visit_on IS NULL OR last_visit_on < (checked_in_at AT TIME ZONE 'UTC')::date)))::bigint AS unique_visitors,
  (((SELECT COALESCE(sum(visitor_seconds), 0) FROM days)
    + (SELECT COALESCE(sum(extract(epoch FROM LEAST(now(), sqlc.arg(to_time)::timestamptz)
         - GREATEST(checked_in_at, sqlc.arg(from_time)::timestamptz))), 0) FROM open_in_period)) / 3600)::numeric AS visitor_hours,
  GREATEST(
    (SELECT COALESCE(max(peak_occupancy), 0) FROM days),
    CASE WHEN now() >= sqlc.arg(from_time)::timestamptz AND now() < sqlc.arg(to_time)::timestamptz
      THEN (SELECT count(*) FROM open_visits) ELSE 0 END
  )::bigint AS peak_occupancy,
  (SELECT count(*) FROM open_visits)::bigint AS current_occupancy,
  COALESCE((SELECT sum(completed_visit_seconds)::numeric / NULLIF(sum(completed_visit_count), 0) / 60 FROM days), 0)::numeric
    AS average_completed_visit_minutes;

-- name: ArchiveCheckedOutVisit :one
-- Rolls a just checked-out visit into the UTC daily statistics, records the person's last visit date and deletes the
-- visit. The person counts as a unique visitor of the check-in day unless their last visit already was on that day.
WITH visit AS (
  DELETE FROM visits WHERE visits.id = sqlc.arg(visit_id) AND visits.status = 'checked_out' RETURNING *
), previous AS (
  SELECT p.last_visit_on FROM people p JOIN visit ON visit.person_id = p.id
), touched AS (
  UPDATE people p SET last_visit_on = GREATEST(p.last_visit_on, (visit.checked_in_at AT TIME ZONE 'UTC')::date)
  FROM visit WHERE p.id = visit.person_id
  RETURNING p.id
), segments AS (
  SELECT v.checked_in_at, v.checked_out_at, day_start,
    (day_start AT TIME ZONE 'UTC')::date AS day,
    GREATEST(v.checked_in_at, day_start) AS segment_start,
    LEAST(v.checked_out_at, day_start + interval '24 hours') AS segment_end,
    (SELECT last_visit_on FROM previous) AS last_visit_on
  FROM visit v
  CROSS JOIN LATERAL generate_series(
    date_trunc('day', v.checked_in_at, 'UTC'),
    date_trunc('day', v.checked_out_at, 'UTC'),
    interval '24 hours'
  ) day_start
), inserted AS (
  INSERT INTO attendance_daily_statistics (day, visitor_count, daily_unique_visitors, visitor_seconds,
    completed_visit_count, completed_visit_seconds, peak_occupancy)
  SELECT day,
    CASE WHEN checked_in_at >= day_start AND checked_in_at < day_start + interval '24 hours' THEN 1 ELSE 0 END,
    CASE WHEN checked_in_at >= day_start AND checked_in_at < day_start + interval '24 hours'
      AND (last_visit_on IS NULL OR last_visit_on < day) THEN 1 ELSE 0 END,
    GREATEST(extract(epoch FROM segment_end - segment_start), 0)::bigint,
    CASE WHEN checked_out_at >= day_start AND checked_out_at < day_start + interval '24 hours' THEN 1 ELSE 0 END,
    CASE WHEN checked_out_at >= day_start AND checked_out_at < day_start + interval '24 hours'
      THEN GREATEST(extract(epoch FROM checked_out_at - checked_in_at), 0)::bigint ELSE 0 END,
    1
  FROM segments
  ON CONFLICT (day) DO UPDATE SET
    visitor_count = attendance_daily_statistics.visitor_count + EXCLUDED.visitor_count,
    daily_unique_visitors = attendance_daily_statistics.daily_unique_visitors + EXCLUDED.daily_unique_visitors,
    visitor_seconds = attendance_daily_statistics.visitor_seconds + EXCLUDED.visitor_seconds,
    completed_visit_count = attendance_daily_statistics.completed_visit_count + EXCLUDED.completed_visit_count,
    completed_visit_seconds = attendance_daily_statistics.completed_visit_seconds + EXCLUDED.completed_visit_seconds,
    peak_occupancy = GREATEST(attendance_daily_statistics.peak_occupancy, EXCLUDED.peak_occupancy),
    updated_at = now()
  RETURNING day
)
SELECT (SELECT count(*) FROM visit)::bigint AS archived;

-- name: RecordPeakOccupancy :exec
-- How many people are in the lab right now, as a candidate for today's (UTC) peak. Called after every check-in and
-- before every check-out is archived.
INSERT INTO attendance_daily_statistics (day, peak_occupancy)
VALUES ((now() AT TIME ZONE 'UTC')::date, (SELECT count(*) FROM visits WHERE status = 'checked_in'))
ON CONFLICT (day) DO UPDATE SET
  peak_occupancy = GREATEST(attendance_daily_statistics.peak_occupancy, EXCLUDED.peak_occupancy),
  updated_at = now();

-- name: GetOpenVisitCheckedInAtDevice :one
-- The open visit a tablet may collect consent answers for: checked in at that tablet.
SELECT id, person_id, checked_in_at, checked_in_by_account_id FROM visits
WHERE id = sqlc.arg(id) AND status = 'checked_in' AND check_in_device_id = sqlc.arg(device_id);
