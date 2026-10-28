-- name: InsertNotification :one
INSERT INTO inbox_notifications (id, kind, title, body, link, created_by_account_id, created_at, expires_at)
VALUES (
    sqlc.arg(id), sqlc.arg(kind), sqlc.arg(title), sqlc.arg(body), sqlc.narg(link),
    sqlc.narg(created_by_account_id), sqlc.arg(created_at), sqlc.arg(expires_at)
)
RETURNING *;

-- name: InsertNotificationRoles :exec
INSERT INTO inbox_notification_roles (notification_id, role_id)
SELECT sqlc.arg(notification_id)::uuid, role_id FROM unnest(sqlc.arg(role_ids)::text[]::uuid[]) AS role_id;

-- name: CountRolesByIDs :one
SELECT count(*) FROM roles WHERE id = ANY(sqlc.arg(role_ids)::text[]::uuid[]);

-- name: InsertRecipients :execrows
INSERT INTO inbox_recipients (notification_id, account_id)
SELECT sqlc.arg(notification_id)::uuid, account_id FROM unnest(sqlc.arg(account_ids)::text[]::uuid[]) AS account_id
ON CONFLICT DO NOTHING;

-- name: ListEnabledAccountIDsByRoles :many
-- Active accounts of people who currently hold at least one of the roles.
SELECT DISTINCT a.id
FROM accounts a
JOIN person_roles pr ON pr.person_id = a.person_id
WHERE a.status = 'enabled' AND pr.role_id = ANY(sqlc.arg(role_ids)::text[]::uuid[])
ORDER BY a.id;

-- name: ListEnabledAccountIDsWithPermission :many
-- Active accounts holding a permission through a role; master holds every registered permission.
SELECT DISTINCT a.id
FROM accounts a
JOIN person_roles pr ON pr.person_id = a.person_id
JOIN roles r ON r.id = pr.role_id
WHERE a.status = 'enabled'
  AND a.id <> ALL(sqlc.arg(excluded_account_ids)::text[]::uuid[])
  AND (
      r.system_key = 'master'
      OR EXISTS (
          SELECT 1 FROM role_permission_grants g
          WHERE g.role_id = r.id AND g.permission_id = sqlc.arg(permission_id)::text
      )
  )
ORDER BY a.id;

-- name: ListEnabledStaffingAccountIDs :many
-- Active accounts of people with any open day staffing level (supervisor or trainee).
SELECT DISTINCT a.id
FROM accounts a
JOIN person_roles pr ON pr.person_id = a.person_id
JOIN roles r ON r.id = pr.role_id
WHERE a.status = 'enabled' AND r.staffing_level IS NOT NULL
ORDER BY a.id;

-- name: ListUnassignedSupervisorAccountIDs :many
-- Active accounts of people with the supervisor staffing level who are not assigned to the open day.
SELECT DISTINCT a.id
FROM accounts a
JOIN person_roles pr ON pr.person_id = a.person_id
JOIN roles r ON r.id = pr.role_id
WHERE a.status = 'enabled'
  AND r.staffing_level = 'supervisor'
  AND a.person_id <> sqlc.arg(excluded_person_id)::uuid
  AND NOT EXISTS (
      SELECT 1 FROM open_day_assignments x
      WHERE x.open_day_id = sqlc.arg(open_day_id)::uuid AND x.person_id = a.person_id
  )
ORDER BY a.id;

-- name: ListEnabledAccountIDsOfPerson :many
SELECT id FROM accounts WHERE person_id = sqlc.arg(person_id) AND status = 'enabled' ORDER BY id;

-- name: GetAccountPersonName :one
SELECT p.first_name, p.last_name
FROM accounts a
JOIN people p ON p.id = a.person_id
WHERE a.id = sqlc.arg(account_id);

-- name: GetOpenDayPeriodFacts :one
SELECT id, name, status FROM open_day_periods WHERE id = sqlc.arg(id);

-- name: GetOpenDayFacts :one
SELECT d.id, d.period_id, d.starts_at, d.status
FROM open_days d
WHERE d.id = sqlc.arg(id);

