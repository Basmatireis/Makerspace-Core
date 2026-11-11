-- name: ListCategories :many
SELECT c.*,
       (SELECT count(*) FROM notification_rules r WHERE r.category_id = c.id)::bigint AS rule_count
FROM notification_categories c
ORDER BY c.position, lower(c.name), c.id;

-- name: GetCategory :one
SELECT c.*,
       (SELECT count(*) FROM notification_rules r WHERE r.category_id = c.id)::bigint AS rule_count
FROM notification_categories c WHERE c.id = sqlc.arg(id);

-- name: GetCategoryForUpdate :one
SELECT * FROM notification_categories WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: CountCategories :one
SELECT count(*) FROM notification_categories;

-- name: InsertCategory :exec
INSERT INTO notification_categories (id, name, description, basis, position)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(description), sqlc.arg(basis), sqlc.arg(position));

-- name: UpdateCategory :execrows
-- Asking again bumps the text version: answers to an older text stop counting.
UPDATE notification_categories
SET name = sqlc.arg(name), description = sqlc.arg(description), position = sqlc.arg(position),
    text_version = text_version + sqlc.arg(version_bump)::int,
    text_changed_at = CASE WHEN sqlc.arg(version_bump)::int > 0 THEN now() ELSE text_changed_at END,
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version);

-- name: DeleteCategory :execrows
DELETE FROM notification_categories WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version);

-- name: ListConsentsOfPerson :many
SELECT * FROM notification_consents WHERE person_id = sqlc.arg(person_id);

-- name: UpsertConsent :exec
INSERT INTO notification_consents (person_id, category_id, granted, text_version, answered_at, place, device_id)
VALUES (sqlc.arg(person_id), sqlc.arg(category_id), sqlc.arg(granted), sqlc.arg(text_version), sqlc.arg(answered_at),
        sqlc.arg(place), sqlc.narg(device_id))
ON CONFLICT (person_id, category_id) DO UPDATE
SET withdrawn_at = CASE
        WHEN EXCLUDED.granted THEN NULL
        WHEN notification_consents.granted THEN EXCLUDED.answered_at
        ELSE notification_consents.withdrawn_at
    END,
    granted = EXCLUDED.granted, text_version = EXCLUDED.text_version, answered_at = EXCLUDED.answered_at,
    place = EXCLUDED.place, device_id = EXCLUDED.device_id;

-- name: DeleteConsentsWithdrawnBefore :execrows
DELETE FROM notification_consents WHERE NOT granted AND withdrawn_at IS NOT NULL AND withdrawn_at < sqlc.arg(cutoff);

-- name: CountPendingConsents :one
-- Consent categories the person has not answered at the category's current text.
SELECT count(*)::bigint FROM notification_categories c
WHERE c.basis = 'consent'
  AND NOT EXISTS (
      SELECT 1 FROM notification_consents n
      WHERE n.person_id = sqlc.arg(person_id) AND n.category_id = c.id AND n.text_version = c.text_version);

-- name: GetPersonSettings :one
SELECT * FROM person_notification_settings WHERE person_id = sqlc.arg(person_id);

-- name: UpsertAskFeedbackAtCheckout :exec
INSERT INTO person_notification_settings (person_id, ask_feedback_at_checkout, updated_at)
VALUES (sqlc.arg(person_id), sqlc.arg(ask), sqlc.arg(now))
ON CONFLICT (person_id) DO UPDATE SET ask_feedback_at_checkout = EXCLUDED.ask_feedback_at_checkout,
    updated_at = EXCLUDED.updated_at;

-- name: ListCentralRules :many
SELECT r.*,
       (SELECT count(*) FROM notification_firings f
        WHERE f.rule_id = r.id AND NOT f.test AND f.created_at >= sqlc.arg(since))::bigint AS fired_recently
FROM notification_rules r
WHERE r.owner_account_id IS NULL
ORDER BY lower(r.name), r.id;

-- name: ListFiringDays :many
-- Firings per rule and day since a point in time, for the sparklines of the rule list.
SELECT f.rule_id, (f.created_at AT TIME ZONE 'UTC')::date AS day, count(*)::bigint AS fired
FROM notification_firings f
WHERE NOT f.test AND f.created_at >= sqlc.arg(since)
GROUP BY f.rule_id, day;

-- name: GetRule :one
SELECT * FROM notification_rules WHERE id = sqlc.arg(id);

-- name: GetRuleForUpdate :one
SELECT * FROM notification_rules WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: CountCentralRules :one
SELECT count(*) FROM notification_rules WHERE owner_account_id IS NULL;

-- name: CountOwnRules :one
SELECT count(*) FROM notification_rules WHERE owner_account_id = sqlc.arg(owner_account_id);

-- name: ListOwnRules :many
SELECT * FROM notification_rules WHERE owner_account_id = sqlc.arg(owner_account_id) ORDER BY lower(name), id;

-- name: InsertRule :exec
INSERT INTO notification_rules (
    id, owner_account_id, name, description, category_id, enabled, mandatory, trigger_type, trigger_event, definition
) VALUES (
    sqlc.arg(id), sqlc.narg(owner_account_id), sqlc.arg(name), sqlc.arg(description), sqlc.narg(category_id),
    sqlc.arg(enabled), sqlc.arg(mandatory), sqlc.arg(trigger_type), sqlc.narg(trigger_event), sqlc.arg(definition)::text::jsonb
);

-- name: UpdateRule :execrows
-- A changed definition clears next_run_at so the scheduler computes it afresh.
UPDATE notification_rules
SET name = sqlc.arg(name), description = sqlc.arg(description), category_id = sqlc.narg(category_id),
    enabled = sqlc.arg(enabled), mandatory = sqlc.arg(mandatory), trigger_type = sqlc.arg(trigger_type),
    trigger_event = sqlc.narg(trigger_event), definition = sqlc.arg(definition)::text::jsonb, next_run_at = NULL,
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version);

-- name: DeleteRule :execrows
DELETE FROM notification_rules WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version);

-- name: ListEnabledCentralRules :many
SELECT r.id, r.name, r.description, r.category_id, r.mandatory, r.definition,
       c.name AS category_name, c.basis AS category_basis, c.text_version AS category_text_version
FROM notification_rules r
JOIN notification_categories c ON c.id = r.category_id
WHERE r.owner_account_id IS NULL AND r.enabled
ORDER BY lower(r.name), r.id;

-- name: ListPreferencesOfAccount :many
SELECT * FROM notification_rule_preferences WHERE account_id = sqlc.arg(account_id);

-- name: UpsertPreference :exec
INSERT INTO notification_rule_preferences (account_id, rule_id, in_app, email, updated_at)
VALUES (sqlc.arg(account_id), sqlc.arg(rule_id), sqlc.arg(in_app), sqlc.arg(email), sqlc.arg(now))
ON CONFLICT (account_id, rule_id) DO UPDATE SET in_app = EXCLUDED.in_app, email = EXCLUDED.email,
    updated_at = EXCLUDED.updated_at;

-- name: GetNotificationSettingsTarget :one
-- A person whose notification settings staff read or change, with their account when they have one.
SELECT p.id AS person_id, a.id AS account_id
FROM people p LEFT JOIN accounts a ON a.person_id = p.id
WHERE p.id = sqlc.arg(person_id);

