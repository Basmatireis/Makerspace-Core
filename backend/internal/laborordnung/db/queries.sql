-- name: CreateVersion :one
INSERT INTO laborordnung_versions (id, human_revision, pdf_file_id, pdf_sha256, created_by_account_id)
VALUES (sqlc.arg(id), sqlc.arg(human_revision), sqlc.arg(pdf_file_id), sqlc.arg(pdf_sha256), sqlc.arg(created_by_account_id))
RETURNING *;

-- name: ListVersions :many
SELECT * FROM laborordnung_versions ORDER BY COALESCE(effective_at, created_at) DESC, id DESC;

-- name: GetVersion :one
SELECT * FROM laborordnung_versions WHERE id = sqlc.arg(id);

-- name: PublishVersion :one
UPDATE laborordnung_versions
SET status = 'published', effective_at = sqlc.arg(effective_at), published_at = now(), updated_at = now()
WHERE id = sqlc.arg(id) AND status = 'draft'
RETURNING *;

-- name: GetCurrentVersion :one
SELECT * FROM laborordnung_versions
WHERE status = 'published' AND effective_at <= now()
ORDER BY effective_at DESC, id DESC LIMIT 1;

-- name: GetPersonMode :one
SELECT CASE COALESCE(max(CASE r.laborordnung_mode WHEN 'blocking' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END), 0)
    WHEN 2 THEN 'blocking' WHEN 1 THEN 'warning' ELSE 'not_required' END::text AS mode
FROM person_roles pr
JOIN roles r ON r.id = pr.role_id
WHERE pr.person_id = sqlc.arg(person_id);

-- name: LockPerson :exec
SELECT id FROM people WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: GetLatestConfirmation :one
-- The confirmation of the current version when there is one, otherwise the most recent one.
SELECT * FROM laborordnung_confirmations
WHERE person_id = sqlc.arg(person_id)
ORDER BY version_id = sqlc.arg(current_version_id) DESC, confirmed_at DESC, id DESC LIMIT 1;

-- name: InsertConfirmation :execrows
-- A repeated confirmation of the same version keeps the first one.
INSERT INTO laborordnung_confirmations (id, person_id, version_id, method, confirmed_at)
VALUES (sqlc.arg(id), sqlc.arg(person_id), sqlc.arg(version_id), sqlc.arg(method), now())
ON CONFLICT (person_id, version_id) DO NOTHING;

-- name: GetCurrentUnannouncedVersionForUpdate :one
-- Locks the current version while it is announced. SKIP LOCKED lets a second process that runs the job at the same
-- time pass instead of announcing it again; the current version is chosen before locking, so a locked one is never
-- replaced by an older version.
SELECT v.* FROM laborordnung_versions v
WHERE v.id = (
    SELECT c.id FROM laborordnung_versions c
    WHERE c.status = 'published' AND c.effective_at <= now()
    ORDER BY c.effective_at DESC, c.id DESC LIMIT 1
)
  AND v.announced_at IS NULL
FOR UPDATE SKIP LOCKED;

-- name: MarkVersionsAnnounced :execrows
-- Marks the version and every older effective version that was never announced; a newer version that became
-- effective before the job ran supersedes them.
UPDATE laborordnung_versions
SET announced_at = now()
WHERE status = 'published' AND announced_at IS NULL AND effective_at <= sqlc.arg(effective_at);

-- name: GetPersonName :one
SELECT first_name, last_name FROM people WHERE id = sqlc.arg(id);

-- name: ListConfirmations :many
SELECT c.id, c.person_id, btrim(p.first_name || ' ' || p.last_name) AS person_name,
       c.version_id, v.human_revision, c.method, c.confirmed_at, c.signed_date, c.physical_document_reference,
       COALESCE(btrim(cp.first_name || ' ' || cp.last_name), '')::text AS confirmed_by_name
FROM laborordnung_confirmations c
JOIN people p ON p.id = c.person_id
JOIN laborordnung_versions v ON v.id = c.version_id
LEFT JOIN accounts ca ON ca.id = c.confirmed_by_account_id
LEFT JOIN people cp ON cp.id = ca.person_id
WHERE (sqlc.narg(person_id)::uuid IS NULL OR c.person_id = sqlc.narg(person_id)::uuid)
  AND (sqlc.narg(version_id)::uuid IS NULL OR c.version_id = sqlc.narg(version_id)::uuid)
  AND (sqlc.narg(method)::text IS NULL OR c.method = sqlc.narg(method)::text)
  AND (sqlc.arg(search)::text = ''
       OR lower(p.first_name || ' ' || p.last_name) LIKE '%' || lower(sqlc.arg(search)::text) || '%'
       OR lower(COALESCE(c.physical_document_reference, '')) LIKE '%' || lower(sqlc.arg(search)::text) || '%')
ORDER BY
  CASE WHEN sqlc.arg(sort)::text = 'person' AND sqlc.arg(descending)::boolean = false THEN lower(p.last_name || ' ' || p.first_name) END ASC,
  CASE WHEN sqlc.arg(sort)::text = 'person' AND sqlc.arg(descending)::boolean THEN lower(p.last_name || ' ' || p.first_name) END DESC,
  CASE WHEN sqlc.arg(sort)::text = 'version' AND sqlc.arg(descending)::boolean = false THEN lower(v.human_revision) END ASC,
  CASE WHEN sqlc.arg(sort)::text = 'version' AND sqlc.arg(descending)::boolean THEN lower(v.human_revision) END DESC,
  CASE WHEN sqlc.arg(sort)::text = 'method' AND sqlc.arg(descending)::boolean = false THEN c.method END ASC,
  CASE WHEN sqlc.arg(sort)::text = 'method' AND sqlc.arg(descending)::boolean THEN c.method END DESC,
  CASE WHEN sqlc.arg(sort)::text = 'confirmedAt' AND sqlc.arg(descending)::boolean = false THEN c.confirmed_at END ASC,
  CASE WHEN sqlc.arg(sort)::text = 'confirmedAt' AND sqlc.arg(descending)::boolean THEN c.confirmed_at END DESC,
  c.confirmed_at DESC, c.id
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: CountConfirmations :one
SELECT count(*)
FROM laborordnung_confirmations c
JOIN people p ON p.id = c.person_id
WHERE (sqlc.narg(person_id)::uuid IS NULL OR c.person_id = sqlc.narg(person_id)::uuid)
  AND (sqlc.narg(version_id)::uuid IS NULL OR c.version_id = sqlc.narg(version_id)::uuid)
  AND (sqlc.narg(method)::text IS NULL OR c.method = sqlc.narg(method)::text)
  AND (sqlc.arg(search)::text = ''
       OR lower(p.first_name || ' ' || p.last_name) LIKE '%' || lower(sqlc.arg(search)::text) || '%'
       OR lower(COALESCE(c.physical_document_reference, '')) LIKE '%' || lower(sqlc.arg(search)::text) || '%');
