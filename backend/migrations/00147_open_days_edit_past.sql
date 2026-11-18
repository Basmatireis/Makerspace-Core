-- +goose Up
-- Changing an Open Day that has ended, or who staffed it, now needs open_days.edit_past besides open_days.manage or
-- open_days.assign. Every role that manages Open Days today keeps that ability: it gets the new permission with the
-- same assurance as its global open_days.manage grant. The master role derives its permissions from application
-- code and needs no rows.
INSERT INTO role_permission_grants (id, role_id, permission_id, scope, minimum_assurance)
SELECT uuidv7(), g.role_id, 'open_days.edit_past', 'global', g.minimum_assurance
FROM role_permission_grants g
WHERE g.permission_id = 'open_days.manage' AND g.scope = 'global'
  AND NOT EXISTS (
      SELECT 1 FROM role_permission_grants existing
      WHERE existing.role_id = g.role_id AND existing.permission_id = 'open_days.edit_past' AND existing.scope = 'global'
  );

-- +goose Down
DELETE FROM role_permission_grants WHERE permission_id = 'open_days.edit_past';