-- name: ListHeldRoles :many
SELECT r.id, r.name, r.system_key FROM person_roles pr JOIN roles r ON r.id = pr.role_id
WHERE pr.person_id = sqlc.arg(person_id);

-- name: ListMachineOptions :many
SELECT id, name FROM machines ORDER BY lower(name), id;

-- name: ListPrinterOptions :many
SELECT m.id, m.name FROM machines m
WHERE EXISTS (SELECT 1 FROM printer_connector_assignments a WHERE a.machine_id = m.id)
ORDER BY lower(m.name), m.id;

-- name: ListRoleOptions :many
SELECT id, name FROM roles ORDER BY lower(name), id;

-- name: ListTrainingOptions :many
SELECT id, name FROM trainings ORDER BY lower(name), id;

-- name: ListProcessOptions :many
SELECT id, name FROM processes ORDER BY lower(name), id;

-- name: ListFilamentTypeOptions :many
SELECT id, name FROM material_types WHERE kind = 'filament' ORDER BY lower(name), id;

-- name: ListMaterialTypeOptions :many
SELECT id, name FROM material_types ORDER BY lower(name), id;

-- name: ListExistingRoleIDs :many
SELECT id FROM roles WHERE id = ANY(sqlc.arg(ids)::text[]::uuid[]);

-- name: ListExistingPersonIDs :many
SELECT id FROM people WHERE id = ANY(sqlc.arg(ids)::text[]::uuid[]);

-- name: ListExistingDisplayIDs :many
-- Only screens with a device take rule notices; web embeds show public information only.
SELECT id FROM signage_displays WHERE id = ANY(sqlc.arg(ids)::text[]::uuid[]) AND kind = 'device';

-- name: ListExistingDeviceIDs :many
SELECT id FROM managed_devices WHERE id = ANY(sqlc.arg(ids)::text[]::uuid[]);

-- name: DeleteFiringsCreatedBefore :execrows
-- Retention of the delivery log; recipients and pending actions cascade.
DELETE FROM notification_firings WHERE created_at < sqlc.arg(cutoff);

-- name: ListEnabledEventRules :many
-- Enabled central and personal rules that fire on one event. Personal rules have no category and carry their owner.
SELECT r.id, r.name, r.owner_account_id, a.person_id AS owner_person_id, r.category_id, r.mandatory, r.definition,
       c.basis AS category_basis, c.text_version AS category_text_version
FROM notification_rules r
LEFT JOIN notification_categories c ON c.id = r.category_id
LEFT JOIN accounts a ON a.id = r.owner_account_id
WHERE r.enabled AND r.trigger_type = 'event' AND r.trigger_event = sqlc.arg(trigger_event)
ORDER BY r.created_at, r.id;

-- name: ClaimThrottle :execrows
-- Starts the throttle window for a subject unless an earlier one still runs. Zero rows mean the firing is throttled.
INSERT INTO notification_throttle (rule_id, subject_key, last_at)
VALUES (sqlc.arg(rule_id), sqlc.arg(subject_key), sqlc.arg(now))
ON CONFLICT (rule_id, subject_key) DO UPDATE SET last_at = EXCLUDED.last_at
WHERE notification_throttle.last_at <= sqlc.arg(window_start);

-- name: InsertFiring :exec
INSERT INTO notification_firings (id, rule_id, rule_name, trigger_type, summary, resolve_token, test, created_at)
VALUES (sqlc.arg(id), sqlc.arg(rule_id), sqlc.arg(rule_name), sqlc.arg(trigger_type), sqlc.arg(summary),
        sqlc.narg(resolve_token), sqlc.arg(test)::boolean, sqlc.arg(created_at));

-- name: MarkRuleFired :exec
UPDATE notification_rules SET last_fired_at = sqlc.arg(fired_at) WHERE id = sqlc.arg(id);

-- name: InsertFiringRecipient :exec
INSERT INTO notification_firing_recipients (id, firing_id, person_id, channel, step, status, notification_id, sent_at)
VALUES (sqlc.arg(id), sqlc.arg(firing_id), sqlc.narg(person_id), sqlc.arg(channel), sqlc.arg(step), sqlc.arg(status),
        sqlc.narg(notification_id), sqlc.arg(sent_at));

-- name: InsertPendingAction :exec
INSERT INTO notification_pending_actions (id, firing_id, due_at, step, action, item, recipients)
VALUES (sqlc.arg(id), sqlc.arg(firing_id), sqlc.arg(due_at), sqlc.arg(step), sqlc.arg(action)::text::jsonb,
        sqlc.narg(item)::text::jsonb, sqlc.arg(recipients)::text::jsonb);

-- name: ResolveOpenFirings :many
UPDATE notification_firings SET resolved_at = sqlc.arg(resolved_at), resolved_reason = sqlc.arg(reason)
WHERE resolve_token = sqlc.arg(token) AND resolved_at IS NULL
RETURNING id;

-- name: DeletePendingEscalations :execrows
-- Escalation steps and e-mail fallbacks wait for a reaction; delayed first actions do not.
DELETE FROM notification_pending_actions
WHERE firing_id = ANY(sqlc.arg(firing_ids)::text[]::uuid[]) AND (step > 0 OR item->>'fallback' = 'true');

-- name: ListPersonIDsByRoles :many
SELECT DISTINCT person_id FROM person_roles WHERE role_id = ANY(sqlc.arg(role_ids)::text[]::uuid[]) ORDER BY person_id;

-- name: ListDeliveryTargets :many
-- One row per person and enabled account; people without an enabled account come with a NULL account.
SELECT p.id AS person_id, a.id AS account_id, (btrim(coalesce(p.email, '')) <> '')::boolean AS has_email
FROM people p
LEFT JOIN accounts a ON a.person_id = p.id AND a.status = 'enabled'
WHERE p.id = ANY(sqlc.arg(person_ids)::text[]::uuid[])
ORDER BY p.id, a.id;

-- name: ListGrantedConsentPeople :many
SELECT person_id FROM notification_consents
WHERE category_id = sqlc.arg(category_id) AND granted AND text_version = sqlc.arg(text_version)
  AND person_id = ANY(sqlc.arg(person_ids)::text[]::uuid[]);

-- name: ListPreferencesOfRule :many
SELECT account_id, in_app, email FROM notification_rule_preferences
WHERE rule_id = sqlc.arg(rule_id) AND account_id = ANY(sqlc.arg(account_ids)::text[]::uuid[]);

-- name: AccountHasPermission :one
-- Whether an enabled account holds a permission through a role; master holds every registered permission.
SELECT EXISTS (
    SELECT 1
    FROM accounts a
    JOIN person_roles pr ON pr.person_id = a.person_id
    JOIN roles r ON r.id = pr.role_id
    WHERE a.id = sqlc.arg(account_id) AND a.status = 'enabled'
      AND (r.system_key = 'master' OR EXISTS (
          SELECT 1 FROM role_permission_grants g WHERE g.role_id = r.id AND g.permission_id = sqlc.arg(permission_id)::text))
)::boolean;

