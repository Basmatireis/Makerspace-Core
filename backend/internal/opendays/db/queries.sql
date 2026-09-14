-- name: CreatePeriod :one
INSERT INTO open_day_periods (id, name, starts_on, ends_on)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(starts_on), sqlc.arg(ends_on)) RETURNING *;

-- name: ListPeriods :many
SELECT * FROM open_day_periods ORDER BY starts_on DESC, id DESC;

-- name: GetPeriod :one
SELECT * FROM open_day_periods WHERE id = sqlc.arg(id);

-- name: GetPeriodForUpdate :one
SELECT * FROM open_day_periods WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: UpdatePeriod :one
UPDATE open_day_periods
SET name = sqlc.arg(name), starts_on = sqlc.arg(starts_on), ends_on = sqlc.arg(ends_on),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND status = 'draft'
RETURNING *;

-- name: TransitionPeriod :one
UPDATE open_day_periods
SET status = sqlc.arg(status), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: BumpPeriodVersion :one
UPDATE open_day_periods SET version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING *;

-- name: CreateOpenDay :one
INSERT INTO open_days (id, period_id, starts_at, ends_at, internal_note)
VALUES (sqlc.arg(id), sqlc.arg(period_id), sqlc.arg(starts_at), sqlc.arg(ends_at), sqlc.narg(internal_note))
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
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND status = 'scheduled'
RETURNING *;

-- name: CancelOpenDay :one
UPDATE open_days SET status = 'cancelled', version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND status = 'scheduled'
RETURNING *;

-- name: DeleteOpenDay :one
DELETE FROM open_days WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING id;

-- name: CreateRequirement :one
INSERT INTO open_day_staff_requirements (id, open_day_id, kind, required_count)
VALUES (sqlc.arg(id), sqlc.arg(open_day_id), sqlc.arg(kind), sqlc.arg(required_count)) RETURNING *;

-- name: ListRequirements :many
SELECT * FROM open_day_staff_requirements WHERE open_day_id = sqlc.arg(open_day_id) ORDER BY kind;

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

-- name: ListRequirementRoleIDs :many
SELECT role_id FROM open_day_staff_requirement_roles
WHERE requirement_id = sqlc.arg(requirement_id) ORDER BY role_id;

-- name: CountRequirementAssignments :one
SELECT count(*) FROM open_day_assignments WHERE requirement_id = sqlc.arg(requirement_id);

-- name: PersonEligibleForRequirement :one
SELECT EXISTS (
    SELECT 1 FROM people p
    JOIN accounts a ON a.person_id = p.id AND a.status = 'enabled'
    JOIN account_roles ar ON ar.account_id = a.id
    JOIN open_day_staff_requirement_roles rr ON rr.role_id = ar.role_id
    WHERE p.id = sqlc.arg(person_id) AND rr.requirement_id = sqlc.arg(requirement_id)
);

-- name: ListEligiblePeople :many
SELECT DISTINCT p.id, p.first_name, p.last_name
FROM people p
JOIN accounts a ON a.person_id = p.id AND a.status = 'enabled'
JOIN account_roles ar ON ar.account_id = a.id
JOIN open_day_staff_requirement_roles rr ON rr.role_id = ar.role_id
WHERE rr.requirement_id = sqlc.arg(requirement_id)
  AND (sqlc.arg(search)::text = '' OR lower(p.first_name || ' ' || p.last_name) LIKE '%' || lower(sqlc.arg(search)::text) || '%')
ORDER BY p.last_name, p.first_name, p.id
LIMIT sqlc.arg(page_limit);

-- name: CreateAssignment :one
INSERT INTO open_day_assignments (id, open_day_id, requirement_id, person_id, created_by_account_id)
VALUES (sqlc.arg(id), sqlc.arg(open_day_id), sqlc.arg(requirement_id), sqlc.arg(person_id), sqlc.arg(created_by_account_id))
RETURNING *;

-- name: ListAssignments :many
SELECT a.id, a.open_day_id, a.requirement_id, a.person_id, a.created_by_account_id, a.created_at,
       p.first_name, p.last_name
FROM open_day_assignments a JOIN people p ON p.id = a.person_id
WHERE a.open_day_id = sqlc.arg(open_day_id)
ORDER BY a.created_at, a.id;

-- name: GetAssignment :one
SELECT * FROM open_day_assignments WHERE id = sqlc.arg(id);

-- name: GetPersonOpenDayAssignment :one
SELECT * FROM open_day_assignments
WHERE open_day_id = sqlc.arg(open_day_id) AND person_id = sqlc.arg(person_id);

-- name: DeleteAssignment :one
DELETE FROM open_day_assignments WHERE id = sqlc.arg(id) RETURNING *;

-- name: ListEligibilityRoles :many
SELECT id, name FROM roles ORDER BY system_key DESC NULLS LAST, lower(name), id;

-- name: CreateAcademicBreak :one
INSERT INTO open_day_academic_breaks (id, name, starts_on, ends_on)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(starts_on), sqlc.arg(ends_on)) RETURNING *;

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
