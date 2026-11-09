-- name: ListOwnAccountPreferences :many
SELECT key, value, updated_at
FROM account_preferences
WHERE account_id = sqlc.arg(account_id)
ORDER BY key;

-- name: UpsertOwnAccountPreference :one
INSERT INTO account_preferences (account_id, key, value, updated_at)
VALUES (sqlc.arg(account_id), sqlc.arg(key), sqlc.arg(value), sqlc.arg(updated_at))
ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
RETURNING key, value, updated_at;