-- name: ListPeopleWithPermission :many
-- Of the given people, those with an enabled account that holds the permission through a role (master holds all).
SELECT DISTINCT a.person_id
FROM accounts a
JOIN person_roles pr ON pr.person_id = a.person_id
JOIN roles r ON r.id = pr.role_id
WHERE a.person_id = ANY(sqlc.arg(person_ids)::text[]::uuid[]) AND a.status = 'enabled'
  AND (r.system_key = 'master' OR EXISTS (
      SELECT 1 FROM role_permission_grants g WHERE g.role_id = r.id AND g.permission_id = sqlc.arg(permission_id)::text));

-- name: IsPersonMaster :one
SELECT EXISTS (
    SELECT 1 FROM person_roles pr JOIN roles r ON r.id = pr.role_id
    WHERE pr.person_id = sqlc.arg(person_id) AND r.system_key = 'master'
)::boolean;

-- name: MailDeliveryEnabled :one
SELECT COALESCE((SELECT enabled FROM mail_configuration LIMIT 1), false)::boolean;

-- name: InsertRuleNotification :exec
INSERT INTO inbox_notifications (
    id, kind, title, body, link, created_at, expires_at, rule_id, firing_id, category_id,
    appearance, level, toast_seconds, button_kind, button_label, button_link, only_button_closes, allow_later
)
VALUES (sqlc.arg(id), 'rule', sqlc.arg(title), sqlc.arg(body), sqlc.narg(link), sqlc.arg(created_at),
        sqlc.arg(expires_at), sqlc.narg(rule_id), sqlc.arg(firing_id), sqlc.narg(category_id),
        sqlc.arg(appearance), sqlc.arg(level), sqlc.narg(toast_seconds), sqlc.arg(button_kind),
        sqlc.narg(button_label), sqlc.narg(button_link), sqlc.arg(only_button_closes), sqlc.arg(allow_later));

-- name: ListOnlineAccounts :many
-- Accounts that had the application open in a visible tab since the given moment.
SELECT account_id FROM account_presence
WHERE account_id = ANY(sqlc.arg(account_ids)::text[]::uuid[]) AND last_visible_at > sqlc.arg(since);

-- name: InsertRuleNotificationRecipients :exec
INSERT INTO inbox_recipients (notification_id, account_id)
SELECT sqlc.arg(notification_id)::uuid, account_id FROM unnest(sqlc.arg(account_ids)::text[]::uuid[]) AS account_id
ON CONFLICT DO NOTHING;

-- name: InsertRuleMail :exec
INSERT INTO notification_mail_outbox (id, kind, person_id, organization_id, subject, body, link, firing_id)
VALUES (sqlc.arg(id), 'rule', sqlc.narg(person_id), sqlc.narg(organization_id), sqlc.arg(subject), sqlc.arg(body), sqlc.narg(link), sqlc.arg(firing_id));

-- name: ListMembershipsOfPeople :many
SELECT DISTINCT ON (pr.person_id) pr.person_id, r.system_key::text AS membership
FROM person_roles pr
JOIN roles r ON r.id = pr.role_id
WHERE pr.person_id = ANY(sqlc.arg(person_ids)::text[]::uuid[]) AND r.system_key IN ('supervisor', 'trainee', 'visitor')
ORDER BY pr.person_id, CASE r.system_key WHEN 'supervisor' THEN 0 WHEN 'trainee' THEN 1 ELSE 2 END;

-- name: ListRoleIDsOfPeople :many
SELECT person_id, role_id FROM person_roles WHERE person_id = ANY(sqlc.arg(person_ids)::text[]::uuid[]);

-- name: ListCheckedInPeople :many
SELECT DISTINCT person_id FROM visits
WHERE status = 'checked_in' AND person_id = ANY(sqlc.arg(person_ids)::text[]::uuid[]);

-- name: ListAppOpenPeople :many
-- People with at least one account that had the application open in a visible tab since the given moment.
SELECT DISTINCT a.person_id FROM account_presence ap JOIN accounts a ON a.id = ap.account_id
WHERE a.person_id = ANY(sqlc.arg(person_ids)::text[]::uuid[]) AND ap.last_visible_at > sqlc.arg(since);

-- name: CountSupervisorsOnline :one
-- Supervisors (system role) with an account that had the application open in a visible tab since the given moment.
SELECT count(DISTINCT a.person_id)::bigint FROM account_presence ap
JOIN accounts a ON a.id = ap.account_id
JOIN person_roles pr ON pr.person_id = a.person_id
JOIN roles r ON r.id = pr.role_id AND r.system_key = 'supervisor'
WHERE ap.last_visible_at > sqlc.arg(since);

-- name: ListLastVisits :many
-- The day of the last visit (UTC midnight): today while the person is checked in, otherwise the date kept at their
-- last check-out. No visit history is kept.
SELECT p.id AS person_id,
    (COALESCE(
        (SELECT max(v.checked_in_at AT TIME ZONE 'UTC')::date FROM visits v
         WHERE v.person_id = p.id AND v.status = 'checked_in'),
        p.last_visit_on
    )::timestamp AT TIME ZONE 'UTC')::timestamptz AS last_visit
FROM people p
WHERE p.id = ANY(sqlc.arg(person_ids)::text[]::uuid[])
  AND (p.last_visit_on IS NOT NULL OR EXISTS (
      SELECT 1 FROM visits v WHERE v.person_id = p.id AND v.status = 'checked_in'));

-- name: ListPeopleSignedUpBetween :many
SELECT DISTINCT a.person_id
FROM open_day_assignments a
JOIN open_days d ON d.id = a.open_day_id AND d.status = 'scheduled'
JOIN open_day_timeslots t ON t.id = a.timeslot_id
WHERE t.starts_at >= sqlc.arg(from_time) AND t.starts_at < sqlc.arg(to_time)
  AND a.person_id = ANY(sqlc.arg(person_ids)::text[]::uuid[]);

-- name: CountCheckedInPeople :one
SELECT count(*) FROM visits WHERE status = 'checked_in';

-- name: OpenDayRunning :one
SELECT EXISTS (
    SELECT 1 FROM open_days WHERE status = 'scheduled' AND starts_at <= sqlc.arg(now) AND ends_at > sqlc.arg(now)
)::boolean;

-- name: ClaimDuePendingAction :one
-- Takes the oldest due action together with what the delivery needs to know about its firing and rule. The row stays
-- locked until the caller's transaction ends.
SELECT p.id, p.firing_id, p.step, p.action, p.item, p.recipients, p.attempts,
       f.rule_id, f.resolved_at AS firing_resolved_at, f.test AS firing_test,
       r.enabled AS rule_enabled, r.name AS rule_name, r.mandatory, r.category_id, r.definition, r.owner_account_id,
       c.basis AS category_basis, c.text_version AS category_text_version
FROM notification_pending_actions p
JOIN notification_firings f ON f.id = p.firing_id
JOIN notification_rules r ON r.id = f.rule_id
LEFT JOIN notification_categories c ON c.id = r.category_id
WHERE p.due_at <= sqlc.arg(now)
ORDER BY p.due_at, p.id
LIMIT 1
FOR UPDATE OF p SKIP LOCKED;

-- name: DeletePendingAction :exec
DELETE FROM notification_pending_actions WHERE id = sqlc.arg(id);

-- name: DeletePendingActionsOfFiring :exec
DELETE FROM notification_pending_actions WHERE firing_id = sqlc.arg(firing_id) AND step > 0;

