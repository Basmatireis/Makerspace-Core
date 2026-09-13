-- name: InsertAuditEvent :one
INSERT INTO audit_events (id, actor_account_id, action, resource_type, resource_id, request_id, changed_fields, metadata, source)
VALUES (sqlc.arg(id), sqlc.narg(actor_account_id), sqlc.arg(action), sqlc.arg(resource_type), sqlc.narg(resource_id), sqlc.narg(request_id), sqlc.arg(changed_fields), sqlc.arg(metadata)::text::jsonb, sqlc.arg(source))
RETURNING *;

-- name: ListAuditEvents :many
SELECT ae.* FROM audit_events ae
WHERE (sqlc.narg(before_time)::timestamptz IS NULL OR (occurred_at, id) < (sqlc.narg(before_time)::timestamptz, sqlc.narg(before_id)::uuid))
  AND (sqlc.narg(actor_account_id)::uuid IS NULL OR ae.actor_account_id = sqlc.narg(actor_account_id)::uuid)
  AND (sqlc.narg(action)::text IS NULL OR ae.action = sqlc.narg(action)::text)
  AND (sqlc.narg(resource_type)::text IS NULL OR ae.resource_type = sqlc.narg(resource_type)::text)
  AND (sqlc.narg(resource_id)::uuid IS NULL OR ae.resource_id = sqlc.narg(resource_id)::uuid)
  AND (sqlc.narg(occurred_from)::timestamptz IS NULL OR ae.occurred_at >= sqlc.narg(occurred_from)::timestamptz)
  AND (sqlc.narg(occurred_to)::timestamptz IS NULL OR ae.occurred_at <= sqlc.narg(occurred_to)::timestamptz)
ORDER BY ae.occurred_at DESC, ae.id DESC LIMIT sqlc.arg(page_limit);

-- name: DeleteAuditEventsBefore :execrows
DELETE FROM audit_events WHERE occurred_at < sqlc.arg(before_time);
