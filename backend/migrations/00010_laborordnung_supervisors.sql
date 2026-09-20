-- +goose Up
ALTER TABLE roles
    ADD COLUMN laborordnung_mode text NOT NULL DEFAULT 'not_required'
        CHECK (laborordnung_mode IN ('not_required', 'warning', 'blocking')),
    ADD COLUMN supervisor_dashboard boolean NOT NULL DEFAULT false;

CREATE TABLE laborordnung_versions (
    id uuid PRIMARY KEY,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    human_revision text NOT NULL CHECK (human_revision = btrim(human_revision) AND human_revision <> '' AND length(human_revision) <= 100),
    pdf_file_id uuid NOT NULL UNIQUE REFERENCES files(id) ON DELETE RESTRICT,
    pdf_sha256 bytea NOT NULL CHECK (octet_length(pdf_sha256) = 32),
    effective_at timestamptz,
    published_at timestamptz,
    created_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((status = 'draft' AND published_at IS NULL AND effective_at IS NULL)
        OR (status = 'published' AND published_at IS NOT NULL AND effective_at IS NOT NULL))
);

CREATE UNIQUE INDEX laborordnung_revision_ci_idx ON laborordnung_versions (lower(human_revision));
CREATE INDEX laborordnung_current_idx ON laborordnung_versions (effective_at DESC, id DESC) WHERE status = 'published';

CREATE TABLE laborordnung_requests (
    id uuid PRIMARY KEY,
    person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    required_version_id uuid NOT NULL REFERENCES laborordnung_versions(id) ON DELETE RESTRICT,
    previous_version_id uuid REFERENCES laborordnung_versions(id) ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'superseded')),
    requested_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    superseded_at timestamptz,
    confirmed_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    physical_document_reference text CHECK (physical_document_reference IS NULL OR (physical_document_reference = btrim(physical_document_reference) AND physical_document_reference <> '' AND length(physical_document_reference) <= 255)),
    signed_date date,
    archive_note text CHECK (archive_note IS NULL OR length(archive_note) <= 1000),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
    CHECK ((status = 'superseded') = (superseded_at IS NOT NULL)),
    CHECK (status <> 'completed' OR (confirmed_by_account_id IS NOT NULL AND physical_document_reference IS NOT NULL))
);

CREATE UNIQUE INDEX laborordnung_one_pending_person_idx ON laborordnung_requests (person_id) WHERE status = 'pending';
CREATE INDEX laborordnung_requests_queue_idx ON laborordnung_requests (status, requested_at, id);
CREATE INDEX laborordnung_requests_person_idx ON laborordnung_requests (person_id, requested_at DESC);

-- +goose StatementBegin
CREATE FUNCTION prevent_published_laborordnung_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND OLD.status = 'published' THEN
        RAISE EXCEPTION 'published Laborordnung versions are immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'published' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'published Laborordnung versions are immutable' USING ERRCODE = '23514';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER laborordnung_versions_immutable
BEFORE UPDATE OR DELETE ON laborordnung_versions
FOR EACH ROW EXECUTE FUNCTION prevent_published_laborordnung_mutation();

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM laborordnung_versions) OR EXISTS (SELECT 1 FROM laborordnung_requests) THEN
        RAISE EXCEPTION 'cannot downgrade while Laborordnung data exists';
    END IF;
END $$;
-- +goose StatementEnd
DROP TRIGGER laborordnung_versions_immutable ON laborordnung_versions;
DROP FUNCTION prevent_published_laborordnung_mutation();
DROP TABLE laborordnung_requests;
DROP TABLE laborordnung_versions;
ALTER TABLE roles DROP COLUMN supervisor_dashboard;
ALTER TABLE roles DROP COLUMN laborordnung_mode;