-- name: ResolveFiring :exec
UPDATE notification_firings SET resolved_at = sqlc.arg(resolved_at), resolved_reason = sqlc.arg(reason)
WHERE id = sqlc.arg(id) AND resolved_at IS NULL;

-- name: DeferPendingAction :exec
UPDATE notification_pending_actions SET attempts = attempts + 1, due_at = sqlc.arg(due_at) WHERE id = sqlc.arg(id);

-- name: FiringStopReached :one
-- Whether a recipient of an in-app notification of the firing did what stops the escalation: opened it, saw it (opening
-- also counts) or acknowledged it.
SELECT EXISTS (
    SELECT 1 FROM notification_firing_recipients fr
    JOIN inbox_recipients ir ON ir.notification_id = fr.notification_id
    WHERE fr.firing_id = sqlc.arg(firing_id) AND CASE sqlc.arg(stop_when)::text
        WHEN 'opened' THEN ir.read_at IS NOT NULL
        WHEN 'seen' THEN ir.seen_at IS NOT NULL OR ir.read_at IS NOT NULL
        WHEN 'acknowledged' THEN ir.acknowledged_at IS NOT NULL
        ELSE false
    END
)::boolean;

-- name: ListPeopleNotDelivered :many
-- People whose account has neither received the notification on screen nor read it.
SELECT DISTINCT a.person_id FROM inbox_recipients ir
JOIN accounts a ON a.id = ir.account_id
WHERE ir.notification_id = sqlc.arg(notification_id) AND ir.delivered_at IS NULL AND ir.read_at IS NULL;

-- Facts for the events the application itself raises (system notifications).

-- name: GetRunEventFacts :one
SELECT r.id, r.display_id, r.source, r.outcome, r.state, r.started_at, r.ended_at, m.id AS machine_id, m.name AS machine_name,
       j.id AS job_id, j.title AS job_title, j.operator_person_id, j.customer_person_id, j.customer_organization_id
FROM machine_runs r
JOIN machines m ON m.id = r.machine_id
LEFT JOIN machine_jobs j ON j.id = r.job_id
WHERE r.id = sqlc.arg(id);

-- name: GetTimelapseEventFacts :one
-- A recorded run with a live job whose timelapse was stored; runs or jobs in the recycle bin are left out.
SELECT r.id, r.display_id, r.outcome, r.state, m.id AS machine_id, m.name AS machine_name,
       j.title AS job_title, j.display_id AS job_display_id, j.operator_person_id, j.customer_person_id,
       j.customer_organization_id
FROM machine_runs r
JOIN machines m ON m.id = r.machine_id
JOIN machine_jobs j ON j.id = r.job_id AND j.deleted_at IS NULL
WHERE r.id = sqlc.arg(id) AND r.deleted_at IS NULL AND r.source = 'recorded';

-- name: GetRunPrintName :one
-- What a print is called without a job title: the 3MF's original file name, the printer's file name, or the run's number.
SELECT COALESCE(NULLIF(btrim(f.original_filename), ''), NULLIF(btrim(r.file_name), ''), r.display_id)::text AS name
FROM machine_runs r
LEFT JOIN print_artifacts pa ON pa.id = r.artifact_id
LEFT JOIN files f ON f.id = pa.original_file_id
WHERE r.id = sqlc.arg(id);

-- name: ListPeopleWithPasswordAccount :many
-- People who can sign in with a password: an enabled account with a usable password identity.
SELECT DISTINCT a.person_id
FROM accounts a
JOIN auth_identities i ON i.account_id = a.id AND i.kind = 'password' AND i.disabled_at IS NULL
JOIN password_credentials pc ON pc.auth_identity_id = i.id
WHERE a.person_id = ANY(sqlc.arg(person_ids)::text[]::uuid[]) AND a.status = 'enabled'
ORDER BY a.person_id;

-- name: GetMachineEventFacts :one
-- The machine and the operator of the run that is printing on it right now, if any.
SELECT m.id, m.name AS machine_name, r.id AS run_id, r.display_id AS run_display_id, j.title AS job_title,
       j.operator_person_id, j.customer_person_id, j.customer_organization_id
FROM machines m
LEFT JOIN machine_runs r ON r.id = (
    SELECT x.id
    FROM machine_runs x
    WHERE x.machine_id = m.id AND x.deleted_at IS NULL AND x.source = 'recorded' AND x.state = 'running'
    ORDER BY x.started_at DESC NULLS LAST, x.created_at DESC
    LIMIT 1
)
LEFT JOIN machine_jobs j ON j.id = r.job_id
WHERE m.id = sqlc.arg(id);

-- name: GetSpoolEventFacts :one
-- How a spool is named to people: its label and its article.
SELECT s.display_id, mat.name AS material_name, mat.color_name
FROM filament_spools s
LEFT JOIN materials mat ON mat.id = s.material_id
WHERE s.id = sqlc.arg(id);

-- name: GetPrinterErrorMeaning :one
SELECT title FROM printer_error_codes WHERE source_family = sqlc.arg(source_family) AND code = sqlc.arg(code);

-- name: ListAllCheckedInPeople :many
SELECT DISTINCT person_id FROM visits WHERE status = 'checked_in' ORDER BY person_id;

-- name: ListPersonIDsOfAccounts :many
SELECT DISTINCT person_id FROM accounts WHERE id = ANY(sqlc.arg(account_ids)::text[]::uuid[]);

-- name: ListPeopleWithEnabledAccount :many
SELECT DISTINCT person_id FROM accounts
WHERE person_id = ANY(sqlc.arg(person_ids)::text[]::uuid[]) AND status = 'enabled'
ORDER BY person_id;

-- name: ListStaffingPeople :many
-- People with an active account who staff open days (supervisor or trainee membership).
SELECT DISTINCT a.person_id
FROM accounts a
JOIN person_roles pr ON pr.person_id = a.person_id
JOIN roles r ON r.id = pr.role_id
WHERE a.status = 'enabled' AND r.system_key IN ('supervisor', 'trainee')
ORDER BY a.person_id;

-- name: ListUnassignedSupervisorPeople :many
-- People with an active account and the supervisor membership who hold no place in the timeslot.
SELECT DISTINCT a.person_id
FROM accounts a
JOIN person_roles pr ON pr.person_id = a.person_id
JOIN roles r ON r.id = pr.role_id
WHERE a.status = 'enabled'
  AND r.system_key = 'supervisor'
  AND a.person_id <> sqlc.arg(excluded_person_id)::uuid
  AND NOT EXISTS (
      SELECT 1 FROM open_day_assignments x
      WHERE x.timeslot_id = sqlc.arg(timeslot_id)::uuid AND x.person_id = a.person_id
  )
ORDER BY a.person_id;

-- name: ListOpenDayTeam :many
SELECT DISTINCT person_id FROM open_day_assignments WHERE open_day_id = sqlc.arg(open_day_id) ORDER BY person_id;

-- name: GetOpenDayPeriodEventFacts :one
SELECT id, name, sign_up_deadline FROM open_day_periods WHERE id = sqlc.arg(id);

-- name: GetOpenDayPeriodChangeFacts :one
SELECT p.id, p.name,
       (SELECT count(*) FROM open_days d WHERE d.period_id = p.id AND d.status = 'scheduled')::integer AS day_count
FROM open_day_periods p WHERE p.id = sqlc.arg(id);

