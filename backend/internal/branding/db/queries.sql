-- name: GetConfiguration :one
SELECT * FROM branding_configuration WHERE singleton = true;

-- name: GetConfigurationForUpdate :one
SELECT * FROM branding_configuration WHERE singleton = true FOR UPDATE;

-- name: UpdateConfiguration :one
UPDATE branding_configuration SET
    legal_organization_name = sqlc.arg(legal_organization_name),
    display_name = sqlc.arg(display_name),
    application_name = sqlc.arg(application_name),
    tagline = sqlc.narg(tagline),
    primary_color = sqlc.arg(primary_color),
    secondary_color = sqlc.arg(secondary_color),
    accent_color = sqlc.arg(accent_color),
    background_color = sqlc.arg(background_color),
    imprint_mode = sqlc.arg(imprint_mode),
    imprint_markdown = sqlc.arg(imprint_markdown),
    imprint_external_url = sqlc.arg(imprint_external_url),
    privacy_mode = sqlc.arg(privacy_mode),
    privacy_markdown = sqlc.arg(privacy_markdown),
    privacy_external_url = sqlc.arg(privacy_external_url),
    version = version + 1,
    updated_by_account_id = sqlc.arg(updated_by_account_id),
    updated_at = now()
WHERE singleton = true AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: BumpConfigurationVersion :one
UPDATE branding_configuration SET
    version = version + 1,
    updated_by_account_id = sqlc.arg(updated_by_account_id),
    updated_at = now()
WHERE singleton = true AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: ListAssetOverrides :many
SELECT bao.slot, bao.mode, bao.file_id, bao.updated_at,
       f.original_filename, f.content_type, f.size_bytes, f.sha256
FROM branding_asset_overrides bao
LEFT JOIN files f ON f.id = bao.file_id
ORDER BY bao.slot;

-- name: GetAssetOverride :one
SELECT bao.slot, bao.mode, bao.file_id, bao.updated_at,
       f.original_filename, f.content_type, f.size_bytes, f.sha256
FROM branding_asset_overrides bao
LEFT JOIN files f ON f.id = bao.file_id
WHERE bao.slot = sqlc.arg(slot);

-- name: UpsertCustomAsset :one
INSERT INTO branding_asset_overrides (slot, mode, file_id, updated_by_account_id)
VALUES (sqlc.arg(slot), 'custom', sqlc.arg(file_id), sqlc.arg(updated_by_account_id))
ON CONFLICT (slot) DO UPDATE SET
    mode = 'custom', file_id = EXCLUDED.file_id,
    updated_by_account_id = EXCLUDED.updated_by_account_id, updated_at = now()
RETURNING *;

-- name: UpsertRemovedAsset :one
INSERT INTO branding_asset_overrides (slot, mode, file_id, updated_by_account_id)
VALUES (sqlc.arg(slot), 'none', NULL, sqlc.arg(updated_by_account_id))
ON CONFLICT (slot) DO UPDATE SET
    mode = 'none', file_id = NULL,
    updated_by_account_id = EXCLUDED.updated_by_account_id, updated_at = now()
RETURNING *;

-- name: DeleteAssetOverride :exec
DELETE FROM branding_asset_overrides WHERE slot = sqlc.arg(slot);

-- name: GetPublicAssetByDigest :one
SELECT bao.slot, f.*
FROM branding_asset_overrides bao
JOIN files f ON f.id = bao.file_id
WHERE bao.slot = sqlc.arg(slot) AND bao.mode = 'custom' AND encode(f.sha256, 'hex') = sqlc.arg(digest)::text;
