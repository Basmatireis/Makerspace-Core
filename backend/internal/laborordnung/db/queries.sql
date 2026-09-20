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
FROM accounts a
LEFT JOIN account_roles ar ON ar.account_id = a.id
LEFT JOIN roles r ON r.id = ar.role_id
WHERE a.person_id = sqlc.arg(person_id);

-- name: LockPerson :exec
SELECT id FROM people WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: GetLatestCompletedRequest :one
SELECT * FROM laborordnung_requests
WHERE person_id = sqlc.arg(person_id) AND status = 'completed'
ORDER BY completed_at DESC, id DESC LIMIT 1;

-- name: GetPendingRequest :one
SELECT * FROM laborordnung_requests
WHERE person_id = sqlc.arg(person_id) AND status = 'pending'
FOR UPDATE;

-- name: GetPendingRequestForStatus :one
SELECT * FROM laborordnung_requests
WHERE person_id = sqlc.arg(person_id) AND status = 'pending';

-- name: SupersedePendingRequest :exec
UPDATE laborordnung_requests
SET status = 'superseded', superseded_at = now(), updated_at = now()
WHERE id = sqlc.arg(id) AND status = 'pending';

-- name: CreateRequest :one
INSERT INTO laborordnung_requests (id, person_id, required_version_id, previous_version_id)
VALUES (sqlc.arg(id), sqlc.arg(person_id), sqlc.arg(required_version_id), sqlc.narg(previous_version_id))
RETURNING *;

-- name: ListRequests :many
SELECT * FROM laborordnung_requests ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END, requested_at, id;

-- name: GetRequestForUpdate :one
SELECT * FROM laborordnung_requests WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: ConfirmRequest :one
UPDATE laborordnung_requests
SET status = 'completed', completed_at = now(), confirmed_by_account_id = sqlc.arg(confirmed_by_account_id),
    physical_document_reference = sqlc.arg(physical_document_reference), signed_date = sqlc.narg(signed_date),
    archive_note = sqlc.narg(archive_note), updated_at = now()
WHERE id = sqlc.arg(id) AND status = 'pending'
RETURNING *;

-- name: GetPersonName :one
SELECT first_name, last_name FROM people WHERE id = sqlc.arg(id);
