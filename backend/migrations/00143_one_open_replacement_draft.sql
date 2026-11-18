-- +goose Up
-- An original order has at most one open replacement draft. Older open replacement drafts of the same original are
-- cancelled (their job claims released, as cancelling a draft does) so the newest one stays the replacement in progress.
-- This one-off clean-up writes no audit events.
WITH superseded AS (
    SELECT id FROM (
        SELECT id, row_number() OVER (PARTITION BY replaces_order_id ORDER BY created_at DESC, id DESC) AS position
        FROM orders
        WHERE status = 'draft' AND replaces_order_id IS NOT NULL
    ) drafts
    WHERE position > 1
)
DELETE FROM order_job_claims
WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id IN (SELECT id FROM superseded));

WITH superseded AS (
    SELECT id FROM (
        SELECT id, row_number() OVER (PARTITION BY replaces_order_id ORDER BY created_at DESC, id DESC) AS position
        FROM orders
        WHERE status = 'draft' AND replaces_order_id IS NOT NULL
    ) drafts
    WHERE position > 1
)
UPDATE orders SET status = 'cancelled', cancelled_at = now(), version = version + 1, updated_at = now()
WHERE id IN (SELECT id FROM superseded);

-- The deferred financial integrity checks run now: CREATE INDEX refuses a table with pending trigger events.
SET CONSTRAINTS ALL IMMEDIATE;

CREATE UNIQUE INDEX orders_open_replacement_idx ON orders (replaces_order_id) WHERE status = 'draft';

-- +goose Down
-- Cancelled drafts stay cancelled.
DROP INDEX IF EXISTS orders_open_replacement_idx;
