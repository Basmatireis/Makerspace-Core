-- name: GetTerminalDevice :one
SELECT md.id, md.name, md.terminal_enabled, md.check_in_assurance, md.check_out_assurance,
       md.checkout_mode, md.revoked_at, md.expires_at
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

-- name: VoidVisit :one
WITH updated AS (
  UPDATE visits SET status = 'voided', correction_reason = sqlc.arg(correction_reason),
    version = version + 1, updated_at = now()
  WHERE visits.id = sqlc.arg(visit_id) AND visits.version = sqlc.arg(expected_version)
    AND visits.status <> 'voided'
  RETURNING *
)
SELECT updated.*, p.first_name, p.last_name FROM updated JOIN people p ON p.id = updated.person_id;

-- name: ListPublicPresence :many
SELECT v.id, v.checked_in_at, p.first_name, left(p.last_name, 1)::text AS last_initial
FROM visits v JOIN people p ON p.id = v.person_id
WHERE v.status = 'checked_in'
ORDER BY lower(p.first_name), lower(p.last_name), v.checked_in_at, v.id;

-- name: ListVisits :many
SELECT v.*, p.first_name, p.last_name
FROM visits v JOIN people p ON p.id = v.person_id
WHERE (NOT sqlc.arg(currently_here)::boolean OR v.status = 'checked_in')
  AND (sqlc.narg(from_time)::timestamptz IS NULL OR v.checked_in_at >= sqlc.narg(from_time))
  AND (sqlc.narg(to_time)::timestamptz IS NULL OR v.checked_in_at < sqlc.narg(to_time))
ORDER BY v.checked_in_at DESC, v.id DESC
LIMIT 500;

-- name: AttendanceStatistics :one
WITH relevant AS (
  SELECT * FROM visits
  WHERE status <> 'voided' AND checked_in_at < sqlc.arg(to_time)
    AND COALESCE(checked_out_at, now()) > sqlc.arg(from_time)
), points AS (
  SELECT GREATEST(checked_in_at, sqlc.arg(from_time)) AS at, 1::bigint AS delta FROM relevant
  UNION ALL
  SELECT LEAST(COALESCE(checked_out_at, sqlc.arg(to_time)), sqlc.arg(to_time)) AS at, -1::bigint AS delta
  FROM relevant WHERE COALESCE(checked_out_at, sqlc.arg(to_time)) < sqlc.arg(to_time)
), occupancy AS (
  SELECT sum(sum(delta)) OVER (ORDER BY at) AS value FROM points GROUP BY at
)
SELECT
  (SELECT count(*) FROM visits counts WHERE counts.status <> 'voided' AND counts.checked_in_at >= sqlc.arg(from_time) AND counts.checked_in_at < sqlc.arg(to_time))::bigint AS visitor_count,
  (SELECT count(DISTINCT uniques.person_id) FROM visits uniques WHERE uniques.status <> 'voided' AND uniques.checked_in_at >= sqlc.arg(from_time) AND uniques.checked_in_at < sqlc.arg(to_time))::bigint AS unique_visitors,
  COALESCE((SELECT sum(extract(epoch FROM (LEAST(COALESCE(checked_out_at, sqlc.arg(to_time)), sqlc.arg(to_time)) - GREATEST(checked_in_at, sqlc.arg(from_time))))) / 3600 FROM relevant), 0)::numeric AS visitor_hours,
  COALESCE((SELECT max(value) FROM occupancy), 0)::bigint AS peak_occupancy,
  (SELECT count(*) FROM visits current_visits WHERE current_visits.status = 'checked_in')::bigint AS current_occupancy,
  COALESCE((SELECT avg(extract(epoch FROM (completed.checked_out_at - completed.checked_in_at))) / 60 FROM visits completed
    WHERE completed.status = 'checked_out' AND completed.checked_out_at >= sqlc.arg(from_time) AND completed.checked_out_at < sqlc.arg(to_time)), 0)::numeric AS average_completed_visit_minutes;

-- name: ArchiveExpiredVisitDetail :execrows
WITH expired AS (
  DELETE FROM visits
  WHERE (status = 'checked_out' AND checked_out_at < sqlc.arg(before_time))
     OR (status = 'voided' AND updated_at < sqlc.arg(before_time))
  RETURNING *
), segments AS (
  SELECT e.*,
    day_start::date AS day,
    GREATEST(e.checked_in_at, day_start) AS segment_start,
    LEAST(e.checked_out_at, day_start + interval '1 day') AS segment_end
  FROM expired e
  CROSS JOIN LATERAL generate_series(
    date_trunc('day', e.checked_in_at),
    date_trunc('day', e.checked_out_at),
    interval '1 day'
  ) day_start
  WHERE e.status = 'checked_out'
), base AS (
  SELECT day,
    count(*) FILTER (WHERE checked_in_at >= day::timestamptz AND checked_in_at < day::timestamptz + interval '1 day')::bigint AS visitor_count,
    count(DISTINCT person_id) FILTER (WHERE checked_in_at >= day::timestamptz AND checked_in_at < day::timestamptz + interval '1 day')::bigint AS daily_unique_visitors,
    COALESCE(sum(extract(epoch FROM segment_end - segment_start)), 0)::bigint AS visitor_seconds,
    count(*) FILTER (WHERE checked_out_at >= day::timestamptz AND checked_out_at < day::timestamptz + interval '1 day')::bigint AS completed_visit_count,
    COALESCE(sum(extract(epoch FROM checked_out_at - checked_in_at)) FILTER (WHERE checked_out_at >= day::timestamptz AND checked_out_at < day::timestamptz + interval '1 day'), 0)::bigint AS completed_visit_seconds
  FROM segments GROUP BY day
), points AS (
  SELECT day, segment_start AS at, 1::bigint AS delta FROM segments WHERE segment_end > segment_start
  UNION ALL
  SELECT day, segment_end AS at, -1::bigint AS delta FROM segments WHERE segment_end > segment_start
), point_totals AS (
  SELECT day, at, sum(delta)::bigint AS delta FROM points GROUP BY day, at
), occupancy AS (
  SELECT day, sum(delta) OVER (PARTITION BY day ORDER BY at) AS value FROM point_totals
), aggregated AS (
  SELECT b.*, COALESCE(max(o.value), 0)::bigint AS peak_occupancy
  FROM base b LEFT JOIN occupancy o ON o.day = b.day
  GROUP BY b.day, b.visitor_count, b.daily_unique_visitors, b.visitor_seconds,
    b.completed_visit_count, b.completed_visit_seconds
)
INSERT INTO attendance_daily_statistics(day, visitor_count, daily_unique_visitors, visitor_seconds,
  completed_visit_count, completed_visit_seconds, peak_occupancy)
SELECT day, visitor_count, daily_unique_visitors, visitor_seconds,
  completed_visit_count, completed_visit_seconds, peak_occupancy
FROM aggregated
ON CONFLICT (day) DO UPDATE SET
  visitor_count = attendance_daily_statistics.visitor_count + EXCLUDED.visitor_count,
  daily_unique_visitors = attendance_daily_statistics.daily_unique_visitors + EXCLUDED.daily_unique_visitors,
  visitor_seconds = attendance_daily_statistics.visitor_seconds + EXCLUDED.visitor_seconds,
  completed_visit_count = attendance_daily_statistics.completed_visit_count + EXCLUDED.completed_visit_count,
  completed_visit_seconds = attendance_daily_statistics.completed_visit_seconds + EXCLUDED.completed_visit_seconds,
  peak_occupancy = GREATEST(attendance_daily_statistics.peak_occupancy, EXCLUDED.peak_occupancy),
  updated_at = now();
