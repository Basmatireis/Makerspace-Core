-- name: GetOwnDashboardPerson :one
SELECT first_name, member_since FROM people WHERE id = sqlc.arg(id);

-- name: GetOwnMembership :one
-- The person's membership role and when it was assigned.
SELECT r.system_key::text AS membership, pr.assigned_at
FROM person_roles pr
JOIN roles r ON r.id = pr.role_id
WHERE pr.person_id = sqlc.arg(person_id) AND r.system_key IN ('supervisor', 'trainee', 'visitor')
ORDER BY CASE r.system_key WHEN 'supervisor' THEN 0 WHEN 'trainee' THEN 1 ELSE 2 END
LIMIT 1;
