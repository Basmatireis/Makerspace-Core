-- name: LockExport :exec
-- Serializes mutations of one export's versions for the rest of the transaction.
SELECT pg_advisory_xact_lock(hashtextextended('pdf_template_versions:' || sqlc.arg(export_kind)::text, 0));

-- name: ListVersionMetas :many
-- A creator or publisher name is empty when the account no longer exists.
-- Newest first, without the documents, at most row_limit versions.
SELECT v.id, v.export_kind, v.version, v.state, v.revision, v.created_at, v.updated_at, v.published_at,
       COALESCE(NULLIF(btrim(creator.first_name || ' ' || creator.last_name), ''), '')::text AS created_by_name,
       COALESCE(NULLIF(btrim(publisher.first_name || ' ' || publisher.last_name), ''), '')::text AS published_by_name
FROM pdf_template_versions v
LEFT JOIN accounts creator_account ON creator_account.id = v.created_by_account_id
LEFT JOIN people creator ON creator.id = creator_account.person_id
LEFT JOIN accounts publisher_account ON publisher_account.id = v.published_by_account_id
LEFT JOIN people publisher ON publisher.id = publisher_account.person_id
WHERE v.export_kind = sqlc.arg(export_kind)
ORDER BY v.version DESC
LIMIT sqlc.arg(row_limit);

-- name: ListCurrentVersions :many
-- The draft and the published version of every export, with documents.
SELECT v.id, v.export_kind, v.version, v.state, v.document, v.revision, v.created_at, v.updated_at, v.published_at,
       COALESCE(NULLIF(btrim(creator.first_name || ' ' || creator.last_name), ''), '')::text AS created_by_name,
       COALESCE(NULLIF(btrim(publisher.first_name || ' ' || publisher.last_name), ''), '')::text AS published_by_name
FROM pdf_template_versions v
LEFT JOIN accounts creator_account ON creator_account.id = v.created_by_account_id
LEFT JOIN people creator ON creator.id = creator_account.person_id
LEFT JOIN accounts publisher_account ON publisher_account.id = v.published_by_account_id
LEFT JOIN people publisher ON publisher.id = publisher_account.person_id
WHERE v.state IN ('draft', 'published')
ORDER BY v.export_kind, v.version;

-- name: GetVersion :one
SELECT v.id, v.export_kind, v.version, v.state, v.document, v.revision, v.created_at, v.updated_at, v.published_at,
       COALESCE(NULLIF(btrim(creator.first_name || ' ' || creator.last_name), ''), '')::text AS created_by_name,
       COALESCE(NULLIF(btrim(publisher.first_name || ' ' || publisher.last_name), ''), '')::text AS published_by_name
FROM pdf_template_versions v
LEFT JOIN accounts creator_account ON creator_account.id = v.created_by_account_id
LEFT JOIN people creator ON creator.id = creator_account.person_id
LEFT JOIN accounts publisher_account ON publisher_account.id = v.published_by_account_id
LEFT JOIN people publisher ON publisher.id = publisher_account.person_id
WHERE v.id = sqlc.arg(id) AND v.export_kind = sqlc.arg(export_kind);

-- name: GetVersionForUpdate :one
SELECT * FROM pdf_template_versions
WHERE id = sqlc.arg(id) AND export_kind = sqlc.arg(export_kind)
FOR UPDATE;

-- name: GetStateVersion :one
-- The draft or the published version of an export.
SELECT v.id, v.export_kind, v.version, v.state, v.document, v.revision, v.created_at, v.updated_at, v.published_at,
       COALESCE(NULLIF(btrim(creator.first_name || ' ' || creator.last_name), ''), '')::text AS created_by_name,
       COALESCE(NULLIF(btrim(publisher.first_name || ' ' || publisher.last_name), ''), '')::text AS published_by_name
FROM pdf_template_versions v
LEFT JOIN accounts creator_account ON creator_account.id = v.created_by_account_id
LEFT JOIN people creator ON creator.id = creator_account.person_id
LEFT JOIN accounts publisher_account ON publisher_account.id = v.published_by_account_id
LEFT JOIN people publisher ON publisher.id = publisher_account.person_id
WHERE v.export_kind = sqlc.arg(export_kind) AND v.state = sqlc.arg(state);

