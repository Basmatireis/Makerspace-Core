-- name: CreateFile :one
INSERT INTO files (id, storage_key, original_filename, content_type, size_bytes, sha256, created_by_account_id)
VALUES (sqlc.arg(id), sqlc.arg(storage_key), sqlc.arg(original_filename), sqlc.arg(content_type), sqlc.arg(size_bytes), sqlc.arg(sha256), sqlc.arg(created_by_account_id))
RETURNING *;

-- name: GetFile :one
SELECT * FROM files WHERE id = sqlc.arg(id);

-- name: DeleteFile :one
DELETE FROM files WHERE id = sqlc.arg(id) RETURNING *;

-- name: ListFiles :many
SELECT * FROM files ORDER BY id;
