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
SET granted = EXCLUDED.granted, text_version = EXCLUDED.text_version, answered_at = EXCLUDED.answered_at,
    place = EXCLUDED.place, device_id = EXCLUDED.device_id;

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
SELECT id FROM signage_displays WHERE id = ANY(sqlc.arg(ids)::text[]::uuid[]);

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
INSERT INTO notification_firings (id, rule_id, rule_name, trigger_type, summary, resolve_token, created_at)
VALUES (sqlc.arg(id), sqlc.arg(rule_id), sqlc.arg(rule_name), sqlc.arg(trigger_type), sqlc.arg(summary),
        sqlc.narg(resolve_token), sqlc.arg(created_at));

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

-- name: MailDeliveryEnabled :one
SELECT COALESCE((SELECT enabled FROM mail_configuration LIMIT 1), false)::boolean;

-- name: InsertRuleNotification :exec
INSERT INTO inbox_notifications (id, kind, title, body, link, created_at, expires_at, rule_id, firing_id, category_id)
VALUES (sqlc.arg(id), 'rule', sqlc.arg(title), sqlc.arg(body), sqlc.narg(link), sqlc.arg(created_at),
        sqlc.arg(expires_at), sqlc.narg(rule_id), sqlc.arg(firing_id), sqlc.narg(category_id));

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

-- name: ListLastVisits :many
SELECT person_id, max(checked_in_at)::timestamptz AS last_visit FROM visits
WHERE status <> 'voided' AND person_id = ANY(sqlc.arg(person_ids)::text[]::uuid[])
GROUP BY person_id;

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

-- name: FiringWasRead :one
-- Whether anybody opened an in-app notification of the firing.
SELECT EXISTS (
    SELECT 1 FROM notification_firing_recipients fr
    JOIN inbox_recipients ir ON ir.notification_id = fr.notification_id
    WHERE fr.firing_id = sqlc.arg(firing_id) AND ir.read_at IS NOT NULL
)::boolean;

-- name: ListPeopleWhoHaveNotRead :many
SELECT DISTINCT a.person_id FROM inbox_recipients ir
JOIN accounts a ON a.id = ir.account_id
WHERE ir.notification_id = sqlc.arg(notification_id) AND ir.read_at IS NULL;

-- Facts for the events the application itself raises (system notifications).

-- name: GetRunEventFacts :one
SELECT r.id, r.display_id, r.outcome, r.state, r.started_at, r.ended_at, m.id AS machine_id, m.name AS machine_name,
       j.id AS job_id, j.title AS job_title, j.operator_person_id, j.customer_person_id, j.customer_organization_id
FROM machine_runs r
JOIN machines m ON m.id = r.machine_id
LEFT JOIN machine_jobs j ON j.id = r.job_id
WHERE r.id = sqlc.arg(id);

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