-- name: GetOpenDayTimeslotEventFacts :one
SELECT d.id AS open_day_id, d.period_id, t.starts_at, t.ends_at, d.status
FROM open_day_timeslots t
JOIN open_days d ON d.id = t.open_day_id
WHERE t.id = sqlc.arg(id);

-- name: GetStaffingWarningDays :one
SELECT warning_window_days FROM staffing_rules WHERE singleton = true;

-- name: ListPeopleAwaitingLabRules :many
-- People with an active account whose roles ask for the Lab Rules (warning or blocking) and who have not confirmed
-- the version.
SELECT DISTINCT a.person_id
FROM accounts a
WHERE a.status = 'enabled'
  AND EXISTS (
      SELECT 1 FROM person_roles pr JOIN roles r ON r.id = pr.role_id
      WHERE pr.person_id = a.person_id AND r.laborordnung_mode IN ('warning', 'blocking')
  )
  AND NOT EXISTS (
      SELECT 1 FROM laborordnung_confirmations c
      WHERE c.person_id = a.person_id AND c.version_id = sqlc.arg(version_id)
  )
ORDER BY a.person_id;

-- name: GetLabRulesRevision :one
SELECT human_revision FROM laborordnung_versions WHERE id = sqlc.arg(id);

-- name: MarkLabRulesNoticesRead :execrows
-- The notifications that announced new Lab Rules, written by the "lab_rules_published" rule (or, before the rules
-- existed, as their own kind), are read once the person confirmed.
UPDATE inbox_recipients r
SET read_at = now()
FROM inbox_notifications n, accounts a
WHERE n.id = r.notification_id
  AND (n.kind = 'lab_rules_published'
       OR n.rule_id IN (SELECT id FROM notification_rules WHERE system_key = 'lab_rules_published'))
  AND a.id = r.account_id AND a.person_id = sqlc.arg(person_id) AND r.read_at IS NULL;

-- Scheduling, rule runs and the collections rules loop over.

-- name: GetRuleForRun :one
SELECT r.id, r.name, r.enabled, r.owner_account_id, a.person_id AS owner_person_id, r.category_id, r.mandatory,
       r.trigger_type, r.definition, r.updated_at, r.next_run_at,
       c.basis AS category_basis, c.text_version AS category_text_version
FROM notification_rules r
LEFT JOIN notification_categories c ON c.id = r.category_id
LEFT JOIN accounts a ON a.id = r.owner_account_id
WHERE r.id = sqlc.arg(id);

-- name: ClaimDueScheduleRule :one
-- Takes one enabled schedule rule that is due, or has no next run yet, and keeps it locked until the transaction ends.
SELECT r.id, r.name, r.enabled, r.owner_account_id, a.person_id AS owner_person_id, r.category_id, r.mandatory,
       r.trigger_type, r.definition, r.updated_at, r.next_run_at,
       c.basis AS category_basis, c.text_version AS category_text_version
FROM notification_rules r
LEFT JOIN notification_categories c ON c.id = r.category_id
LEFT JOIN accounts a ON a.id = r.owner_account_id
WHERE r.enabled AND r.trigger_type = 'schedule' AND (r.next_run_at IS NULL OR r.next_run_at <= sqlc.arg(now))
ORDER BY r.next_run_at NULLS FIRST, r.id
LIMIT 1
FOR UPDATE OF r SKIP LOCKED;

-- name: SetNextRun :exec
UPDATE notification_rules SET next_run_at = sqlc.narg(next_run_at) WHERE id = sqlc.arg(id);

-- name: ClaimRuleRun :execrows
-- Zero rows mean the run was handled before.
INSERT INTO notification_rule_runs (rule_id, run_key, ran_at)
VALUES (sqlc.arg(rule_id), sqlc.arg(run_key), sqlc.arg(now))
ON CONFLICT (rule_id, run_key) DO NOTHING;

-- name: DeleteRuleRunsBefore :execrows
DELETE FROM notification_rule_runs WHERE ran_at < sqlc.arg(cutoff);

-- name: OnAcademicBreak :one
SELECT EXISTS (
    SELECT 1 FROM open_day_academic_breaks WHERE starts_on <= sqlc.arg(day)::date AND ends_on >= sqlc.arg(day)::date
)::boolean;

-- name: GetCurrentLabRulesVersion :one
SELECT id FROM laborordnung_versions
WHERE status = 'published' AND effective_at <= sqlc.arg(now)
ORDER BY effective_at DESC, id DESC LIMIT 1;

-- name: ListPeopleNames :many
SELECT id, first_name, last_name FROM people WHERE id = ANY(sqlc.arg(person_ids)::text[]::uuid[]);

-- name: LoadPeopleItems :many
SELECT p.id, p.first_name, p.last_name,
       EXISTS (SELECT 1 FROM accounts a WHERE a.person_id = p.id AND a.status = 'enabled')::boolean AS has_account,
       (SELECT count(*) FROM machine_runs r JOIN machine_jobs j ON j.id = r.job_id
        WHERE j.operator_person_id = p.id AND j.deleted_at IS NULL AND r.deleted_at IS NULL
          AND r.started_at IS NOT NULL AND r.ended_at IS NULL)::bigint AS running
FROM people p
ORDER BY lower(p.last_name), lower(p.first_name), p.id
LIMIT sqlc.arg(max_items);

-- name: ListUnpaidOfPeople :many
-- Finalized orders with an outstanding amount that no active external invoice request covers, per customer.
SELECT x.customer_person_id AS person_id, count(*)::bigint AS orders, sum(x.outstanding)::float8 AS amount,
       min(x.since)::timestamptz AS oldest
FROM (
    SELECT o.customer_person_id, COALESCE(o.finalized_at, o.created_at) AS since,
           o.total_amount - COALESCE((SELECT sum(a.amount) FROM order_adjustments a WHERE a.order_id = o.id), 0)
             - COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.order_id = o.id), 0) AS outstanding
    FROM orders o
    WHERE o.status = 'finalized' AND o.customer_person_id = ANY(sqlc.arg(person_ids)::text[]::uuid[])
      AND NOT EXISTS (SELECT 1 FROM external_invoice_requests r WHERE r.order_id = o.id AND r.state <> 'cancelled')
) x
WHERE x.outstanding > 0
GROUP BY x.customer_person_id;

-- name: ListPeopleAwaitingVersion :many
SELECT DISTINCT a.person_id
FROM accounts a
WHERE a.status = 'enabled'
  AND EXISTS (
      SELECT 1 FROM person_roles pr JOIN roles r ON r.id = pr.role_id
      WHERE pr.person_id = a.person_id AND r.laborordnung_mode IN ('warning', 'blocking')
  )
  AND NOT EXISTS (
      SELECT 1 FROM laborordnung_confirmations c WHERE c.person_id = a.person_id AND c.version_id = sqlc.arg(version_id)
  );

