-- name: CreatePeriod :one
INSERT INTO open_day_periods (id, name, starts_on, ends_on, sign_up_deadline)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(starts_on), sqlc.arg(ends_on), sqlc.narg(sign_up_deadline)) RETURNING *;

-- name: ListPeriods :many
SELECT * FROM open_day_periods ORDER BY starts_on DESC, id DESC;

-- name: GetPeriod :one
SELECT * FROM open_day_periods WHERE id = sqlc.arg(id);

-- name: GetPeriodForUpdate :one
SELECT * FROM open_day_periods WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: UpdatePeriod :one
UPDATE open_day_periods
SET name = sqlc.arg(name), starts_on = sqlc.arg(starts_on), ends_on = sqlc.arg(ends_on),
    sign_up_deadline = sqlc.narg(sign_up_deadline),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND status <> 'archived'
RETURNING *;

-- name: DeletePeriod :one
DELETE FROM open_day_periods
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING id;

-- name: TransitionPeriod :one
UPDATE open_day_periods
SET status = sqlc.arg(status), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: BumpPeriodVersion :one
UPDATE open_day_periods SET version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING *;

-- name: CreateOpenDay :one
INSERT INTO open_days (id, period_id, starts_at, ends_at, internal_note, series_id)
VALUES (
    sqlc.arg(id), sqlc.arg(period_id), sqlc.arg(starts_at), sqlc.arg(ends_at), sqlc.narg(internal_note),
    sqlc.narg(series_id)
)
RETURNING *;

-- name: ListOpenDaysByPeriod :many
SELECT * FROM open_days WHERE period_id = sqlc.arg(period_id) ORDER BY starts_at, id;

-- name: ListPublishedOpenDays :many
SELECT od.* FROM open_days od
JOIN open_day_periods odp ON odp.id = od.period_id
WHERE odp.status = 'published'
ORDER BY od.starts_at, od.id;

-- name: GetOpenDay :one
SELECT * FROM open_days WHERE id = sqlc.arg(id);

-- name: GetOpenDayForUpdate :one
SELECT * FROM open_days WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: UpdateOpenDay :one
UPDATE open_days
SET starts_at = sqlc.arg(starts_at), ends_at = sqlc.arg(ends_at), internal_note = sqlc.narg(internal_note),
    series_id = sqlc.narg(series_id), detached_from_series_id = sqlc.narg(detached_from_series_id),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND status = 'scheduled'
RETURNING *;

-- name: ListOverlappingScheduledDays :many
-- Pairs of scheduled days of a period whose overall ranges overlap; the schedule must never contain one.
SELECT a.id AS first_id, b.id AS second_id
FROM open_days a
JOIN open_days b ON b.period_id = a.period_id AND a.id < b.id AND b.status = 'scheduled'
    AND a.starts_at < b.ends_at AND b.starts_at < a.ends_at
WHERE a.period_id = sqlc.arg(period_id) AND a.status = 'scheduled'
LIMIT 1;

-- name: CreateTimeslot :one
INSERT INTO open_day_timeslots (id, open_day_id, starts_at, ends_at, position)
VALUES (sqlc.arg(id), sqlc.arg(open_day_id), sqlc.arg(starts_at), sqlc.arg(ends_at), sqlc.arg(position))
RETURNING *;

-- name: UpdateTimeslot :one
UPDATE open_day_timeslots
SET starts_at = sqlc.arg(starts_at), ends_at = sqlc.arg(ends_at), position = sqlc.arg(position)
WHERE id = sqlc.arg(id) AND open_day_id = sqlc.arg(open_day_id)
RETURNING *;

-- name: DeleteTimeslot :exec
DELETE FROM open_day_timeslots WHERE id = sqlc.arg(id) AND open_day_id = sqlc.arg(open_day_id);

-- name: ListTimeslotsByDays :many
SELECT * FROM open_day_timeslots
WHERE open_day_id = ANY(sqlc.arg(open_day_ids)::text[]::uuid[])
ORDER BY open_day_id, position;

-- name: GetTimeslot :one
SELECT * FROM open_day_timeslots WHERE id = sqlc.arg(id);

-- name: CancelOpenDay :one
UPDATE open_days SET status = 'cancelled', version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND status = 'scheduled'
RETURNING *;

