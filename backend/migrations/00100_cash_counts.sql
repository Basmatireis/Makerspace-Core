-- +goose Up
-- A count of the cash register: what was counted, what the records said the register should hold at that moment and
-- the difference. A count is immutable like the movements. A non-zero difference books one correction movement that
-- references the count, so the expected cash follows what is really in the register; the count itself moves no money.
CREATE SEQUENCE cash_count_reference_sequence;
CREATE TABLE cash_counts (
 id uuid PRIMARY KEY,
 reference text NOT NULL UNIQUE CHECK(reference ~ '^K-[0-9]{4}-[0-9]{4,}$'),
 operation_key uuid NOT NULL UNIQUE,
 counted_amount numeric(20,2) NOT NULL CHECK(counted_amount>=0),
 expected_amount numeric(20,2) NOT NULL,
 difference numeric(20,2) NOT NULL,
 reason text CHECK(reason IN ('counting_error','change_given_wrong','receipt_not_recorded','unknown','other')),
 note text NOT NULL DEFAULT '' CHECK(length(note)<=500),
 counted_at timestamptz NOT NULL,
 recorded_by_person_id uuid REFERENCES people ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(difference=counted_amount-expected_amount),
 -- A difference always says why; a matching count has nothing to explain.
 CHECK((difference=0)=(reason IS NULL)),
 CHECK(reason IS NULL OR reason NOT IN ('unknown','other') OR btrim(note)<>'')
);
CREATE INDEX cash_counts_time_idx ON cash_counts(counted_at DESC,id DESC);
CREATE TRIGGER cash_counts_frozen BEFORE UPDATE ON cash_counts FOR EACH ROW
 WHEN (current_setting('makerspace.people_merge', true) IS DISTINCT FROM 'on')
 EXECUTE FUNCTION cash_movement_guard();
CREATE TRIGGER cash_counts_people_merge BEFORE UPDATE OR DELETE ON cash_counts FOR EACH ROW
 WHEN (current_setting('makerspace.people_merge', true) = 'on')
 EXECUTE FUNCTION people_merge_reference_guard('recorded_by_person_id');

-- Corrections are signed: a positive amount adds cash to the register (more was counted than expected), a negative
-- amount removes it. Withdrawals and deposits keep their positive amounts.
ALTER TABLE cash_movements
 ADD COLUMN cash_count_id uuid UNIQUE REFERENCES cash_counts ON DELETE RESTRICT,
 DROP CONSTRAINT cash_movements_kind_check,
 DROP CONSTRAINT cash_movements_amount_check,
 DROP CONSTRAINT cash_movements_reason_check,
 ADD CONSTRAINT cash_movements_kind_check CHECK(kind IN ('withdrawal','deposit','correction')),
 ADD CONSTRAINT cash_movements_amount_check CHECK(amount>0 OR (kind='correction' AND amount<>0)),
 ADD CONSTRAINT cash_movements_reason_check CHECK(reason IN ('bank_deposit','safe','float','other','count_difference')),
 ADD CONSTRAINT cash_movements_correction_check CHECK(
  (kind='correction')=(cash_count_id IS NOT NULL) AND (kind='correction')=(reason='count_difference'));

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM cash_counts) THEN RAISE EXCEPTION 'cannot downgrade while cash counts exist'; END IF;
END $$;
-- +goose StatementEnd
ALTER TABLE cash_movements
 DROP CONSTRAINT cash_movements_correction_check,
 DROP CONSTRAINT cash_movements_reason_check,
 DROP CONSTRAINT cash_movements_amount_check,
 DROP CONSTRAINT cash_movements_kind_check,
 DROP COLUMN cash_count_id,
 ADD CONSTRAINT cash_movements_kind_check CHECK(kind IN ('withdrawal','deposit')),
 ADD CONSTRAINT cash_movements_amount_check CHECK(amount>0),
 ADD CONSTRAINT cash_movements_reason_check CHECK(reason IN ('bank_deposit','safe','float','other'));
DROP TABLE cash_counts;
DROP SEQUENCE cash_count_reference_sequence;
