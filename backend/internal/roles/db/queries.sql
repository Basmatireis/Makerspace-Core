-- name: CreateRole :one
INSERT INTO roles (id, name, description) VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.narg(description)) RETURNING *;

-- name: ListRoles :many
SELECT * FROM roles ORDER BY system_key DESC NULLS LAST, lower(name), id;

-- name: GetRole :one
SELECT * FROM roles WHERE id = sqlc.arg(id);

-- name: GetRoleForMutation :one
SELECT * FROM roles WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: UpdateRole :one
UPDATE roles SET name = sqlc.arg(name), description = sqlc.narg(description), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND system_key IS NULL RETURNING *;

-- name: DeleteRole :one
DELETE FROM roles WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND system_key IS NULL RETURNING id;

-- name: GetRolePermissions :many
SELECT permission_id FROM role_permissions WHERE role_id = sqlc.arg(role_id) ORDER BY permission_id;

-- name: DeleteRolePermissions :exec
DELETE FROM role_permissions WHERE role_id = sqlc.arg(role_id);

-- name: AddRolePermission :exec
INSERT INTO role_permissions (role_id, permission_id) VALUES (sqlc.arg(role_id), sqlc.arg(permission_id));

-- name: BumpRoleVersion :one
UPDATE roles SET version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND system_key IS NULL RETURNING *;

-- name: RoleAssignmentCount :one
SELECT count(*) FROM account_roles WHERE role_id = sqlc.arg(role_id);
