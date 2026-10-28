-- +goose Up
-- Retention policies, holds and run history of the privacy registry. A policy
-- is a versioned, reviewed decision per data category; exactly one version per
-- category can be active. Nothing is deleted by a policy until it is active and
-- either automatic runs are switched on or an operator starts a run.
CREATE TABLE privacy_policy_versions (
    id uuid PRIMARY KEY,
    category_id text NOT NULL CHECK (category_id ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
    version integer NOT NULL CHECK (version > 0),
    trigger text NOT NULL CHECK (trigger IN ('created_at', 'completed_at', 'cancelled_at', 'expired_at', 'account_closed_at', 'last_used_at', 'legal_period_end', 'ended_at')),
    period_days integer NOT NULL CHECK (period_days BETWEEN 0 AND 36500),
    action text NOT NULL CHECK (action IN ('delete', 'anonymize', 'unlink', 'redact', 'retain_with_review')),
    purpose text NOT NULL DEFAULT '' CHECK (length(purpose) <= 1000),
    legal_basis text NOT NULL DEFAULT '' CHECK (length(legal_basis) <= 500),
    reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 2000),
    status text NOT NULL CHECK (status IN ('draft', 'approved', 'active', 'retired')),
    source_template text CHECK (source_template IS NULL OR length(source_template) <= 200),
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    approved_at timestamptz,
    approved_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    activated_at timestamptz,
    activated_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    retired_at timestamptz,
    UNIQUE (category_id, version)
);
CREATE UNIQUE INDEX privacy_policy_versions_active_idx ON privacy_policy_versions (category_id) WHERE status = 'active';

-- A hold suspends retention for a category or for one person until released.
CREATE TABLE privacy_retention_holds (
    id uuid PRIMARY KEY,
    category_id text CHECK (category_id IS NULL OR category_id ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
    subject_person_id uuid REFERENCES people(id) ON DELETE CASCADE,
    reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    released_at timestamptz,
    released_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    CHECK (category_id IS NOT NULL OR subject_person_id IS NOT NULL)
);
CREATE INDEX privacy_retention_holds_open_idx ON privacy_retention_holds (category_id) WHERE released_at IS NULL;

-- Runs record counts per category, never the affected records.
CREATE TABLE privacy_retention_runs (
    id uuid PRIMARY KEY,
    mode text NOT NULL CHECK (mode IN ('dry_run', 'execute')),
    trigger text NOT NULL CHECK (trigger IN ('manual', 'scheduled', 'cli')),
    actor_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{0,99}$')
);
CREATE INDEX privacy_retention_runs_started_idx ON privacy_retention_runs (started_at DESC);

CREATE TABLE privacy_retention_run_items (
    run_id uuid NOT NULL REFERENCES privacy_retention_runs(id) ON DELETE CASCADE,
    category_id text NOT NULL,
    policy_id uuid REFERENCES privacy_policy_versions(id) ON DELETE SET NULL,
    action text NOT NULL,
    cutoff timestamptz NOT NULL,
    affected_count bigint NOT NULL DEFAULT 0 CHECK (affected_count >= 0),
    status text NOT NULL CHECK (status IN ('applied', 'skipped_hold', 'skipped_no_handler', 'failed')),
    error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{0,99}$'),
    PRIMARY KEY (run_id, category_id)
);

INSERT INTO master_reauthentication_permissions (permission_id, within_minutes) VALUES
    ('privacy.policies.manage', 10), ('privacy.retention.execute', 10)
ON CONFLICT (permission_id) DO NOTHING;

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM privacy_policy_versions WHERE status = 'active') THEN
        RAISE EXCEPTION 'active retention policies exist; retire them before downgrading';
    END IF;
END $$;
-- +goose StatementEnd
DELETE FROM master_reauthentication_permissions WHERE permission_id IN ('privacy.policies.manage', 'privacy.retention.execute');
DELETE FROM role_permission_grants WHERE permission_id IN ('privacy.policies.manage', 'privacy.retention.execute');
DROP TABLE privacy_retention_run_items;
DROP TABLE privacy_retention_runs;
DROP TABLE privacy_retention_holds;
DROP TABLE privacy_policy_versions;
