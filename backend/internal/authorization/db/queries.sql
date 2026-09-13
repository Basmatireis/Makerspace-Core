-- name: GetPrincipalRolePermissions :many
SELECT r.id AS role_id, r.system_key, rp.permission_id
FROM account_roles ar JOIN roles r ON r.id = ar.role_id
LEFT JOIN role_permissions rp ON rp.role_id = r.id
WHERE ar.account_id = sqlc.arg(account_id) ORDER BY r.id, rp.permission_id;
