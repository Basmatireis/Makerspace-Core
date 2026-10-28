-- name: GetPrivacySettings :one
SELECT * FROM privacy_settings WHERE singleton;

-- name: LockPrivacySettings :one
SELECT * FROM privacy_settings WHERE singleton FOR UPDATE;

-- name: UpdatePrivacySettings :one
UPDATE privacy_settings
SET controller_name = sqlc.arg(controller_name), controller_address = sqlc.arg(controller_address),
    data_protection_contact = sqlc.arg(data_protection_contact),
    automatic_runs_enabled = sqlc.arg(automatic_runs_enabled), run_interval_minutes = sqlc.arg(run_interval_minutes),
    version = version + 1, updated_at = now(), updated_by_account_id = sqlc.narg(updated_by_account_id)
WHERE singleton AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: UpsertCategorySnapshot :exec
-- Records a declared category; a category seen again is no longer orphaned.
INSERT INTO privacy_category_snapshots (category_id, owner_module_id, definition)
VALUES (sqlc.arg(category_id), sqlc.arg(owner_module_id), (sqlc.arg(definition)::text)::jsonb)
ON CONFLICT (category_id) DO UPDATE
SET owner_module_id = EXCLUDED.owner_module_id, definition = EXCLUDED.definition, last_seen_at = now(), orphaned = false;

-- name: OrphanCategorySnapshots :execrows
-- Marks every snapshot that is not in the list of currently declared categories.
UPDATE privacy_category_snapshots SET orphaned = true
WHERE NOT orphaned AND category_id <> ALL(sqlc.arg(declared)::text[]);

-- name: ListCategorySnapshots :many
SELECT * FROM privacy_category_snapshots ORDER BY category_id;

-- name: ListPolicies :many
SELECT * FROM privacy_policy_versions ORDER BY category_id, version DESC;

-- name: ListActivePolicies :many
SELECT * FROM privacy_policy_versions WHERE status = 'active' ORDER BY category_id;

-- name: GetPolicy :one
SELECT * FROM privacy_policy_versions WHERE id = sqlc.arg(id);

-- name: LockPolicy :one
SELECT * FROM privacy_policy_versions WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: LockCategoryPolicies :many
SELECT * FROM privacy_policy_versions WHERE category_id = sqlc.arg(category_id) ORDER BY version FOR UPDATE;

-- name: NextPolicyVersion :one
SELECT COALESCE(max(version), 0) + 1 AS version FROM privacy_policy_versions WHERE category_id = sqlc.arg(category_id);

-- name: CountPoliciesForCategory :one
SELECT count(*) FROM privacy_policy_versions WHERE category_id = sqlc.arg(category_id);

-- name: InsertPolicy :one
INSERT INTO privacy_policy_versions (
    id, category_id, version, trigger, period_days, action, purpose, legal_basis, reason, status, source_template, created_by_account_id
) VALUES (
    sqlc.arg(id), sqlc.arg(category_id), sqlc.arg(version), sqlc.arg(trigger), sqlc.arg(period_days), sqlc.arg(action),
    sqlc.arg(purpose), sqlc.arg(legal_basis), sqlc.arg(reason), 'draft', sqlc.narg(source_template), sqlc.narg(created_by_account_id)
) RETURNING *;

-- name: UpdateDraftPolicy :one
UPDATE privacy_policy_versions
SET trigger = sqlc.arg(trigger), period_days = sqlc.arg(period_days), action = sqlc.arg(action), purpose = sqlc.arg(purpose),
    legal_basis = sqlc.arg(legal_basis), reason = sqlc.arg(reason), updated_at = now()
WHERE id = sqlc.arg(id) AND status = 'draft'
RETURNING *;

-- name: ApprovePolicy :one
UPDATE privacy_policy_versions
SET status = 'approved', approved_at = now(), approved_by_account_id = sqlc.narg(approved_by_account_id), updated_at = now()
WHERE id = sqlc.arg(id) AND status = 'draft'
RETURNING *;

-- name: ActivatePolicy :one
UPDATE privacy_policy_versions
SET status = 'active', activated_at = now(), activated_by_account_id = sqlc.narg(activated_by_account_id), updated_at = now()
WHERE id = sqlc.arg(id) AND status = 'approved'
RETURNING *;

-- name: RetirePolicy :one
UPDATE privacy_policy_versions
SET status = 'retired', retired_at = now(), updated_at = now()
WHERE id = sqlc.arg(id) AND status IN ('draft', 'approved', 'active')
RETURNING *;

-- name: ListHolds :many
SELECT * FROM privacy_retention_holds ORDER BY released_at NULLS FIRST, created_at DESC;

-- name: ListOpenHolds :many
SELECT * FROM privacy_retention_holds WHERE released_at IS NULL;

-- name: InsertHold :one
INSERT INTO privacy_retention_holds (id, category_id, subject_person_id, reason, created_by_account_id)
VALUES (sqlc.arg(id), sqlc.narg(category_id), sqlc.narg(subject_person_id), sqlc.arg(reason), sqlc.narg(created_by_account_id))
RETURNING *;

-- name: ReleaseHold :one
UPDATE privacy_retention_holds
SET released_at = now(), released_by_account_id = sqlc.narg(released_by_account_id)
WHERE id = sqlc.arg(id) AND released_at IS NULL
RETURNING *;

-- name: InsertRun :one
INSERT INTO privacy_retention_runs (id, mode, trigger, actor_account_id, status)
VALUES (sqlc.arg(id), sqlc.arg(mode), sqlc.arg(trigger), sqlc.narg(actor_account_id), 'running')
RETURNING *;

-- name: FinishRun :one
UPDATE privacy_retention_runs
SET status = sqlc.arg(status), finished_at = now(), error_code = sqlc.narg(error_code)
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: InsertRunItem :exec
INSERT INTO privacy_retention_run_items (run_id, category_id, policy_id, action, cutoff, affected_count, status, error_code)
VALUES (sqlc.arg(run_id), sqlc.arg(category_id), sqlc.narg(policy_id), sqlc.arg(action), sqlc.arg(cutoff), sqlc.arg(affected_count), sqlc.arg(status), sqlc.narg(error_code));

-- name: ListRuns :many
SELECT * FROM privacy_retention_runs ORDER BY started_at DESC LIMIT sqlc.arg(row_limit);

-- name: GetRun :one
SELECT * FROM privacy_retention_runs WHERE id = sqlc.arg(id);

-- name: ListRunItems :many
SELECT * FROM privacy_retention_run_items WHERE run_id = sqlc.arg(run_id) ORDER BY category_id;

-- name: LastRun :one
SELECT * FROM privacy_retention_runs ORDER BY started_at DESC LIMIT 1;
