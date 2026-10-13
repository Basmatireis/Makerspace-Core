-- +goose Up
-- Machine jobs get an optional staff-chosen name, and the fixed final-price
-- override becomes a price adjustment. Relative kinds (discounts, multiplier)
-- are re-applied by the service whenever the calculated price changes, so the
-- resulting effective price is stored for reporting and order snapshots.
ALTER TABLE machine_jobs
    ADD COLUMN title text CHECK (title IS NULL OR (title = btrim(title) AND title <> '' AND length(title) <= 200)),
    ADD COLUMN price_adjustment_kind text CHECK (price_adjustment_kind IS NULL OR price_adjustment_kind IN ('fixed', 'discount_percent', 'discount_amount', 'multiplier')),
    ADD COLUMN price_adjustment_value numeric(20, 6),
    ADD COLUMN effective_price numeric(20, 2) CHECK (effective_price IS NULL OR effective_price >= 0);

ALTER TABLE machine_jobs RENAME COLUMN price_override_reason TO price_adjustment_reason;
ALTER TABLE machine_jobs RENAME COLUMN price_overridden_by_account_id TO price_adjusted_by_account_id;
ALTER TABLE machine_jobs RENAME COLUMN price_overridden_at TO price_adjusted_at;

UPDATE machine_jobs
SET price_adjustment_kind = CASE WHEN final_price IS NOT NULL THEN 'fixed' END,
    price_adjustment_value = final_price,
    effective_price = COALESCE(final_price, calculated_price);

-- machine_jobs has a deferred constraint trigger; flush its pending events so
-- the following ALTER TABLE is allowed in this transaction.
SET CONSTRAINTS anonymous_job_completed IMMEDIATE;

ALTER TABLE machine_jobs
    DROP CONSTRAINT machine_jobs_check4,
    DROP COLUMN final_price,
    ADD CONSTRAINT machine_jobs_price_adjustment_shape CHECK (
        (price_adjustment_kind IS NULL AND price_adjustment_value IS NULL AND price_adjustment_reason IS NULL AND price_adjusted_at IS NULL)
        OR
        (price_adjustment_kind IS NOT NULL AND price_adjustment_value IS NOT NULL AND price_adjustment_reason IS NOT NULL AND price_adjusted_at IS NOT NULL)
    ),
    ADD CONSTRAINT machine_jobs_price_adjustment_value CHECK (
        price_adjustment_kind IS NULL
        OR (price_adjustment_kind = 'fixed' AND price_adjustment_value >= 0)
        OR (price_adjustment_kind = 'discount_percent' AND price_adjustment_value > 0 AND price_adjustment_value <= 100)
        OR (price_adjustment_kind = 'discount_amount' AND price_adjustment_value > 0)
        OR (price_adjustment_kind = 'multiplier' AND price_adjustment_value > 0 AND price_adjustment_value <= 100)
    );

-- +goose Down
ALTER TABLE machine_jobs
    DROP CONSTRAINT machine_jobs_price_adjustment_value,
    DROP CONSTRAINT machine_jobs_price_adjustment_shape,
    ADD COLUMN final_price numeric(20, 2) CHECK (final_price IS NULL OR final_price >= 0);

-- A relative adjustment has no fixed equivalent; keep the price it produced.
UPDATE machine_jobs
SET final_price = CASE WHEN price_adjustment_kind IS NOT NULL THEN COALESCE(effective_price, 0) END;

SET CONSTRAINTS anonymous_job_completed IMMEDIATE;

ALTER TABLE machine_jobs RENAME COLUMN price_adjustment_reason TO price_override_reason;
ALTER TABLE machine_jobs RENAME COLUMN price_adjusted_by_account_id TO price_overridden_by_account_id;
ALTER TABLE machine_jobs RENAME COLUMN price_adjusted_at TO price_overridden_at;

ALTER TABLE machine_jobs
    DROP COLUMN effective_price,
    DROP COLUMN price_adjustment_value,
    DROP COLUMN price_adjustment_kind,
    DROP COLUMN title,
    ADD CONSTRAINT machine_jobs_check4 CHECK (
        (final_price IS NULL AND price_override_reason IS NULL AND price_overridden_at IS NULL)
        OR
        (final_price IS NOT NULL AND price_override_reason IS NOT NULL AND price_overridden_at IS NOT NULL)
    );
