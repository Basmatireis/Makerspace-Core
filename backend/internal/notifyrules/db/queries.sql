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
