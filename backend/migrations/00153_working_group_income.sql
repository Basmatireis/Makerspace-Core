-- +goose Up
-- Income of a budget period from the cash register.
--
-- An entry counts in the period's budget at once. "cash" entries are booked ahead and still in the register; "bank"
-- entries were withdrawn, and cash_movement_id points at the withdrawal that took the money out. The application keeps
-- a withdrawal that is linked to income from being edited or deleted; the RESTRICT key is the safety net. A period
-- is never deleted, so its income is kept. The person reference is SET NULL.
CREATE TABLE working_group_income (
    id uuid PRIMARY KEY,
    period_id uuid NOT NULL REFERENCES working_group_budget_periods(id) ON DELETE RESTRICT,
    amount numeric(20,2) NOT NULL CHECK (amount > 0),
    occurred_on date NOT NULL,
    note text NOT NULL CHECK (note = btrim(note) AND note <> '' AND length(note) <= 160),
    location text NOT NULL CHECK (location IN ('cash', 'bank')),
    cash_movement_id uuid REFERENCES cash_movements(id) ON DELETE RESTRICT,
    created_by_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- A booking ahead has no withdrawal; withdrawn money always points at the withdrawal that took it out.
    CHECK ((location = 'cash') = (cash_movement_id IS NULL))
);

CREATE INDEX working_group_income_period_idx ON working_group_income (period_id, created_at DESC, id DESC);
-- One withdrawal feeds the budget through at most one entry.
CREATE UNIQUE INDEX working_group_income_movement_idx ON working_group_income (cash_movement_id) WHERE cash_movement_id IS NOT NULL;
CREATE INDEX working_group_income_ahead_idx ON working_group_income (period_id) WHERE location = 'cash';
CREATE INDEX working_group_income_created_by_idx ON working_group_income (created_by_person_id) WHERE created_by_person_id IS NOT NULL;

-- +goose Down
-- Dropping the table drops the income entries, so the budget totals fall back to the total from HTU; cash movements
-- and the register are untouched.
DROP TABLE working_group_income;
