-- name: GetPrivacySettings :one
SELECT * FROM privacy_settings WHERE singleton;

-- name: LockPrivacySettings :one
SELECT * FROM privacy_settings WHERE singleton FOR UPDATE;

-- name: UpdatePrivacySettings :one
UPDATE privacy_settings
SET controller_name = sqlc.arg(controller_name), controller_address = sqlc.arg(controller_address),
    data_protection_contact = sqlc.arg(data_protection_contact),
    automatic_runs_enabled = sqlc.arg(automatic_runs_enabled), run_interval_minutes = sqlc.arg(run_interval_minutes),
    version = version + 1, updated_at = now(), updated_by_account_id = sqlc.narg(updated_by_account_id)
WHERE singleton AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: UpsertCategorySnapshot :exec
-- Records a declared category; a category seen again is no longer orphaned.
INSERT INTO privacy_category_snapshots (category_id, owner_module_id, definition)
VALUES (sqlc.arg(category_id), sqlc.arg(owner_module_id), (sqlc.arg(definition)::text)::jsonb)
ON CONFLICT (category_id) DO UPDATE
SET owner_module_id = EXCLUDED.owner_module_id, definition = EXCLUDED.definition, last_seen_at = now(), orphaned = false;

-- name: OrphanCategorySnapshots :execrows
-- Marks every snapshot that is not in the list of currently declared categories.
UPDATE privacy_category_snapshots SET orphaned = true
WHERE NOT orphaned AND category_id <> ALL(sqlc.arg(declared)::text[]);

-- name: ListCategorySnapshots :many
SELECT * FROM privacy_category_snapshots ORDER BY category_id;
