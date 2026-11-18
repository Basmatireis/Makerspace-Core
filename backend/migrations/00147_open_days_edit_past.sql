-- +goose Up
-- Changing an Open Day that has ended, or who staffed it, now needs open_days.edit_past besides open_days.manage or
-- open_days.assign. Every role that manages Open Days today keeps that ability: each open_days.manage grant is copied
-- to open_days.edit_past with its scope, assurance, fresh-sign-in window and device types. A fresh sign-in the master
-- role needs for open_days.manage applies to the new permission as well; otherwise master derives its permissions
-- from application code and needs no rows.
-- +goose StatementBegin
DO $$
DECLARE
    source record;
    new_grant uuid;
BEGIN
    FOR source IN
        SELECT g.id, g.role_id, g.scope, g.minimum_assurance, g.reauth_within_minutes
        FROM role_permission_grants g
        WHERE g.permission_id = 'open_days.manage'
          AND NOT EXISTS (
              SELECT 1 FROM role_permission_grants existing
              WHERE existing.role_id = g.role_id AND existing.permission_id = 'open_days.edit_past'
          )
        ORDER BY g.id
    LOOP
        new_grant := uuidv7();
        INSERT INTO role_permission_grants (id, role_id, permission_id, scope, minimum_assurance, reauth_within_minutes)
        VALUES (new_grant, source.role_id, 'open_days.edit_past', source.scope, source.minimum_assurance,
                source.reauth_within_minutes);
        INSERT INTO role_permission_grant_device_types (grant_id, device_type_id)
        SELECT new_grant, device_type_id FROM role_permission_grant_device_types WHERE grant_id = source.id;
    END LOOP;
END $$;
-- +goose StatementEnd
INSERT INTO master_reauthentication_permissions (permission_id, within_minutes)
SELECT 'open_days.edit_past', within_minutes FROM master_reauthentication_permissions
WHERE permission_id = 'open_days.manage'
ON CONFLICT (permission_id) DO NOTHING;

-- +goose Down
DELETE FROM master_reauthentication_permissions WHERE permission_id = 'open_days.edit_past';
DELETE FROM role_permission_grants WHERE permission_id = 'open_days.edit_past';
