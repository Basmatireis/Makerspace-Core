-- name: GetPrincipalRolePermissions :many
SELECT r.id AS role_id, r.system_key, rp.permission_id, rp.scope, rpdt.device_type_id
FROM account_roles ar JOIN roles r ON r.id = ar.role_id
LEFT JOIN role_permissions rp ON rp.role_id = r.id
LEFT JOIN role_permission_device_types rpdt
  ON rpdt.role_id = rp.role_id AND rpdt.permission_id = rp.permission_id
WHERE ar.account_id = sqlc.arg(account_id) ORDER BY r.id, rp.permission_id, rpdt.device_type_id;
