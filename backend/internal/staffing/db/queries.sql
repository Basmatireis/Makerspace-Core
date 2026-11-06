-- name: GetStaffingRules :one
SELECT * FROM staffing_rules WHERE singleton = true;

-- name: GetStaffingRulesForUpdate :one
SELECT * FROM staffing_rules WHERE singleton = true FOR UPDATE;

-- name: UpdateStaffingRules :one
UPDATE staffing_rules SET
    supervisor_minimum = sqlc.arg(supervisor_minimum),
    trainee_minimum = sqlc.arg(trainee_minimum),
    trainee_ready_after = sqlc.arg(trainee_ready_after),
    warning_window_days = sqlc.arg(warning_window_days),
    count_by = sqlc.arg(count_by),
    default_deadline = sqlc.arg(default_deadline),
    version = version + 1,
    updated_by_account_id = sqlc.narg(updated_by_account_id),
    updated_at = now()
WHERE singleton = true AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: ListStaffingRuleExceptions :many
SELECT e.role_id, r.name AS role_name, e.minimum
FROM staffing_rule_exceptions e
JOIN roles r ON r.id = e.role_id
ORDER BY lower(r.name), r.id;

-- name: DeleteStaffingRuleExceptions :exec
DELETE FROM staffing_rule_exceptions;

-- name: InsertStaffingRuleException :exec
INSERT INTO staffing_rule_exceptions (role_id, minimum) VALUES (sqlc.arg(role_id), sqlc.arg(minimum));

-- name: GetRoleSystemKeyForShare :one
-- Locks the role so it cannot be deleted while the rules gain an exception for it.
SELECT system_key FROM roles WHERE id = sqlc.arg(id) FOR SHARE;

-- name: ListSemesterCandidates :many
-- Periods a semester can be resolved from: neither draft nor archived.
SELECT id, name, status, starts_on, ends_on, sign_up_deadline
FROM open_day_periods
WHERE status IN ('staffing', 'published')
ORDER BY starts_on, id;

-- name: GetSemesterPeriod :one
SELECT id, name, status, starts_on, ends_on, sign_up_deadline FROM open_day_periods WHERE id = sqlc.arg(id);

-- name: GetPeriodForShare :one
-- Locks the period so it cannot be deleted while an excusal for it is written.
SELECT id FROM open_day_periods WHERE id = sqlc.arg(id) FOR SHARE;

-- name: GetPersonForShare :one
-- Locks the person so they cannot be deleted while an excusal for them is written.
SELECT id FROM people WHERE id = sqlc.arg(id) FOR SHARE;

-- name: GetPersonMembership :one
SELECT r.system_key::text AS membership
FROM person_roles pr
JOIN roles r ON r.id = pr.role_id
WHERE pr.person_id = sqlc.arg(person_id) AND r.system_key IN ('supervisor', 'trainee', 'visitor')
ORDER BY CASE r.system_key WHEN 'supervisor' THEN 0 WHEN 'trainee' THEN 1 ELSE 2 END
LIMIT 1;

-- name: ListPersonExceptions :many
-- The exceptions of each person's extra roles; only_person_id narrows it to one person.
SELECT pr.person_id, e.role_id, r.name AS role_name, e.minimum
FROM person_roles pr
JOIN staffing_rule_exceptions e ON e.role_id = pr.role_id
JOIN roles r ON r.id = e.role_id
WHERE sqlc.narg(only_person_id)::uuid IS NULL OR pr.person_id = sqlc.narg(only_person_id)
ORDER BY pr.person_id, e.minimum, lower(r.name), r.id;

-- name: ListExcusals :many
SELECT period_id, person_id, reason, created_at
FROM staffing_excusals
WHERE period_id = sqlc.arg(period_id)
  AND (sqlc.narg(only_person_id)::uuid IS NULL OR person_id = sqlc.narg(only_person_id));

-- name: UpsertExcusal :one
INSERT INTO staffing_excusals (period_id, person_id, reason, created_by_account_id)
VALUES (sqlc.arg(period_id), sqlc.arg(person_id), sqlc.arg(reason), sqlc.narg(created_by_account_id))
ON CONFLICT (period_id, person_id) DO UPDATE
SET reason = EXCLUDED.reason, created_by_account_id = EXCLUDED.created_by_account_id, created_at = now()
RETURNING period_id, person_id, reason, created_at;

-- name: DeleteExcusal :execrows
DELETE FROM staffing_excusals WHERE period_id = sqlc.arg(period_id) AND person_id = sqlc.arg(person_id);

-- name: ListStaffingCounts :many
-- Staffing per person in one period: ended (staffed), upcoming (booked) and ended as trainee. count_by 'timeslot'
-- counts every timeslot held; 'open_day' counts every day with at least one, which has ended when the person's last
-- timeslot of it has and counts as trainee when they held a trainee place in it. Cancelled open days do not count.
-- person_id narrows the result to one person.
SELECT u.person_id,
    sum(CASE WHEN u.unit_ends_at <= sqlc.arg(now)::timestamptz THEN 1 ELSE 0 END)::bigint AS staffed,
    sum(CASE WHEN u.unit_ends_at > sqlc.arg(now)::timestamptz THEN 1 ELSE 0 END)::bigint AS booked,
    sum(CASE WHEN u.unit_ends_at <= sqlc.arg(now)::timestamptz AND u.unit_as_trainee THEN 1 ELSE 0 END)::bigint
        AS staffed_as_trainee
FROM (
    SELECT a.person_id,
        CASE WHEN sqlc.arg(count_by)::text = 'open_day' THEN a.open_day_id ELSE a.timeslot_id END AS unit_id,
        max(t.ends_at) AS unit_ends_at,
        bool_or(r.kind = 'trainee') AS unit_as_trainee
    FROM open_day_assignments a
    JOIN open_days d ON d.id = a.open_day_id AND d.status = 'scheduled' AND d.period_id = sqlc.narg(period_id)
    JOIN open_day_timeslots t ON t.id = a.timeslot_id
    JOIN open_day_staff_requirements r ON r.id = a.requirement_id
    WHERE sqlc.narg(only_person_id)::uuid IS NULL OR a.person_id = sqlc.narg(only_person_id)
    GROUP BY 1, 2
) u
GROUP BY u.person_id;

-- name: ListLastStaffed :many
-- Start of the last ended timeslot each person staffed in any semester.
SELECT DISTINCT ON (a.person_id) a.person_id, t.starts_at
FROM open_day_assignments a
JOIN open_days d ON d.id = a.open_day_id AND d.status = 'scheduled'
JOIN open_day_timeslots t ON t.id = a.timeslot_id
WHERE t.ends_at <= sqlc.arg(now)
  AND (sqlc.narg(only_person_id)::uuid IS NULL OR a.person_id = sqlc.narg(only_person_id))
ORDER BY a.person_id, t.starts_at DESC, d.id;

-- name: ListNextAssignments :many
-- The next upcoming timeslot each person is assigned to, in any semester.
SELECT DISTINCT ON (a.person_id) a.person_id, d.id AS open_day_id, t.starts_at, t.ends_at
FROM open_day_assignments a
JOIN open_days d ON d.id = a.open_day_id AND d.status = 'scheduled'
JOIN open_day_timeslots t ON t.id = a.timeslot_id
WHERE t.ends_at > sqlc.arg(now)
  AND (sqlc.narg(only_person_id)::uuid IS NULL OR a.person_id = sqlc.narg(only_person_id))
ORDER BY a.person_id, t.starts_at, d.id;
