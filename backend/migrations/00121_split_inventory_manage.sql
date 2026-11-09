-- +goose Up
-- inventory.manage is split into inventory.articles.manage, inventory.receive, inventory.consume and
-- inventory.correct. Every grant of the old permission is copied once per new permission with its scope, assurance,
-- fresh-sign-in window and device types, so no role gains or loses anything on upgrade. The master role derives its
-- permissions from application code and has no grants.
-- +goose StatementBegin
DO $$
DECLARE
    source record;
    target text;
    new_grant uuid;
BEGIN
    FOR source IN
        SELECT id, role_id, scope, minimum_assurance, reauth_within_minutes
        FROM role_permission_grants WHERE permission_id = 'inventory.manage' ORDER BY id
    LOOP
        FOREACH target IN ARRAY ARRAY['inventory.articles.manage', 'inventory.receive', 'inventory.consume', 'inventory.correct']
        LOOP
            new_grant := uuidv7();
            INSERT INTO role_permission_grants (id, role_id, permission_id, scope, minimum_assurance, reauth_within_minutes)
            VALUES (new_grant, source.role_id, target, source.scope, source.minimum_assurance, source.reauth_within_minutes);
            INSERT INTO role_permission_grant_device_types (grant_id, device_type_id)
            SELECT new_grant, device_type_id FROM role_permission_grant_device_types WHERE grant_id = source.id;
        END LOOP;
    END LOOP;
END $$;
-- +goose StatementEnd
DELETE FROM role_permission_grants WHERE permission_id = 'inventory.manage';
DELETE FROM master_reauthentication_permissions WHERE permission_id = 'inventory.manage';

-- +goose Down
-- Every grant of one of the four permissions becomes a grant of inventory.manage (a role holding several of them
-- gets one grant per distinct scope and assurance), then the four permissions are removed. A role that held only some
-- of them regains the wider inventory.manage; the downgrade cannot express the difference.
-- +goose StatementBegin
DO $$
DECLARE
    source record;
    new_grant uuid;
BEGIN
    FOR source IN
        SELECT DISTINCT ON (g.role_id, g.scope, g.minimum_assurance, g.reauth_within_minutes)
            g.id, g.role_id, g.scope, g.minimum_assurance, g.reauth_within_minutes
        FROM role_permission_grants g
        WHERE g.permission_id IN ('inventory.articles.manage', 'inventory.receive', 'inventory.consume', 'inventory.correct')
        ORDER BY g.role_id, g.scope, g.minimum_assurance, g.reauth_within_minutes, g.id
    LOOP
        new_grant := uuidv7();
        INSERT INTO role_permission_grants (id, role_id, permission_id, scope, minimum_assurance, reauth_within_minutes)
        VALUES (new_grant, source.role_id, 'inventory.manage', source.scope, source.minimum_assurance, source.reauth_within_minutes);
        INSERT INTO role_permission_grant_device_types (grant_id, device_type_id)
        SELECT new_grant, device_type_id FROM role_permission_grant_device_types WHERE grant_id = source.id;
    END LOOP;
END $$;
-- +goose StatementEnd
DELETE FROM role_permission_grants
WHERE permission_id IN ('inventory.articles.manage', 'inventory.receive', 'inventory.consume', 'inventory.correct');
DELETE FROM master_reauthentication_permissions
WHERE permission_id IN ('inventory.articles.manage', 'inventory.receive', 'inventory.consume', 'inventory.correct');
