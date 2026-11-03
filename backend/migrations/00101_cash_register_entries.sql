-- +goose Up
-- Every entry of the cash register in one place: cash payments (receipts, refunds, corrections), withdrawals,
-- deposits, count corrections and the counts themselves. `effect` is what the entry did to the cash in the register;
-- a count moves nothing (its correction does). `sort_rank` orders entries at the same instant: a count sees
-- everything recorded at its time and comes before the correction it booked. Card and external payments never
-- belong here.
CREATE VIEW cash_register_entries AS
SELECT p.id, 'payment'::text AS source,
    CASE WHEN p.entry_kind = 'receipt' THEN 'receipt' WHEN p.reversal_reason_kind = 'refund' THEN 'refund' ELSE 'correction' END::text AS kind,
    p.occurred_at, 0 AS sort_rank,
    (CASE WHEN p.entry_kind = 'receipt' THEN p.amount ELSE -p.amount END)::numeric(20,2) AS effect,
    p.reference
FROM payments p WHERE p.method = 'cash'
UNION ALL
SELECT m.id, 'movement'::text, m.kind, m.occurred_at, CASE WHEN m.kind = 'correction' THEN 2 ELSE 0 END,
    (CASE WHEN m.kind = 'withdrawal' THEN -m.amount ELSE m.amount END)::numeric(20,2), m.reference
FROM cash_movements m
UNION ALL
SELECT c.id, 'count'::text, 'count'::text, c.counted_at, 1, 0::numeric(20,2), c.reference
FROM cash_counts c;

-- +goose Down
DROP VIEW cash_register_entries;
