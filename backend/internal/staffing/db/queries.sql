-- name: GetOpenDayRequirements :one
SELECT * FROM open_day_requirements WHERE singleton = true;

-- name: GetOpenDayRequirementsForUpdate :one
SELECT * FROM open_day_requirements WHERE singleton = true FOR UPDATE;

-- name: UpdateOpenDayRequirements :one
UPDATE open_day_requirements SET
    min_open_days_per_semester = sqlc.arg(min_open_days_per_semester),
    trainee_open_days_for_promotion = sqlc.arg(trainee_open_days_for_promotion),
    supervisor_role_id = sqlc.narg(supervisor_role_id),
    version = version + 1,
    updated_by_account_id = sqlc.narg(updated_by_account_id),
    updated_at = now()
WHERE singleton = true AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: GetRoleStaffingLevelForShare :one
-- Locks the role so its staffing level cannot change while the requirements settings reference it.
SELECT staffing_level FROM roles WHERE id = sqlc.arg(id) FOR SHARE;

-- name: ListSemesterCandidates :many
-- Periods a semester can be resolved from: neither draft nor archived.
SELECT id, name, starts_on, ends_on
FROM open_day_periods
WHERE status IN ('staffing', 'published')
ORDER BY starts_on, id;

-- name: ListPersonStaffingLevels :many
SELECT DISTINCT r.staffing_level::text AS staffing_level
FROM person_roles pr
JOIN roles r ON r.id = pr.role_id
WHERE pr.person_id = sqlc.arg(person_id) AND r.staffing_level IS NOT NULL;

-- name: ListStaffingCounts :many
-- Open days per person in one period: ended (staffed), upcoming (booked) and ended as trainee. Cancelled open days
-- do not count. A NULL period yields all zeros. person_id narrows the result to one person.
SELECT a.person_id,
    count(*) FILTER (WHERE d.period_id = sqlc.narg(period_id) AND d.ends_at <= sqlc.arg(now))::bigint AS staffed,
    count(*) FILTER (WHERE d.period_id = sqlc.narg(period_id) AND d.ends_at > sqlc.arg(now))::bigint AS booked,
    count(*) FILTER (
        WHERE d.period_id = sqlc.narg(period_id) AND d.ends_at <= sqlc.arg(now) AND r.kind = 'trainee'
    )::bigint AS staffed_as_trainee
FROM open_day_assignments a
JOIN open_days d ON d.id = a.open_day_id AND d.status = 'scheduled'
JOIN open_day_staff_requirements r ON r.id = a.requirement_id
WHERE sqlc.narg(only_person_id)::uuid IS NULL OR a.person_id = sqlc.narg(only_person_id)
GROUP BY a.person_id;

-- name: ListLastStaffed :many
-- Start of the last ended open day each person staffed in any semester.
SELECT DISTINCT ON (a.person_id) a.person_id, d.starts_at
FROM open_day_assignments a
JOIN open_days d ON d.id = a.open_day_id AND d.status = 'scheduled'
WHERE d.ends_at <= sqlc.arg(now)
  AND (sqlc.narg(only_person_id)::uuid IS NULL OR a.person_id = sqlc.narg(only_person_id))
ORDER BY a.person_id, d.starts_at DESC, d.id;
