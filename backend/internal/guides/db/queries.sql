-- name: ListOwnGuideProgress :many
SELECT guide_id, status, updated_at
FROM account_guide_progress
WHERE account_id = sqlc.arg(account_id)
ORDER BY guide_id;

-- name: UpsertOwnGuideProgress :one
INSERT INTO account_guide_progress (account_id, guide_id, status, updated_at)
VALUES (sqlc.arg(account_id), sqlc.arg(guide_id), sqlc.arg(status), sqlc.arg(updated_at))
ON CONFLICT (account_id, guide_id) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at
RETURNING guide_id, status, updated_at;

-- name: DeleteOwnGuideProgress :execrows
DELETE FROM account_guide_progress WHERE account_id = sqlc.arg(account_id);