-- name: DeleteOpenDay :one
DELETE FROM open_days WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING id;

-- name: CreateRequirement :one
INSERT INTO open_day_staff_requirements (id, open_day_id, timeslot_id, kind, required_count)
VALUES (sqlc.arg(id), sqlc.arg(open_day_id), sqlc.arg(timeslot_id), sqlc.arg(kind), sqlc.arg(required_count))
RETURNING *;

-- name: ListRequirementsByDays :many
SELECT r.*, (SELECT count(*) FROM open_day_assignments a WHERE a.requirement_id = r.id)::bigint AS assigned_count
FROM open_day_staff_requirements r
WHERE r.open_day_id = ANY(sqlc.arg(open_day_ids)::text[]::uuid[])
ORDER BY r.timeslot_id, r.kind;

-- name: ListRequirementRolesByDays :many
SELECT rr.requirement_id, rr.role_id
FROM open_day_staff_requirement_roles rr
JOIN open_day_staff_requirements r ON r.id = rr.requirement_id
WHERE r.open_day_id = ANY(sqlc.arg(open_day_ids)::text[]::uuid[])
ORDER BY rr.requirement_id, rr.role_id;

-- name: ListEligibleRequirementsByDays :many
-- The requirements of the days the person may take: the membership of the place's kind and, when the place names
-- extra roles, one of them.
SELECT r.id
FROM open_day_staff_requirements r
WHERE r.open_day_id = ANY(sqlc.arg(open_day_ids)::text[]::uuid[])
  AND EXISTS (
      SELECT 1 FROM person_roles mp JOIN roles m ON m.id = mp.role_id
      WHERE mp.person_id = sqlc.arg(person_id) AND m.system_key = r.kind
  )
  AND (
      NOT EXISTS (SELECT 1 FROM open_day_staff_requirement_roles rr WHERE rr.requirement_id = r.id)
      OR EXISTS (
          SELECT 1 FROM open_day_staff_requirement_roles rr
          JOIN person_roles pr ON pr.role_id = rr.role_id
          WHERE rr.requirement_id = r.id AND pr.person_id = sqlc.arg(person_id)
      )
  );

-- name: ListPeriodRequirementCounts :many
-- Places and assignments of the scheduled days of a period, for the period summary.
SELECT r.open_day_id, r.kind, r.required_count,
       (SELECT count(*) FROM open_day_assignments a WHERE a.requirement_id = r.id)::bigint AS assigned_count
FROM open_day_staff_requirements r
JOIN open_days d ON d.id = r.open_day_id AND d.status = 'scheduled'
WHERE d.period_id = sqlc.arg(period_id);

-- name: ListPersonDaysInPeriod :many
SELECT DISTINCT a.open_day_id
FROM open_day_assignments a
JOIN open_days d ON d.id = a.open_day_id AND d.status = 'scheduled'
WHERE d.period_id = sqlc.arg(period_id) AND a.person_id = sqlc.arg(person_id);

-- name: GetRequirement :one
SELECT * FROM open_day_staff_requirements WHERE id = sqlc.arg(id);

-- name: GetRequirementForUpdate :one
SELECT * FROM open_day_staff_requirements WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: UpdateRequirement :one
UPDATE open_day_staff_requirements SET required_count = sqlc.arg(required_count)
WHERE id = sqlc.arg(id) RETURNING *;

-- name: AddRequirementRole :exec
INSERT INTO open_day_staff_requirement_roles (requirement_id, role_id)
VALUES (sqlc.arg(requirement_id), sqlc.arg(role_id));

-- name: DeleteRequirementRoles :exec
DELETE FROM open_day_staff_requirement_roles WHERE requirement_id = sqlc.arg(requirement_id);

-- name: CountRequirementAssignments :one
SELECT count(*) FROM open_day_assignments WHERE requirement_id = sqlc.arg(requirement_id);

