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

-- name: ListEnabledAccountIDsOfPerson :many
SELECT id FROM accounts WHERE person_id = sqlc.arg(person_id) AND status = 'enabled' ORDER BY id;

-- name: GetAccountPersonName :one
SELECT p.first_name, p.last_name
FROM accounts a
JOIN people p ON p.id = a.person_id
WHERE a.id = sqlc.arg(account_id);

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

-- name: GetSentMessageForUpdate :one
SELECT id, title, body, link FROM inbox_notifications
WHERE id = sqlc.arg(id) AND kind = 'message' AND expires_at > sqlc.arg(now)
FOR UPDATE;

-- name: UpdateSentMessage :exec
UPDATE inbox_notifications
SET title = sqlc.arg(title), body = sqlc.arg(body), link = sqlc.narg(link)
WHERE id = sqlc.arg(id);

-- name: GetSentMessage :one
SELECT n.id, n.title, n.body, n.link, n.created_at, n.expires_at,
       p.first_name AS sender_first_name, p.last_name AS sender_last_name,
       (SELECT count(*) FROM inbox_recipients rc WHERE rc.notification_id = n.id)::bigint AS recipient_count,
       (SELECT count(*) FROM inbox_recipients rc WHERE rc.notification_id = n.id AND rc.read_at IS NOT NULL)::bigint AS read_count
FROM inbox_notifications n
LEFT JOIN accounts a ON a.id = n.created_by_account_id
LEFT JOIN people p ON p.id = a.person_id
WHERE n.id = sqlc.arg(id) AND n.kind = 'message';

-- name: DeleteSentMessage :execrows
-- Recipient rows and role rows go with it (ON DELETE CASCADE).
DELETE FROM inbox_notifications WHERE id = sqlc.arg(id) AND kind = 'message' AND expires_at > sqlc.arg(now);

-- name: DeleteNotificationsCreatedBefore :execrows
DELETE FROM inbox_notifications WHERE created_at < sqlc.arg(before_time);

-- name: MailDeliveryEnabled :one
SELECT COALESCE((SELECT enabled FROM mail_configuration LIMIT 1), false)::boolean;

-- name: ClaimDueNotificationMails :many
-- Takes due mails for one delivery pass: the attempt is counted and the next one pushed out before anything is sent,
-- so a pass that dies half way never sends a mail twice in quick succession.
UPDATE notification_mail_outbox o
SET attempts = o.attempts + 1, next_attempt_at = sqlc.arg(lease_until)
WHERE o.id IN (
    SELECT x.id FROM notification_mail_outbox x
    WHERE x.next_attempt_at <= sqlc.arg(now)
    ORDER BY x.next_attempt_at, x.id
    LIMIT sqlc.arg(batch_limit)
    FOR UPDATE SKIP LOCKED
)
RETURNING o.id, o.kind, o.person_id, o.organization_id, o.subject, o.body, o.link, o.attempts;

-- name: GetNotificationMailAddress :one
-- The address is read only when the mail is sent; a deleted person or organization yields none.
SELECT COALESCE((SELECT NULLIF(btrim(p.email), '') FROM people p WHERE p.id = sqlc.narg(person_id)),
                (SELECT NULLIF(btrim(o.contact_email), '') FROM organizations o WHERE o.id = sqlc.narg(organization_id)), '')::text AS address;

-- name: DeleteNotificationMail :exec
DELETE FROM notification_mail_outbox WHERE id = sqlc.arg(id);

-- name: DeferNotificationMail :exec
UPDATE notification_mail_outbox SET next_attempt_at = sqlc.arg(next_attempt_at) WHERE id = sqlc.arg(id);

-- name: DeleteNotificationMailsCreatedBefore :execrows
DELETE FROM notification_mail_outbox WHERE created_at < sqlc.arg(before_time);