-- name: GetStateVersionForUpdate :one
SELECT * FROM pdf_template_versions
WHERE export_kind = sqlc.arg(export_kind) AND state = sqlc.arg(state)
FOR UPDATE;

-- name: GetPublishedDocument :one
-- What the real exports render with; no row means the built-in default is in effect.
SELECT document FROM pdf_template_versions
WHERE export_kind = sqlc.arg(export_kind) AND state = 'published';

-- name: NextVersionNumber :one
-- The next number of an export. A discarded draft is deleted, so its number is reused by the next draft; the audit
-- events of both carry the (different) resource ids.
SELECT (COALESCE(max(version), 0) + 1)::integer AS version
FROM pdf_template_versions
WHERE export_kind = sqlc.arg(export_kind);

-- name: InsertDraft :one
INSERT INTO pdf_template_versions (id, export_kind, version, state, document, created_by_account_id)
VALUES (sqlc.arg(id), sqlc.arg(export_kind), sqlc.arg(version), 'draft', sqlc.arg(document), sqlc.narg(created_by_account_id))
RETURNING *;

-- name: UpdateDraftDocument :one
-- Matches only while the draft still has the revision the caller saw; no row means it is stale.
UPDATE pdf_template_versions
SET document = sqlc.arg(document), revision = revision + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND state = 'draft' AND revision = sqlc.arg(expected_revision)
RETURNING *;

-- name: UpdateDraftDocumentAnyRevision :one
UPDATE pdf_template_versions
SET document = sqlc.arg(document), revision = revision + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND state = 'draft'
RETURNING *;

-- name: DeleteDraft :one
DELETE FROM pdf_template_versions
WHERE export_kind = sqlc.arg(export_kind) AND state = 'draft'
RETURNING id, version;

-- name: ArchivePublished :execrows
UPDATE pdf_template_versions
SET state = 'archived', updated_at = now()
WHERE export_kind = sqlc.arg(export_kind) AND state = 'published';

-- name: PublishDraft :one
UPDATE pdf_template_versions
SET state = 'published', published_at = now(), published_by_account_id = sqlc.narg(published_by_account_id), updated_at = now()
WHERE id = sqlc.arg(id) AND state = 'draft' AND revision = sqlc.arg(expected_revision)
RETURNING *;

-- name: ListAssets :many
-- Metadata only, newest first, at most row_limit images.
SELECT id, file_name, content_type, byte_size, width, height, created_at
FROM pdf_template_assets
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(row_limit);

-- name: AssetsExist :one
-- How many of the given asset ids are stored.
SELECT count(*) FROM pdf_template_assets WHERE id = ANY(sqlc.arg(ids)::uuid[]);

-- name: GetAssetMeta :one
SELECT id, file_name, content_type, byte_size, width, height, created_at
FROM pdf_template_assets
WHERE id = sqlc.arg(id);

-- name: GetAsset :one
SELECT * FROM pdf_template_assets WHERE id = sqlc.arg(id);

-- name: CountAssets :one
SELECT count(*) FROM pdf_template_assets;

-- name: InsertAsset :one
INSERT INTO pdf_template_assets (id, file_name, content_type, byte_size, sha256, data, width, height, created_by_account_id)
VALUES (sqlc.arg(id), sqlc.arg(file_name), sqlc.arg(content_type), sqlc.arg(byte_size), sqlc.arg(sha256), sqlc.arg(data),
        sqlc.arg(width), sqlc.arg(height), sqlc.narg(created_by_account_id))
RETURNING id, file_name, content_type, byte_size, width, height, created_at;

-- name: DeleteAsset :execrows
DELETE FROM pdf_template_assets WHERE id = sqlc.arg(id);

-- name: AssetIsReferenced :one
-- Whether the draft or the published document of any export mentions the asset id. Ids are only ever stored as
-- whole UUID strings (`picture.asset`, `graphic.art` as `asset:<id>`), so a substring test over the document text
-- finds every reference and can only err on the side of keeping the asset. Archived versions do not count.
SELECT EXISTS (
    SELECT 1 FROM pdf_template_versions
    WHERE state IN ('draft', 'published') AND position(sqlc.arg(asset_id)::text IN document::text) > 0
) AS referenced;
