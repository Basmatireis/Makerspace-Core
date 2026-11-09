-- +goose Up
-- web.sign_in: a person may sign in to the web application only when a role grants it. Every existing role except the
-- Visitor membership role keeps its holders' web access; visitors become kiosk-only. The master role derives its
-- permissions from application code and has no grants, so it needs no row.
-- +goose StatementBegin
INSERT INTO role_permission_grants (id, role_id, permission_id, scope, minimum_assurance)
SELECT uuidv7(), r.id, 'web.sign_in', 'global', 'low'
FROM roles r
WHERE r.system_key IS DISTINCT FROM 'master' AND r.system_key IS DISTINCT FROM 'visitor'
  AND NOT EXISTS (
      SELECT 1 FROM role_permission_grants g
      WHERE g.role_id = r.id AND g.permission_id = 'web.sign_in' AND g.scope = 'global'
  );
-- +goose StatementEnd

-- +goose Down
DELETE FROM role_permission_grants WHERE permission_id = 'web.sign_in';
DELETE FROM master_reauthentication_permissions WHERE permission_id = 'web.sign_in';