-- name: LoadOpenDayItems :many
-- Open days starting within the window, of one period or of every period.
SELECT d.id, d.period_id, d.starts_at, d.ends_at, d.status,
       (SELECT count(*) FROM open_day_timeslots t WHERE t.open_day_id = d.id)::bigint AS timeslots,
       (SELECT count(DISTINCT a.person_id) FROM open_day_assignments a
        JOIN open_day_staff_requirements r ON r.id = a.requirement_id
        WHERE a.open_day_id = d.id AND r.kind = 'supervisor')::bigint AS supervisors,
       (SELECT count(DISTINCT a.person_id) FROM open_day_assignments a
        JOIN open_day_staff_requirements r ON r.id = a.requirement_id
        WHERE a.open_day_id = d.id AND r.kind = 'trainee')::bigint AS trainees,
       (SELECT COALESCE(sum(GREATEST(0, r.required_count
                - (SELECT count(*) FROM open_day_assignments sa WHERE sa.requirement_id = r.id))), 0)
        FROM open_day_staff_requirements r JOIN open_day_timeslots t ON t.id = r.timeslot_id
        WHERE t.open_day_id = d.id AND r.kind = 'supervisor')::bigint AS free
FROM open_days d
WHERE (sqlc.narg(period_id)::uuid IS NULL OR d.period_id = sqlc.narg(period_id))
  AND d.starts_at >= sqlc.arg(from_time) AND d.starts_at < sqlc.arg(to_time)
ORDER BY d.starts_at, d.id
LIMIT sqlc.arg(max_items);

-- name: ListOpenDayTeams :many
-- Everyone signed up for the open days, with the kind of place they hold.
SELECT DISTINCT a.open_day_id, a.person_id, r.kind
FROM open_day_assignments a
JOIN open_day_staff_requirements r ON r.id = a.requirement_id
WHERE a.open_day_id = ANY(sqlc.arg(open_day_ids)::text[]::uuid[]);

-- name: LoadMachineItems :many
SELECT m.id, m.name, m.status, m.process_id,
       (SELECT count(*) FROM machine_runs r
        WHERE r.machine_id = m.id AND r.deleted_at IS NULL AND r.started_at >= sqlc.arg(day_start))::bigint AS runs_today,
       (SELECT count(*) FROM printer_error_occurrences e
        WHERE e.machine_id = m.id AND e.first_observed_at >= sqlc.arg(week_start))::bigint AS errors_week,
       EXISTS (SELECT 1 FROM printer_connector_assignments a JOIN printer_connectors c ON c.id = a.connector_id
               WHERE a.machine_id = m.id AND c.lifecycle = 'active'
                 AND c.last_heartbeat_at > sqlc.arg(online_since))::boolean AS online
FROM machines m
ORDER BY lower(m.name), m.id
LIMIT sqlc.arg(max_items);

-- name: ListProcessNames :many
SELECT id, name FROM processes;

-- name: LoadSpoolItems :many
SELECT s.id, s.display_id, mt.id AS material_type_id, mt.name AS material_type_name, COALESCE(m.color_name, '')::text AS color_name,
       filament_spool_remaining(s.id)::float8 AS remaining,
       EXISTS (SELECT 1 FROM printer_spool_assignments a WHERE a.spool_id = s.id AND a.unmounted_at IS NULL)::boolean AS loaded,
       COALESCE((SELECT max(GREATEST(a.mounted_at, COALESCE(a.unmounted_at, a.mounted_at)))
                 FROM printer_spool_assignments a WHERE a.spool_id = s.id), s.created_at)::timestamptz AS last_use
FROM filament_spools s
JOIN materials m ON m.id = s.material_id
JOIN material_types mt ON mt.id = m.material_type_id
WHERE s.lifecycle = 'active'
ORDER BY s.display_id, s.id
LIMIT sqlc.arg(max_items);

-- name: LoadOrderItems :many
SELECT x.id, x.reference, x.customer_kind, x.customer_person_id, x.customer_organization_id, x.creator_person_id, x.status,
       x.amount::float8 AS amount, x.outstanding::float8 AS outstanding, x.since::timestamptz AS since, x.invoice::boolean AS invoice
FROM (
    SELECT o.id, o.reference, o.customer_kind, o.customer_person_id, o.customer_organization_id,
           (SELECT a.person_id FROM accounts a WHERE a.id = o.created_by_account_id) AS creator_person_id,
           o.status, o.created_at,
           o.total_amount - COALESCE((SELECT sum(a.amount) FROM order_adjustments a WHERE a.order_id = o.id), 0) AS amount,
           o.total_amount - COALESCE((SELECT sum(a.amount) FROM order_adjustments a WHERE a.order_id = o.id), 0)
             - COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.order_id = o.id), 0) AS outstanding,
           COALESCE(o.finalized_at, o.created_at) AS since,
           EXISTS (SELECT 1 FROM external_invoice_requests r WHERE r.order_id = o.id AND r.state <> 'cancelled') AS invoice
    FROM orders o
) x
ORDER BY x.created_at DESC, x.id DESC
LIMIT sqlc.arg(max_items);

-- name: LoadJobItems :many
SELECT j.id, j.display_id, COALESCE(j.title, '')::text AS title, j.machine_id, j.pricing_status, j.operator_person_id,
       j.customer_person_id, j.customer_organization_id, j.outcome_override,
       COALESCE(s.run_count, 0)::bigint AS run_count, COALESCE(s.running, false)::boolean AS running,
       COALESCE(s.derived_outcome, '')::text AS derived_outcome,
       GREATEST(j.created_at, COALESCE(s.ended_at::timestamptz, j.created_at))::timestamptz AS since,
       EXISTS (SELECT 1 FROM order_job_claims c WHERE c.machine_job_id = j.id)::boolean AS on_order,
       ma.name AS machine_name
FROM machine_jobs j
JOIN machines ma ON ma.id = j.machine_id
LEFT JOIN machine_job_run_summaries s ON s.job_id = j.id
WHERE j.deleted_at IS NULL
ORDER BY j.created_at DESC, j.id DESC
LIMIT sqlc.arg(max_items);

-- name: LoadArticleItems :many
SELECT m.id, m.name, m.material_type_id, t.name AS material_type_name, COALESCE(b.quantity, 0)::float8 AS stock,
       COALESCE(m.low_stock_threshold, 0)::float8 AS minimum, COALESCE(m.storage_location, '')::text AS location
FROM materials m
JOIN material_types t ON t.id = m.material_type_id
LEFT JOIN material_balances b ON b.material_id = m.id
WHERE m.active AND m.deleted_at IS NULL AND t.kind <> 'filament'
ORDER BY lower(m.name), m.id
LIMIT sqlc.arg(max_items);

-- name: LoadTrainingItems :many
SELECT r.person_id, r.training_id, p.first_name, p.last_name, t.name AS training_name, r.status, r.completed_on
FROM training_records r
JOIN people p ON p.id = r.person_id
JOIN trainings t ON t.id = r.training_id
ORDER BY lower(p.last_name), lower(p.first_name), lower(t.name), r.person_id
LIMIT sqlc.arg(max_items);

-- name: ListTrainersOfTrainings :many
SELECT training_id, person_id FROM training_records WHERE status = 'trainer';

-- name: CountPrinterErrorsSince :one
SELECT count(*)::bigint FROM printer_error_occurrences WHERE first_observed_at >= sqlc.arg(since);

-- name: CountFinishedJobRunsSince :one
SELECT count(*)::bigint FROM machine_runs
WHERE job_id IS NOT NULL AND deleted_at IS NULL AND ended_at >= sqlc.arg(since);

