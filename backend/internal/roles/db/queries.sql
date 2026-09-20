-- name: CreateRole :one
INSERT INTO roles (id, name, description, profile_image_required, laborordnung_mode, supervisor_dashboard)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.narg(description), sqlc.arg(profile_image_required), sqlc.arg(laborordnung_mode), sqlc.arg(supervisor_dashboard)) RETURNING *;

-- name: ListRoles :many
SELECT * FROM roles ORDER BY system_key DESC NULLS LAST, lower(name), id;

-- name: GetRole :one
SELECT * FROM roles WHERE id = sqlc.arg(id);

-- name: GetRoleForMutation :one
SELECT * FROM roles WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: UpdateRole :one
UPDATE roles SET name = sqlc.arg(name), description = sqlc.narg(description),
    profile_image_required = sqlc.arg(profile_image_required),
    laborordnung_mode = sqlc.arg(laborordnung_mode), supervisor_dashboard = sqlc.arg(supervisor_dashboard),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND system_key IS NULL RETURNING *;

-- name: DeleteRole :one
DELETE FROM roles WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND system_key IS NULL RETURNING id;

-- name: GetRolePermissionGrants :many
SELECT g.id, g.permission_id, g.scope, g.minimum_assurance, gdt.device_type_id
FROM role_permission_grants g LEFT JOIN role_permission_grant_device_types gdt ON gdt.grant_id = g.id
WHERE g.role_id = sqlc.arg(role_id)
ORDER BY g.permission_id, g.id, gdt.device_type_id;

-- name: DeleteRolePermissions :exec
DELETE FROM role_permission_grants WHERE role_id = sqlc.arg(role_id);

-- name: AddRolePermission :exec
INSERT INTO role_permission_grants (id, role_id, permission_id, scope, minimum_assurance)
VALUES (sqlc.arg(id), sqlc.arg(role_id), sqlc.arg(permission_id), sqlc.arg(scope), sqlc.arg(minimum_assurance));

-- name: AddRolePermissionDeviceType :exec
INSERT INTO role_permission_grant_device_types (grant_id, device_type_id)
VALUES (sqlc.arg(grant_id), sqlc.arg(device_type_id));

-- name: BumpRoleVersion :one
UPDATE roles SET version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND system_key IS NULL RETURNING *;

-- name: RoleAssignmentCount :one
SELECT count(*) FROM account_roles WHERE role_id = sqlc.arg(role_id);
