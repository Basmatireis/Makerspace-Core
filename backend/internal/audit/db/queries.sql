-- name: InsertAuditEvent :one
INSERT INTO audit_events (id, actor_type, actor_account_id, action, resource_type, resource_id, request_id, changed_fields, metadata, source)
VALUES (sqlc.arg(id), sqlc.arg(actor_type), sqlc.narg(actor_account_id), sqlc.arg(action), sqlc.arg(resource_type), sqlc.narg(resource_id), sqlc.narg(request_id), sqlc.arg(changed_fields), sqlc.arg(metadata)::text::jsonb, sqlc.arg(source))
RETURNING *;

-- name: ListAuditEvents :many
SELECT ae.*,
       COALESCE(NULLIF(btrim(actor_person.first_name || ' ' || actor_person.last_name), ''), '')::text AS actor_display_name,
       COALESCE(CASE ae.resource_type
           WHEN 'person' THEN (SELECT NULLIF(btrim(p.first_name || ' ' || p.last_name), '') FROM people p WHERE p.id = ae.resource_id)
           WHEN 'account' THEN (SELECT NULLIF(btrim(p.first_name || ' ' || p.last_name), '') FROM accounts a JOIN people p ON p.id = a.person_id WHERE a.id = ae.resource_id)
           WHEN 'role' THEN (SELECT r.name FROM roles r WHERE r.id = ae.resource_id)
           WHEN 'managed_device' THEN (SELECT md.name FROM managed_devices md WHERE md.id = ae.resource_id)
           WHEN 'device_type' THEN (SELECT dt.name FROM device_types dt WHERE dt.id = ae.resource_id)
           WHEN 'open_day_period' THEN (SELECT odp.name FROM open_day_periods odp WHERE odp.id = ae.resource_id)
           WHEN 'open_day' THEN (SELECT od.starts_at::text FROM open_days od WHERE od.id = ae.resource_id)
           WHEN 'open_day_assignment' THEN (
               SELECT NULLIF(btrim(p.first_name || ' ' || p.last_name), '')
               FROM open_day_assignments oda JOIN people p ON p.id = oda.person_id
               WHERE oda.id = ae.resource_id
           )
           WHEN 'open_day_academic_break' THEN (SELECT odab.name FROM open_day_academic_breaks odab WHERE odab.id = ae.resource_id)
           WHEN 'laborordnung_version' THEN (SELECT lv.human_revision FROM laborordnung_versions lv WHERE lv.id = ae.resource_id)
           WHEN 'laborordnung_request' THEN (
               SELECT NULLIF(btrim(p.first_name || ' ' || p.last_name), '')
               FROM laborordnung_requests lr JOIN people p ON p.id = lr.person_id
               WHERE lr.id = ae.resource_id
           )
           WHEN 'oidc_provider' THEN (SELECT op.display_name FROM oidc_providers op WHERE op.id = ae.resource_id)
           WHEN 'scim_connector' THEN (SELECT sc.name FROM scim_connectors sc WHERE sc.id = ae.resource_id)
           WHEN 'scim_user' THEN (
               SELECT NULLIF(btrim(p.first_name || ' ' || p.last_name), '')
               FROM scim_users su JOIN people p ON p.id = su.person_id
               WHERE su.id = ae.resource_id
           )
           WHEN 'machine_type' THEN (SELECT mt.name FROM machine_types mt WHERE mt.id = ae.resource_id)
           WHEN 'machine' THEN (SELECT m.name FROM machines m WHERE m.id = ae.resource_id)
           WHEN 'organization' THEN (SELECT o.name FROM organizations o WHERE o.id = ae.resource_id)
           WHEN 'pricing_group' THEN (SELECT pg.name FROM pricing_groups pg WHERE pg.id = ae.resource_id)
           WHEN 'material' THEN (SELECT m.name FROM materials m WHERE m.id = ae.resource_id)
           WHEN 'machine_job' THEN (SELECT mj.display_id FROM machine_jobs mj WHERE mj.id = ae.resource_id)
           ELSE NULL
       END, '')::text AS resource_display_name,
       jsonb_strip_nulls(jsonb_build_object(
           'roleId', (SELECT r.name FROM roles r WHERE r.id::text = ae.metadata ->> 'roleId'),
           'personId', (SELECT NULLIF(btrim(p.first_name || ' ' || p.last_name), '') FROM people p WHERE p.id::text = ae.metadata ->> 'personId'),
           'openDayId', (SELECT od.starts_at::text FROM open_days od WHERE od.id::text = ae.metadata ->> 'openDayId')
       )) AS resolved_metadata
FROM audit_events ae
LEFT JOIN accounts actor_account ON actor_account.id = ae.actor_account_id
LEFT JOIN people actor_person ON actor_person.id = actor_account.person_id
WHERE (sqlc.narg(before_time)::timestamptz IS NULL OR (ae.occurred_at, ae.id) < (sqlc.narg(before_time)::timestamptz, sqlc.narg(before_id)::uuid))
  AND (sqlc.narg(actor_account_id)::uuid IS NULL OR ae.actor_account_id = sqlc.narg(actor_account_id)::uuid)
  AND (sqlc.narg(actor_type)::text IS NULL OR ae.actor_type = sqlc.narg(actor_type)::text)
  AND (sqlc.arg(actor_search)::text = '' OR lower(actor_person.first_name || ' ' || actor_person.last_name) LIKE '%' || lower(sqlc.arg(actor_search)::text) || '%')
  AND (sqlc.narg(action)::text IS NULL OR ae.action = sqlc.narg(action)::text)
  AND (sqlc.narg(resource_type)::text IS NULL OR ae.resource_type = sqlc.narg(resource_type)::text)
  AND (sqlc.narg(resource_id)::uuid IS NULL OR ae.resource_id = sqlc.narg(resource_id)::uuid)
  AND (sqlc.narg(occurred_from)::timestamptz IS NULL OR ae.occurred_at >= sqlc.narg(occurred_from)::timestamptz)
  AND (sqlc.narg(occurred_to)::timestamptz IS NULL OR ae.occurred_at <= sqlc.narg(occurred_to)::timestamptz)
ORDER BY ae.occurred_at DESC, ae.id DESC LIMIT sqlc.arg(page_limit);

-- name: DeleteAuditEventsBefore :execrows
DELETE FROM audit_events WHERE occurred_at < sqlc.arg(before_time);
