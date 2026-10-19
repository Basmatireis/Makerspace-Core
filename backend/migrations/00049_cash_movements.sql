-- +goose Up
-- Cash taken out of or added to the register, independent of orders. Immutable: a mistake is
-- corrected by a new movement, never by an edit. Only cash payments and these movements make up
-- the expected cash in the register.
CREATE SEQUENCE cash_movement_reference_sequence;
CREATE TABLE cash_movements (
 id uuid PRIMARY KEY,
 reference text NOT NULL UNIQUE CHECK(reference ~ '^C-[0-9]{4}-[0-9]{6,}$'),
 operation_key uuid NOT NULL UNIQUE,
 kind text NOT NULL CHECK(kind IN ('withdrawal','deposit')),
 amount numeric(20,2) NOT NULL CHECK(amount>0),
 reason text NOT NULL CHECK(reason IN ('bank_deposit','safe','float','other')),
 note text NOT NULL DEFAULT '' CHECK(length(note)<=500 AND (reason<>'other' OR btrim(note)<>'')),
 occurred_at timestamptz NOT NULL,
 recorded_by_person_id uuid REFERENCES people ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cash_movements_time_idx ON cash_movements(occurred_at DESC,id DESC);
-- +goose StatementBegin
CREATE FUNCTION cash_movement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'recorded_by_person_id') IS DISTINCT FROM (to_jsonb(OLD)-'recorded_by_person_id')
 OR (NEW.recorded_by_person_id IS NOT NULL AND NEW.recorded_by_person_id IS DISTINCT FROM OLD.recorded_by_person_id) THEN
 RAISE EXCEPTION 'cash movements are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
-- +goose StatementEnd
CREATE TRIGGER cash_movements_frozen BEFORE UPDATE ON cash_movements FOR EACH ROW EXECUTE FUNCTION cash_movement_guard();

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM cash_movements) THEN RAISE EXCEPTION 'cannot downgrade while cash movements exist'; END IF;
END $$;
-- +goose StatementEnd
DROP TABLE cash_movements;
DROP FUNCTION cash_movement_guard();
DROP SEQUENCE cash_movement_reference_sequence;