-- name: CountJobRunTimelapsesSince :one
SELECT count(*)::bigint FROM machine_run_timelapses t
JOIN machine_runs r ON r.id = t.run_id
WHERE r.job_id IS NOT NULL AND r.deleted_at IS NULL AND t.created_at >= sqlc.arg(since);

-- name: CountLabRulesPublishedSince :one
SELECT count(*)::bigint FROM laborordnung_versions WHERE status = 'published' AND effective_at >= sqlc.arg(since);

-- name: CountScheduledOpenDaysBetween :one
SELECT count(*)::bigint FROM open_days WHERE status = 'scheduled' AND starts_at >= sqlc.arg(from_time) AND starts_at < sqlc.arg(to_time);

-- name: ListActivity :many
SELECT f.id, f.rule_id, f.rule_name, f.trigger_type, f.summary, f.test, f.resolved_at, f.resolved_reason, f.created_at,
       (SELECT count(*) FROM notification_firing_recipients r WHERE r.firing_id = f.id AND r.status IN ('sent', 'fallback'))::bigint AS reached,
       (SELECT count(*) FROM notification_firing_recipients r WHERE r.firing_id = f.id AND r.status = 'throttled')::bigint AS throttled,
       (SELECT count(*) FROM notification_firing_recipients r WHERE r.firing_id = f.id AND r.step > 0)::bigint AS escalated,
       (SELECT count(*) FROM notification_firing_recipients r WHERE r.firing_id = f.id)::bigint AS total
FROM notification_firings f
WHERE (sqlc.narg(rule_id)::uuid IS NULL OR f.rule_id = sqlc.narg(rule_id))
ORDER BY f.created_at DESC, f.id DESC
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: CountActivity :one
SELECT count(*)::bigint FROM notification_firings f WHERE (sqlc.narg(rule_id)::uuid IS NULL OR f.rule_id = sqlc.narg(rule_id));

-- name: ListActivityRecipients :many
SELECT r.firing_id, r.person_id, p.first_name, p.last_name, r.channel, r.step, r.status, r.sent_at,
       COALESCE((SELECT extract(epoch FROM min(ir.read_at)) FROM inbox_recipients ir
                 WHERE ir.notification_id = r.notification_id
                   AND ir.account_id IN (SELECT a.id FROM accounts a WHERE a.person_id = r.person_id)), 0)::float8 AS read_epoch,
       COALESCE((SELECT extract(epoch FROM min(ir.delivered_at)) FROM inbox_recipients ir
                 WHERE ir.notification_id = r.notification_id
                   AND ir.account_id IN (SELECT a.id FROM accounts a WHERE a.person_id = r.person_id)), 0)::float8 AS delivered_epoch,
       COALESCE((SELECT extract(epoch FROM min(ir.seen_at)) FROM inbox_recipients ir
                 WHERE ir.notification_id = r.notification_id
                   AND ir.account_id IN (SELECT a.id FROM accounts a WHERE a.person_id = r.person_id)), 0)::float8 AS seen_epoch,
       COALESCE((SELECT extract(epoch FROM min(ir.acknowledged_at)) FROM inbox_recipients ir
                 WHERE ir.notification_id = r.notification_id
                   AND ir.account_id IN (SELECT a.id FROM accounts a WHERE a.person_id = r.person_id)), 0)::float8 AS acknowledged_epoch
FROM notification_firing_recipients r
LEFT JOIN people p ON p.id = r.person_id
WHERE r.firing_id = ANY(sqlc.arg(firing_ids)::text[]::uuid[])
ORDER BY r.firing_id, r.step, lower(p.last_name), lower(p.first_name), r.channel;

-- name: GetVisitEventFacts :one
-- The facts of a visit for the check-in and check-out triggers. first_visit is true when the person has no completed
-- visit yet: check-out records the last visit date after this runs.
SELECT v.person_id, v.checked_in_at, v.checked_out_at, v.check_in_method, v.check_out_method, v.admission_decision,
       p.first_name, p.last_name,
       din.name AS check_in_device, dout.name AS check_out_device,
       (p.last_visit_on IS NULL)::boolean AS first_visit
FROM visits v
JOIN people p ON p.id = v.person_id
LEFT JOIN managed_devices din ON din.id = v.check_in_device_id
LEFT JOIN managed_devices dout ON dout.id = v.check_out_device_id
WHERE v.id = sqlc.arg(id);

-- name: ListSupervisorsOnDuty :many
-- Supervisors who are checked in right now.
SELECT DISTINCT v.person_id
FROM visits v
JOIN person_roles pr ON pr.person_id = v.person_id
JOIN roles r ON r.id = pr.role_id AND r.system_key = 'supervisor'
WHERE v.status = 'checked_in'
ORDER BY v.person_id;

-- name: GetTrainingName :one
SELECT name FROM trainings WHERE id = sqlc.arg(id);

-- name: ListTrainersOfTraining :many
SELECT person_id FROM training_records WHERE training_id = sqlc.arg(training_id) AND status = 'trainer' ORDER BY person_id;

-- name: GetOrderEventFacts :one
SELECT o.reference, o.total_amount::float8 AS total, o.customer_person_id, o.customer_organization_id,
       creator.person_id AS creator_person_id,
       COALESCE(CASE WHEN o.customer_person_id IS NOT NULL THEN customer.first_name || ' ' || customer.last_name
                     ELSE org.name END, '')::text AS customer_name
FROM orders o
LEFT JOIN accounts creator ON creator.id = o.created_by_account_id
LEFT JOIN people customer ON customer.id = o.customer_person_id
LEFT JOIN organizations org ON org.id = o.customer_organization_id
WHERE o.id = sqlc.arg(id);

-- name: GetPaymentEventFacts :one
SELECT pay.method, pay.amount::float8 AS amount, booker.person_id AS booker_person_id
FROM payments pay
LEFT JOIN accounts booker ON booker.id = pay.actor_account_id
WHERE pay.id = sqlc.arg(id);

-- name: GetCashCountEventFacts :one
SELECT c.reference, c.counted_amount::float8 AS counted, c.expected_amount::float8 AS expected,
       c.difference::float8 AS difference, c.recorded_by_person_id
FROM cash_counts c
WHERE c.id = sqlc.arg(id);

-- name: GetInvoiceRequestEventFacts :one
SELECT r.reference, r.state, r.order_id, r.order_reference, creator.person_id AS creator_person_id
FROM external_invoice_requests r
LEFT JOIN orders o ON o.id = r.order_id
LEFT JOIN accounts creator ON creator.id = o.created_by_account_id
WHERE r.id = sqlc.arg(id);

-- name: GetJobEventFacts :one
SELECT j.display_id, j.title, j.machine_id, m.name AS machine_name, j.customer_person_id,
       j.customer_organization_id, j.operator_person_id
FROM machine_jobs j
JOIN machines m ON m.id = j.machine_id
WHERE j.id = sqlc.arg(id);

-- name: GetSurveyResponseEventFacts :one
-- Only the survey itself: a response is never tied to a person here, whether the survey is anonymous or not.
SELECT s.name AS survey_name, s.anonymous
FROM survey_responses r
JOIN survey_versions v ON v.id = r.survey_version_id
JOIN surveys s ON s.id = v.survey_id
WHERE r.id = sqlc.arg(id);

