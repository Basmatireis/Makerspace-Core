-- +goose Up
-- Withdrawals, deposits and counts can be edited and deleted (cash_movements.manage). Edits carry an optimistic
-- version and the time of the last change. The immutability guards give way to identity guards: an edit may change
-- the money, time, reason and note of a record (and the figures a count derives), never its id, reference,
-- operation key, kind, count link, creation time or recording Person. Hard deletes are allowed; a correction is
-- deleted only together with its count, which the service enforces and the foreign key backs.
DROP TRIGGER cash_movements_frozen ON cash_movements;
DROP TRIGGER cash_counts_frozen ON cash_counts;
DROP FUNCTION cash_movement_guard();

-- +goose StatementBegin
CREATE FUNCTION cash_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- TG_ARGV lists the columns an edit may change. The recording Person may only be cleared (ON DELETE SET NULL).
    IF (to_jsonb(NEW) - TG_ARGV - 'recorded_by_person_id') IS DISTINCT FROM (to_jsonb(OLD) - TG_ARGV - 'recorded_by_person_id')
        OR (NEW.recorded_by_person_id IS NOT NULL AND NEW.recorded_by_person_id IS DISTINCT FROM OLD.recorded_by_person_id) THEN
        RAISE EXCEPTION 'cash records keep their identity' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd

ALTER TABLE cash_movements
    ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    ADD COLUMN updated_at timestamptz;
UPDATE cash_movements SET updated_at = created_at;
ALTER TABLE cash_movements ALTER COLUMN updated_at SET NOT NULL, ALTER COLUMN updated_at SET DEFAULT now();

ALTER TABLE cash_counts
    ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    ADD COLUMN updated_at timestamptz;
UPDATE cash_counts SET updated_at = created_at;
ALTER TABLE cash_counts ALTER COLUMN updated_at SET NOT NULL, ALTER COLUMN updated_at SET DEFAULT now();

-- A matching count keeps no reason. A count whose difference came from a later edit of an earlier entry has none
-- until someone edits the count, so a difference no longer implies a reason.
ALTER TABLE cash_counts DROP CONSTRAINT cash_counts_check1,
    ADD CONSTRAINT cash_counts_difference_reason_check CHECK (difference <> 0 OR reason IS NULL);

CREATE TRIGGER cash_movements_identity BEFORE UPDATE ON cash_movements FOR EACH ROW
    WHEN (current_setting('makerspace.people_merge', true) IS DISTINCT FROM 'on')
    EXECUTE FUNCTION cash_record_guard('amount', 'occurred_at', 'reason', 'note', 'version', 'updated_at');
CREATE TRIGGER cash_counts_identity BEFORE UPDATE ON cash_counts FOR EACH ROW
    WHEN (current_setting('makerspace.people_merge', true) IS DISTINCT FROM 'on')
    EXECUTE FUNCTION cash_record_guard(
        'counted_amount', 'expected_amount', 'difference', 'reason', 'note', 'counted_at', 'version', 'updated_at');

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM cash_counts WHERE difference <> 0 AND reason IS NULL) THEN
        RAISE EXCEPTION 'cannot downgrade while counts with a difference have no reason';
    END IF;
END $$;
-- +goose StatementEnd
DROP TRIGGER cash_counts_identity ON cash_counts;
DROP TRIGGER cash_movements_identity ON cash_movements;
ALTER TABLE cash_counts DROP CONSTRAINT cash_counts_difference_reason_check,
    ADD CONSTRAINT cash_counts_check1 CHECK ((difference = 0) = (reason IS NULL));
ALTER TABLE cash_counts DROP COLUMN updated_at, DROP COLUMN version;
ALTER TABLE cash_movements DROP COLUMN updated_at, DROP COLUMN version;
DROP FUNCTION cash_record_guard();

-- +goose StatementBegin
CREATE FUNCTION cash_movement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'recorded_by_person_id') IS DISTINCT FROM (to_jsonb(OLD)-'recorded_by_person_id')
 OR (NEW.recorded_by_person_id IS NOT NULL AND NEW.recorded_by_person_id IS DISTINCT FROM OLD.recorded_by_person_id) THEN
 RAISE EXCEPTION 'cash movements are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
-- +goose StatementEnd
CREATE TRIGGER cash_movements_frozen BEFORE UPDATE ON cash_movements FOR EACH ROW
    WHEN (current_setting('makerspace.people_merge', true) IS DISTINCT FROM 'on')
    EXECUTE FUNCTION cash_movement_guard();
CREATE TRIGGER cash_counts_frozen BEFORE UPDATE ON cash_counts FOR EACH ROW
    WHEN (current_setting('makerspace.people_merge', true) IS DISTINCT FROM 'on')
    EXECUTE FUNCTION cash_movement_guard();
