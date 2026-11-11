-- +goose Up
-- Scheduled retention runs that changed nothing are no longer recorded; remove the ones kept so far.
DELETE FROM privacy_retention_runs r
WHERE r.trigger = 'scheduled'
  AND r.status = 'completed'
  AND NOT EXISTS (
      SELECT 1 FROM privacy_retention_run_items i
      WHERE i.run_id = r.id AND (i.affected_count > 0 OR i.status = 'failed')
  );

-- +goose Down
-- The deleted runs recorded nothing and are not restored.
SELECT 1;