-- name: GetFirstRatingOfResponse :one
SELECT a.numeric_value::int AS rating
FROM survey_answers a
JOIN survey_questions q ON q.id = a.question_id
WHERE a.response_id = sqlc.arg(response_id) AND q.kind = 'rating' AND a.numeric_value IS NOT NULL
ORDER BY q.position
LIMIT 1;

-- name: GetRoleEventFacts :one
-- privileged: the master role, or a role that grants any *.manage permission.
SELECT r.name,
       (COALESCE(r.system_key = 'master', false) OR EXISTS (
           SELECT 1 FROM role_permission_grants rp WHERE rp.role_id = r.id AND rp.permission_id LIKE '%.manage'
       ))::boolean AS privileged
FROM roles r
WHERE r.id = sqlc.arg(id);

-- name: GetPrivacyRequestEventFacts :one
SELECT kind, reference, due_at, subject_person_id FROM privacy_subject_requests WHERE id = sqlc.arg(id);

-- name: CountVisitsSince :one
-- Completed visits come from the UTC daily statistics, so the first day counts in full.
SELECT ((SELECT COALESCE(sum(visitor_count), 0) FROM attendance_daily_statistics
         WHERE day >= (sqlc.arg(since)::timestamptz AT TIME ZONE 'UTC')::date)
    + (SELECT count(*) FROM visits WHERE status = 'checked_in' AND checked_in_at >= sqlc.arg(since)::timestamptz))::bigint;

-- name: CountCheckOutsSince :one
SELECT COALESCE(sum(completed_visit_count), 0)::bigint FROM attendance_daily_statistics
WHERE day >= (sqlc.arg(since)::timestamptz AT TIME ZONE 'UTC')::date;

-- name: CountAccountsCreatedSince :one
SELECT count(*)::bigint FROM accounts WHERE created_at >= sqlc.arg(since)::timestamptz;

-- name: CountTrainingRecordsSince :one
SELECT count(*)::bigint FROM training_records WHERE created_at >= sqlc.arg(since)::timestamptz;

-- name: CountFinalizedOrdersSince :one
SELECT count(*)::bigint FROM orders WHERE finalized_at >= sqlc.arg(since)::timestamptz;

-- name: CountReceiptPaymentsSince :one
SELECT count(*)::bigint FROM payments WHERE entry_kind = 'receipt' AND recorded_at >= sqlc.arg(since)::timestamptz;

-- name: CountCashCountDifferencesSince :one
SELECT count(*)::bigint FROM cash_counts WHERE difference <> 0 AND created_at >= sqlc.arg(since)::timestamptz;

-- name: CountInvoiceRequestEventsSince :one
SELECT count(*)::bigint FROM external_invoice_request_events WHERE recorded_at >= sqlc.arg(since)::timestamptz;

-- name: CountJobsCreatedSince :one
SELECT count(*)::bigint FROM machine_jobs WHERE deleted_at IS NULL AND created_at >= sqlc.arg(since)::timestamptz;

-- name: CountSurveyResponsesSince :one
SELECT count(*)::bigint FROM survey_responses WHERE submitted_on >= sqlc.arg(since)::date;

-- name: CountPrivacyRequestsSince :one
SELECT count(*)::bigint FROM privacy_subject_requests WHERE created_at >= sqlc.arg(since)::timestamptz;

-- name: CountOpenDaySignupsSince :one
SELECT count(*)::bigint FROM open_day_assignments WHERE created_at >= sqlc.arg(since)::timestamptz;

-- Notices on signage displays and entrance tablets ---------------------------------------------------------------------

-- name: InsertSignageRuleNotice :execrows
INSERT INTO signage_rule_notices (id, firing_id, display_id, title, body, tone, starts_at, ends_at)
SELECT sqlc.arg(id), sqlc.narg(firing_id), d.id, sqlc.arg(title), sqlc.arg(body), sqlc.arg(tone), sqlc.arg(starts_at),
       sqlc.arg(ends_at)
FROM signage_displays d WHERE d.id = sqlc.arg(display_id) AND d.kind = 'device';

-- name: InsertKioskRuleNotice :execrows
INSERT INTO kiosk_rule_notices (id, group_id, firing_id, device_id, mode, person_id, title, body, level, must_tap,
                                created_at, expires_at)
SELECT sqlc.arg(id), sqlc.arg(group_id), sqlc.narg(firing_id), d.id, sqlc.arg(mode), sqlc.narg(person_id),
       sqlc.arg(title), sqlc.arg(body), sqlc.arg(level), sqlc.arg(must_tap), sqlc.arg(created_at), sqlc.arg(expires_at)
FROM managed_devices d WHERE d.id = sqlc.arg(device_id) AND d.revoked_at IS NULL;

-- name: EndSignageRuleNoticesOfFirings :exec
UPDATE signage_rule_notices SET ends_at = sqlc.arg(now)
WHERE firing_id = ANY(sqlc.arg(firing_ids)::text[]::uuid[]) AND ends_at > sqlc.arg(now) AND starts_at < sqlc.arg(now);

-- name: ExpireKioskRuleNoticesOfFirings :exec
UPDATE kiosk_rule_notices SET expires_at = sqlc.arg(now)
WHERE firing_id = ANY(sqlc.arg(firing_ids)::text[]::uuid[]) AND expires_at > sqlc.arg(now) AND created_at < sqlc.arg(now);

-- name: ListKioskDeviceNotices :many
-- What the tablet itself shows: start-screen banners and the notices for everybody who checks in today.
SELECT id, mode, title, body, level, must_tap FROM kiosk_rule_notices
WHERE device_id = sqlc.arg(device_id) AND mode IN ('banner', 'everyone_today') AND expires_at > sqlc.arg(now)
ORDER BY created_at, id;

-- name: ListKioskPersonNotices :many
-- Unshown notices for one person at one tablet. Rows are locked so that two simultaneous check-ins show a notice once.
SELECT id, group_id, mode, title, body, level, must_tap FROM kiosk_rule_notices
WHERE device_id = sqlc.arg(device_id) AND person_id = sqlc.arg(person_id) AND shown_at IS NULL
  AND mode IN ('person_checkin', 'next_checkin') AND expires_at > sqlc.arg(now)
ORDER BY created_at, id
FOR UPDATE;

-- name: MarkKioskNoticesShown :exec
UPDATE kiosk_rule_notices SET shown_at = sqlc.arg(now)
WHERE person_id = sqlc.arg(person_id) AND group_id = ANY(sqlc.arg(group_ids)::text[]::uuid[]) AND shown_at IS NULL;

-- name: DeleteSignageRuleNoticesBefore :execrows
DELETE FROM signage_rule_notices WHERE ends_at < sqlc.arg(cutoff);

-- name: DeleteKioskRuleNoticesBefore :execrows
DELETE FROM kiosk_rule_notices WHERE expires_at < sqlc.arg(cutoff);

-- name: ListPendingConsentCategories :many
-- The consent categories the person has not answered at the category's current text.
SELECT c.*, 0::bigint AS rule_count FROM notification_categories c
WHERE c.basis = 'consent'
  AND NOT EXISTS (
      SELECT 1 FROM notification_consents n
      WHERE n.person_id = sqlc.arg(person_id) AND n.category_id = c.id AND n.text_version = c.text_version)
ORDER BY c.position, c.id;