-- name: PersonEligibleForRequirement :one
-- A place of a kind needs the membership of that kind; its role list, when not empty, also asks for one of those
-- extra roles.
SELECT EXISTS (
    SELECT 1 FROM open_day_staff_requirements r
    JOIN person_roles mp ON mp.person_id = sqlc.arg(person_id)
    JOIN roles m ON m.id = mp.role_id AND m.system_key = r.kind
    WHERE r.id = sqlc.arg(requirement_id)
      AND (
          NOT EXISTS (SELECT 1 FROM open_day_staff_requirement_roles rr WHERE rr.requirement_id = r.id)
          OR EXISTS (
              SELECT 1 FROM open_day_staff_requirement_roles rr
              JOIN person_roles pr ON pr.role_id = rr.role_id
              WHERE rr.requirement_id = r.id AND pr.person_id = sqlc.arg(person_id)
          )
      )
);

-- name: ListEligiblePeople :many
-- The same eligibility as PersonEligibleForRequirement.
SELECT p.id, p.first_name, p.last_name
FROM people p
JOIN open_day_staff_requirements r ON r.id = sqlc.arg(requirement_id)
WHERE EXISTS (
      SELECT 1 FROM person_roles mp JOIN roles m ON m.id = mp.role_id
      WHERE mp.person_id = p.id AND m.system_key = r.kind
  )
  AND (
      NOT EXISTS (SELECT 1 FROM open_day_staff_requirement_roles rr WHERE rr.requirement_id = r.id)
      OR EXISTS (
          SELECT 1 FROM open_day_staff_requirement_roles rr
          JOIN person_roles pr ON pr.role_id = rr.role_id
          WHERE rr.requirement_id = r.id AND pr.person_id = p.id
      )
  )
  AND (sqlc.arg(search)::text = '' OR lower(p.first_name || ' ' || p.last_name) LIKE '%' || lower(sqlc.arg(search)::text) || '%')
ORDER BY p.last_name, p.first_name, p.id
LIMIT sqlc.arg(page_limit);

-- name: CreateAssignment :one
INSERT INTO open_day_assignments (id, open_day_id, timeslot_id, requirement_id, person_id, created_by_account_id)
VALUES (
    sqlc.arg(id), sqlc.arg(open_day_id), sqlc.arg(timeslot_id), sqlc.arg(requirement_id), sqlc.arg(person_id),
    sqlc.arg(created_by_account_id)
)
RETURNING *;

-- name: ListAssignmentsByDays :many
SELECT a.id, a.open_day_id, a.timeslot_id, a.requirement_id, a.person_id, a.created_by_account_id, a.created_at,
       p.first_name, p.last_name, (p.profile_image_file_id IS NOT NULL)::boolean AS has_profile_image
FROM open_day_assignments a JOIN people p ON p.id = a.person_id
WHERE a.open_day_id = ANY(sqlc.arg(open_day_ids)::text[]::uuid[])
ORDER BY a.created_at, a.id;

-- name: GetAssignmentProfileImageFile :one
SELECT p.profile_image_file_id
FROM open_day_assignments a JOIN people p ON p.id = a.person_id
WHERE a.id = sqlc.arg(id) AND a.open_day_id = sqlc.arg(open_day_id);

-- name: GetAssignment :one
SELECT * FROM open_day_assignments WHERE id = sqlc.arg(id);

-- name: GetAssignmentPersonName :one
SELECT first_name, last_name, (profile_image_file_id IS NOT NULL)::boolean AS has_profile_image
FROM people WHERE id = sqlc.arg(id);

-- name: GetPersonTimeslotAssignment :one
SELECT * FROM open_day_assignments
WHERE timeslot_id = sqlc.arg(timeslot_id) AND person_id = sqlc.arg(person_id);

-- name: ListUpcomingAssignmentsForPerson :many
-- One row per timeslot the person holds; the times are the timeslot's.
SELECT a.id AS assignment_id, d.id AS open_day_id, a.timeslot_id, d.period_id, p.name AS period_name,
       t.starts_at, t.ends_at, r.kind
FROM open_day_assignments a
JOIN open_days d ON d.id = a.open_day_id
JOIN open_day_timeslots t ON t.id = a.timeslot_id
JOIN open_day_periods p ON p.id = d.period_id
JOIN open_day_staff_requirements r ON r.id = a.requirement_id
WHERE a.person_id = sqlc.arg(person_id)
  AND d.status = 'scheduled'
  AND t.starts_at >= now()
  AND p.status IN ('staffing', 'published')
ORDER BY t.starts_at, d.id;

