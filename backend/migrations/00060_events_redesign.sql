-- +goose Up
-- Events have four statuses: planning merges into draft, archived into completed. closed_at stays the date
-- that personal-data retention counts from, so an archived event keeps its original closing time.
ALTER TABLE events
    DROP CONSTRAINT events_status_check,
    DROP CONSTRAINT events_check,
    DROP CONSTRAINT events_check1,
    DROP CONSTRAINT events_check2;

UPDATE events SET status = 'draft' WHERE status = 'planning';
UPDATE events SET status = 'completed' WHERE status = 'archived';

ALTER TABLE events
    ADD CONSTRAINT events_status_check CHECK (status IN ('draft', 'confirmed', 'completed', 'cancelled')),
    ADD CONSTRAINT events_closed_at_check CHECK ((closed_at IS NOT NULL) = (status IN ('completed', 'cancelled')));

-- Tasks are open or done with an optional importance flag. Cancelled tasks count as done; they keep their
-- last change as completion time and no completing account.
ALTER TABLE event_tasks
    DROP CONSTRAINT event_tasks_status_check,
    DROP CONSTRAINT event_tasks_check,
    ADD COLUMN important boolean NOT NULL DEFAULT false;

UPDATE event_tasks SET important = true WHERE priority IN ('high', 'urgent');
UPDATE event_tasks SET status = 'open' WHERE status IN ('in_progress', 'blocked');
UPDATE event_tasks SET status = 'done', completed_at = updated_at, completed_by_account_id = NULL
WHERE status = 'cancelled';

ALTER TABLE event_tasks
    DROP COLUMN priority,
    ADD CONSTRAINT event_tasks_status_check CHECK (status IN ('open', 'done')),
    ADD CONSTRAINT event_tasks_check CHECK ((status = 'done') = (completed_at IS NOT NULL));

-- Members join and leave event shifts themselves; helpers may see each other's names.
-- Every existing grant of a related Open Day or Event staffing permission is copied with its scope,
-- assurance, and device types, so nobody gains the new rights on more devices than before.
-- +goose StatementBegin
DO $$
DECLARE
    source record;
    new_grant uuid;
BEGIN
    FOR source IN
        SELECT g.id, g.role_id, g.scope, g.minimum_assurance, mapping.target
        FROM role_permission_grants g
        JOIN (VALUES
            ('open_days.signup', 'events.signup'),
            ('open_days.read_assignments', 'events.read_assignments'),
            ('events.staffing.manage', 'events.read_assignments'),
            ('events.assign', 'events.read_assignments')
        ) AS mapping(origin, target) ON mapping.origin = g.permission_id
        ORDER BY g.id
    LOOP
        IF source.scope <> 'device_type' AND EXISTS (
            SELECT 1 FROM role_permission_grants existing
            WHERE existing.role_id = source.role_id AND existing.permission_id = source.target
              AND existing.scope = source.scope AND existing.minimum_assurance = source.minimum_assurance
        ) THEN
            CONTINUE;
        END IF;
        new_grant := uuidv7();
        INSERT INTO role_permission_grants (id, role_id, permission_id, scope, minimum_assurance)
        VALUES (new_grant, source.role_id, source.target, source.scope, source.minimum_assurance);
        INSERT INTO role_permission_grant_device_types (grant_id, device_type_id)
        SELECT new_grant, device_type_id FROM role_permission_grant_device_types WHERE grant_id = source.id;
    END LOOP;
END $$;
-- +goose StatementEnd

-- +goose Down
DELETE FROM role_permission_grants WHERE permission_id IN ('events.signup', 'events.read_assignments');

ALTER TABLE event_tasks
    DROP CONSTRAINT event_tasks_status_check,
    ADD COLUMN priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    ADD CONSTRAINT event_tasks_status_check
        CHECK (status IN ('open', 'in_progress', 'blocked', 'done', 'cancelled'));
UPDATE event_tasks SET priority = 'high' WHERE important;
ALTER TABLE event_tasks DROP COLUMN important;

ALTER TABLE events
    DROP CONSTRAINT events_status_check,
    DROP CONSTRAINT events_closed_at_check,
    ADD CONSTRAINT events_status_check
        CHECK (status IN ('draft', 'planning', 'confirmed', 'completed', 'cancelled', 'archived')),
    ADD CONSTRAINT events_check CHECK (closed_at IS NULL OR status IN ('completed', 'cancelled', 'archived')),
    ADD CONSTRAINT events_check1 CHECK (status NOT IN ('completed', 'cancelled', 'archived') OR closed_at IS NOT NULL),
    ADD CONSTRAINT events_check2 CHECK (status <> 'archived' OR NOT is_public);
