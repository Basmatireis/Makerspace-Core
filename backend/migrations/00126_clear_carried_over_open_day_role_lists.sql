-- +goose Up
-- Before 00109 the role list of an open-day place named the roles allowed to fill it; 00109 only removed the
-- membership roles from these lists, so the remaining custom roles (a former supervisor-level role, for example)
-- turned into "extra roles" restrictions nobody chose. Places that existed before 00109 lose their role lists; places
-- created later keep the extra roles staff set. Place IDs are UUIDv7, so their timestamp says when they were created.
-- Without a goose version table (schemas built from the migration files directly) there is nothing to tell apart.
-- +goose StatementBegin
DO $$
DECLARE
    membership_migrated_at timestamptz;
BEGIN
    IF to_regclass('goose_db_version') IS NULL THEN
        RETURN;
    END IF;
    EXECUTE 'SELECT max(tstamp) FROM goose_db_version WHERE version_id = 109 AND is_applied'
        INTO membership_migrated_at;
    IF membership_migrated_at IS NULL THEN
        RETURN;
    END IF;
    DELETE FROM open_day_staff_requirement_roles rr
    WHERE uuid_extract_timestamp(rr.requirement_id) < membership_migrated_at;
END $$;
-- +goose StatementEnd

-- +goose Down
-- The removed role lists restricted places by mistake; they are not restored.
SELECT 1;