-- name: GetRunNotificationFacts :one
SELECT r.id, r.display_id, r.outcome, r.state, m.name AS machine_name,
       j.id AS job_id, j.title AS job_title, j.operator_person_id
FROM machine_runs r
JOIN machines m ON m.id = r.machine_id
LEFT JOIN machine_jobs j ON j.id = r.job_id
WHERE r.id = sqlc.arg(id);

-- name: ListOwnNotifications :many
SELECT n.id, n.kind, n.title, n.body, n.link, n.created_at, rc.read_at
FROM inbox_recipients rc
JOIN inbox_notifications n ON n.id = rc.notification_id
WHERE rc.account_id = sqlc.arg(account_id) AND n.expires_at > sqlc.arg(now)
ORDER BY n.created_at DESC, n.id DESC
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: CountOwnNotifications :one
SELECT count(*)
FROM inbox_recipients rc
JOIN inbox_notifications n ON n.id = rc.notification_id
WHERE rc.account_id = sqlc.arg(account_id) AND n.expires_at > sqlc.arg(now);

-- name: CountOwnUnreadNotifications :one
SELECT count(*)
FROM inbox_recipients rc
JOIN inbox_notifications n ON n.id = rc.notification_id
WHERE rc.account_id = sqlc.arg(account_id) AND rc.read_at IS NULL AND n.expires_at > sqlc.arg(now);

-- name: MarkOwnNotificationRead :execrows
-- Idempotent: an already read notification keeps its first read time but still counts as found.
UPDATE inbox_recipients
SET read_at = COALESCE(read_at, sqlc.arg(now))
WHERE notification_id = sqlc.arg(notification_id) AND account_id = sqlc.arg(account_id);

-- name: MarkAllOwnNotificationsRead :execrows
UPDATE inbox_recipients
SET read_at = sqlc.arg(now)
WHERE account_id = sqlc.arg(account_id) AND read_at IS NULL;

-- name: DeleteOwnRecipient :execrows
DELETE FROM inbox_recipients
WHERE notification_id = sqlc.arg(notification_id) AND account_id = sqlc.arg(account_id);

-- name: DeleteOrphanedSystemNotification :exec
-- A system notification nobody holds any more carries no information. Manual messages stay until they expire so
-- the sender's list is complete.
DELETE FROM inbox_notifications n
WHERE n.id = sqlc.arg(id)
  AND n.kind <> 'message'
  AND NOT EXISTS (SELECT 1 FROM inbox_recipients rc WHERE rc.notification_id = n.id);

-- name: DeleteExpiredNotifications :execrows
DELETE FROM inbox_notifications WHERE expires_at <= sqlc.arg(now);

-- name: ListSentMessages :many
SELECT n.id, n.title, n.body, n.link, n.created_at, n.expires_at,
       p.first_name AS sender_first_name, p.last_name AS sender_last_name,
       (SELECT count(*) FROM inbox_recipients rc WHERE rc.notification_id = n.id)::bigint AS recipient_count,
       (SELECT count(*) FROM inbox_recipients rc WHERE rc.notification_id = n.id AND rc.read_at IS NOT NULL)::bigint AS read_count
FROM inbox_notifications n
LEFT JOIN accounts a ON a.id = n.created_by_account_id
LEFT JOIN people p ON p.id = a.person_id
WHERE n.kind = 'message' AND n.expires_at > sqlc.arg(now)
ORDER BY n.created_at DESC, n.id DESC
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: CountSentMessages :one
SELECT count(*) FROM inbox_notifications WHERE kind = 'message' AND expires_at > sqlc.arg(now);

-- name: ListNotificationRoles :many
SELECT nr.notification_id, r.id AS role_id, r.name AS role_name
FROM inbox_notification_roles nr
JOIN roles r ON r.id = nr.role_id
WHERE nr.notification_id = ANY(sqlc.arg(notification_ids)::text[]::uuid[])
ORDER BY nr.notification_id, lower(r.name), r.id;

-- name: DeleteNotificationsCreatedBefore :execrows
DELETE FROM inbox_notifications WHERE created_at < sqlc.arg(before_time);