-- name: ListPeriodAssignmentSlots :many
-- Who holds which timeslot of the period's days, with the timeslot's current times and its day's status. A schedule
-- save compares this before and after its writes to tell people what changed for them.
SELECT a.id, a.person_id, a.open_day_id, a.timeslot_id, t.starts_at, t.ends_at, d.status
FROM open_day_assignments a
JOIN open_days d ON d.id = a.open_day_id
JOIN open_day_timeslots t ON t.id = a.timeslot_id
WHERE d.period_id = sqlc.arg(period_id);

-- name: DeleteAssignment :one
DELETE FROM open_day_assignments WHERE id = sqlc.arg(id) RETURNING *;

-- name: ListEligibilityRoles :many
-- Membership decides the kind of place; only extra roles can restrict a place further.
SELECT id, name FROM roles WHERE system_key IS NULL ORDER BY lower(name), id;

-- name: CreateAcademicBreak :one
INSERT INTO open_day_academic_breaks (id, name, starts_on, ends_on)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(starts_on), sqlc.arg(ends_on)) RETURNING *;

-- name: ListAcademicBreaks :many
SELECT * FROM open_day_academic_breaks
ORDER BY starts_on, ends_on, lower(name), id;

-- name: ListAcademicBreaksInRange :many
SELECT * FROM open_day_academic_breaks
WHERE starts_on <= sqlc.arg(ends_on) AND ends_on >= sqlc.arg(starts_on)
ORDER BY starts_on, ends_on, id;

-- name: GetAcademicBreakForUpdate :one
SELECT * FROM open_day_academic_breaks WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: UpdateAcademicBreak :one
UPDATE open_day_academic_breaks
SET name = sqlc.arg(name), starts_on = sqlc.arg(starts_on), ends_on = sqlc.arg(ends_on),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING *;

-- name: DeleteAcademicBreak :one
DELETE FROM open_day_academic_breaks WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING id;

-- name: ListOwnComingUpOpenDays :many
-- Upcoming (not yet ended) timeslots of scheduled open days the person is on, with the supervisor places still open
-- in each.
SELECT a.id AS assignment_id, d.id AS open_day_id, a.timeslot_id, d.period_id, p.name AS period_name,
       t.starts_at, t.ends_at, COALESCE(sup.open_places, 0)::bigint AS open_supervisor_places
FROM open_day_assignments a
JOIN open_days d ON d.id = a.open_day_id AND d.status = 'scheduled'
JOIN open_day_timeslots t ON t.id = a.timeslot_id
JOIN open_day_periods p ON p.id = d.period_id AND p.status IN ('staffing', 'published')
LEFT JOIN LATERAL (
    SELECT GREATEST(0, sr.required_count - (
        SELECT count(*) FROM open_day_assignments sa WHERE sa.requirement_id = sr.id
    ))::bigint AS open_places
    FROM open_day_staff_requirements sr
    WHERE sr.timeslot_id = t.id AND sr.kind = 'supervisor'
) sup ON true
WHERE a.person_id = sqlc.arg(person_id) AND t.ends_at > sqlc.arg(now)
ORDER BY t.starts_at, d.id;

-- name: GetNextOpenPlace :one
-- The next timeslot starting within the window that the person is not in yet and that has a free place of the given
-- kind they are eligible for.
SELECT d.id AS open_day_id, d.period_id, t.id AS timeslot_id, r.id AS requirement_id, t.starts_at, t.ends_at,
       (r.required_count - (SELECT count(*) FROM open_day_assignments sa WHERE sa.requirement_id = r.id))::bigint AS free_places
FROM open_days d
JOIN open_day_periods p ON p.id = d.period_id AND p.status IN ('staffing', 'published')
JOIN open_day_timeslots t ON t.open_day_id = d.id
JOIN open_day_staff_requirements r ON r.timeslot_id = t.id AND r.kind = sqlc.arg(kind)
WHERE d.status = 'scheduled'
  AND t.starts_at > sqlc.arg(now) AND t.starts_at <= sqlc.arg(until)
  AND NOT EXISTS (
      SELECT 1 FROM open_day_assignments ma WHERE ma.timeslot_id = t.id AND ma.person_id = sqlc.arg(person_id)
  )
  AND r.required_count > (SELECT count(*) FROM open_day_assignments sa WHERE sa.requirement_id = r.id)
  AND EXISTS (
      SELECT 1 FROM person_roles mp JOIN roles m ON m.id = mp.role_id
      WHERE mp.person_id = sqlc.arg(person_id) AND m.system_key = r.kind
  )
  AND (
      NOT EXISTS (SELECT 1 FROM open_day_staff_requirement_roles rr WHERE rr.requirement_id = r.id)
      OR EXISTS (
          SELECT 1 FROM open_day_staff_requirement_roles rr
          JOIN person_roles pr ON pr.role_id = rr.role_id
          WHERE rr.requirement_id = r.id AND pr.person_id = sqlc.arg(person_id)
      )
  )
