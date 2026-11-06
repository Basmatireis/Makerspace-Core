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

-- name: ListNextAssignments :many
-- The next upcoming open day each person is assigned to, in any semester.
SELECT DISTINCT ON (a.person_id) a.person_id, d.id AS open_day_id, d.starts_at, d.ends_at
FROM open_day_assignments a
JOIN open_days d ON d.id = a.open_day_id AND d.status = 'scheduled'
WHERE d.ends_at > sqlc.arg(now)
  AND (sqlc.narg(only_person_id)::uuid IS NULL OR a.person_id = sqlc.narg(only_person_id))
ORDER BY a.person_id, d.starts_at, d.id;
