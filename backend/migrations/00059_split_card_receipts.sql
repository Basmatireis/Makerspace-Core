-- +goose Up
-- A receipt settles one order. When a person pays several of their own orders with one card payment, the slip is
-- recorded as numbered parts, one receipt per order, that share the terminal reference. A slip still cannot be
-- recorded twice: every new payment entry starts again at part 1.
ALTER TABLE payments ADD COLUMN split_part smallint NOT NULL DEFAULT 1 CHECK (split_part >= 1);
DROP INDEX card_receipt_reference_idx;
CREATE UNIQUE INDEX card_receipt_reference_idx ON payments(external_source, external_reference, split_part)
    WHERE method = 'card' AND entry_kind = 'receipt';

-- +goose Down
-- Fails while a card slip is recorded in parts: merging them would rewrite retained financial records.
DROP INDEX card_receipt_reference_idx;
CREATE UNIQUE INDEX card_receipt_reference_idx ON payments(external_source, external_reference)
    WHERE method = 'card' AND entry_kind = 'receipt';
ALTER TABLE payments DROP COLUMN split_part;