ORDER BY t.starts_at, d.id
LIMIT 1;

-- name: GetOwnOpenDayStatistics :one
-- Ended scheduled open days the person staffed, all time, with the scheduled duration of their ended timeslots in
-- seconds.
SELECT count(DISTINCT a.open_day_id)::bigint AS staffed,
       COALESCE(sum(extract(epoch FROM t.ends_at - t.starts_at)), 0)::float8 AS scheduled_seconds
FROM open_day_assignments a
JOIN open_days d ON d.id = a.open_day_id AND d.status = 'scheduled'
JOIN open_day_timeslots t ON t.id = a.timeslot_id
WHERE a.person_id = sqlc.arg(person_id) AND t.ends_at <= sqlc.arg(now);

-- name: CreateSeries :one
INSERT INTO open_day_series (
    id, period_id, weekday, from_date, until_date, supervisor_places, trainee_places, forced_dates
)
VALUES (
    sqlc.arg(id), sqlc.arg(period_id), sqlc.arg(weekday), sqlc.arg(from_date), sqlc.arg(until_date),
    sqlc.arg(supervisor_places), sqlc.arg(trainee_places), sqlc.arg(forced_dates)::text[]::date[]
)
RETURNING *;

-- name: UpdateSeries :one
UPDATE open_day_series
SET until_date = sqlc.arg(until_date), supervisor_places = sqlc.arg(supervisor_places),
    trainee_places = sqlc.arg(trainee_places), forced_dates = sqlc.arg(forced_dates)::text[]::date[],
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: ListSeriesByPeriod :many
SELECT * FROM open_day_series WHERE period_id = sqlc.arg(period_id) ORDER BY weekday, from_date, id;

-- name: CreateSeriesTimeslot :exec
INSERT INTO open_day_series_timeslots (series_id, position, start_time, end_time)
VALUES (sqlc.arg(series_id), sqlc.arg(position), sqlc.arg(start_time), sqlc.arg(end_time));

-- name: DeleteSeriesTimeslots :exec
DELETE FROM open_day_series_timeslots WHERE series_id = sqlc.arg(series_id);

-- name: ListSeriesTimeslots :many
SELECT st.series_id, st.position, st.start_time, st.end_time
FROM open_day_series_timeslots st
JOIN open_day_series s ON s.id = st.series_id
WHERE s.period_id = sqlc.arg(period_id)
ORDER BY st.series_id, st.position;

-- name: AddSeriesRole :exec
INSERT INTO open_day_series_roles (series_id, kind, role_id)
VALUES (sqlc.arg(series_id), sqlc.arg(kind), sqlc.arg(role_id));

-- name: DeleteSeriesRoles :exec
DELETE FROM open_day_series_roles WHERE series_id = sqlc.arg(series_id);

-- name: ListSeriesRoles :many
SELECT sr.series_id, sr.kind, sr.role_id
FROM open_day_series_roles sr
JOIN open_day_series s ON s.id = sr.series_id
WHERE s.period_id = sqlc.arg(period_id)
ORDER BY sr.series_id, sr.kind, sr.role_id;

-- name: CountSeriesDays :many
-- Scheduled days that follow each series of the period.
SELECT series_id::uuid AS series_id, count(*)::bigint AS day_count
FROM open_days
WHERE period_id = sqlc.arg(period_id) AND series_id IS NOT NULL AND status = 'scheduled'
GROUP BY series_id;

-- name: GetSeriesForUpdate :one
SELECT * FROM open_day_series WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: CountExtraRoles :one
-- How many of the roles exist and are extra roles; membership and system roles cannot restrict a place.
SELECT count(*)::bigint FROM roles WHERE id = ANY(sqlc.arg(ids)::text[]::uuid[]) AND system_key IS NULL;
