-- +goose Up
-- Data-subject requests (access and erasure) of the privacy registry, their
-- lifecycle steps, and the record of processing activities the operator
-- maintains. A request holds only counts and outcomes per category, never the
-- exported data itself: an access export is a private file in the file store
-- that only `privacy.requests.execute` can download.
CREATE TABLE privacy_processing_activities (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    purpose text NOT NULL DEFAULT '' CHECK (length(purpose) <= 2000),
    legal_basis text NOT NULL DEFAULT '' CHECK (length(legal_basis) <= 500),
    category_ids text[] NOT NULL DEFAULT '{}',
    recipients text NOT NULL DEFAULT '' CHECK (length(recipients) <= 1000),
    retention_note text NOT NULL DEFAULT '' CHECK (length(retention_note) <= 1000),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL
);

CREATE TABLE privacy_subject_requests (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('access', 'erasure')),
    status text NOT NULL CHECK (status IN (
        'received', 'identity_verified', 'assessed', 'approved', 'executing',
        'completed', 'partially_completed', 'rejected'
    )),
    -- The subject. Erasure deletes the person, so the link is cleared by the database and the
    -- request keeps only the operator's reference (a ticket number, never the subject's name).
    subject_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
    reference text NOT NULL DEFAULT '' CHECK (length(reference) <= 100),
    channel text NOT NULL CHECK (channel IN ('email', 'in_person', 'letter', 'other')),
    received_at timestamptz NOT NULL,
    due_at timestamptz NOT NULL,
    notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
    identity_verified_at timestamptz,
    identity_verified_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    assessed_at timestamptz,
    assessment jsonb,
    approved_at timestamptz,
    approved_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    executed_at timestamptz,
    executed_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    export_file_id uuid REFERENCES files(id) ON DELETE SET NULL,
    result jsonb,
    completed_at timestamptz,
    rejection_reason text NOT NULL DEFAULT '' CHECK (length(rejection_reason) <= 1000),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX privacy_subject_requests_received_idx ON privacy_subject_requests (received_at DESC);
CREATE INDEX privacy_subject_requests_subject_idx ON privacy_subject_requests (subject_person_id) WHERE subject_person_id IS NOT NULL;

-- Each lifecycle transition, with its actor and note, in order.
CREATE TABLE privacy_subject_request_steps (
    id uuid PRIMARY KEY,
    request_id uuid NOT NULL REFERENCES privacy_subject_requests(id) ON DELETE CASCADE,
    status text NOT NULL,
    actor_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    note text NOT NULL DEFAULT '' CHECK (length(note) <= 1000)
);
CREATE INDEX privacy_subject_request_steps_request_idx ON privacy_subject_request_steps (request_id, occurred_at);

INSERT INTO master_reauthentication_permissions (permission_id, within_minutes) VALUES
    ('privacy.requests.manage', 10), ('privacy.requests.execute', 10)
ON CONFLICT (permission_id) DO NOTHING;

-- +goose Down
DELETE FROM master_reauthentication_permissions WHERE permission_id IN ('privacy.requests.manage', 'privacy.requests.execute');
DELETE FROM role_permission_grants WHERE permission_id IN ('privacy.requests.manage', 'privacy.requests.execute');
DROP TABLE privacy_subject_request_steps;
DROP TABLE privacy_subject_requests;
DROP TABLE privacy_processing_activities;
