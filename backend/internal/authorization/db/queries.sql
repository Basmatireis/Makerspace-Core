-- name: GetPrincipalRolePermissions :many
SELECT r.id AS role_id, r.system_key, g.id AS grant_id, g.permission_id, g.scope,
       g.minimum_assurance, gdt.device_type_id
FROM account_roles ar JOIN roles r ON r.id = ar.role_id
LEFT JOIN role_permission_grants g ON g.role_id = r.id
LEFT JOIN role_permission_grant_device_types gdt ON gdt.grant_id = g.id
WHERE ar.account_id = sqlc.arg(account_id) ORDER BY r.id, g.permission_id, g.id, gdt.device_type_id;
