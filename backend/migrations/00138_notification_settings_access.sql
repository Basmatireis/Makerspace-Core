-- +goose Up
-- A session can be restricted to one purpose. 'notification_settings' is what an account without web.sign_in (a
-- visitor) gets when it signs in with an emailed code from the link in a mail footer: it may only read and change its
-- own notification settings. The HTTP layer derives the operations such a session may call from the contract.
ALTER TABLE sessions
    ADD COLUMN restriction text CONSTRAINT sessions_restriction_check CHECK (restriction IN ('notification_settings'));
-- A sign-in that waits for its second factor carries the restriction to the session it creates.
ALTER TABLE pending_logins
    ADD COLUMN restriction text
        CONSTRAINT pending_logins_restriction_check CHECK (restriction IN ('notification_settings'));

-- Staff may see and change other people's notification settings. Both permissions go to the Supervisor membership
-- role, identified by its system key; changing needs a normal sign-in, so a PIN session at a tablet can only look. The
-- master role derives its permissions from application code and needs no rows.
INSERT INTO role_permission_grants (id, role_id, permission_id, scope, minimum_assurance)
SELECT uuidv7(), r.id, grant_row.permission_id, 'global', grant_row.minimum_assurance
FROM roles r
CROSS JOIN (VALUES ('notification_settings.read.all', 'low'), ('notification_settings.manage.all', 'normal'))
    AS grant_row (permission_id, minimum_assurance)
WHERE r.system_key = 'supervisor'
  AND NOT EXISTS (
      SELECT 1 FROM role_permission_grants g
      WHERE g.role_id = r.id AND g.permission_id = grant_row.permission_id AND g.scope = 'global'
  );

-- +goose Down
DELETE FROM role_permission_grants
WHERE permission_id IN ('notification_settings.read.all', 'notification_settings.manage.all');
-- Restricted sessions and sign-ins would become full ones without the column.
DELETE FROM sessions WHERE restriction IS NOT NULL;
DELETE FROM pending_logins WHERE restriction IS NOT NULL;
ALTER TABLE pending_logins DROP COLUMN restriction;
ALTER TABLE sessions DROP COLUMN restriction;
