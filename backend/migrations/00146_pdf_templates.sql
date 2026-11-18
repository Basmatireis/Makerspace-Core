-- +goose Up
-- Editable PDF templates. One row per version of the template of an export (wiref, cashbook, receipt). Without a
-- row the built-in default is in effect. At most one draft and one published version exist per export; replacing the
-- published version archives the old one. The document is validated strictly by the application before it is stored.
-- The permission pdf_templates.manage is granted to no role here: master derives its permissions from application
-- code, anyone else receives it through a role edited by an administrator.
CREATE TABLE pdf_template_versions (
    id uuid PRIMARY KEY,
    export_kind text NOT NULL CONSTRAINT pdf_template_versions_export_kind_check CHECK (export_kind IN ('wiref', 'cashbook', 'receipt')),
    version integer NOT NULL CONSTRAINT pdf_template_versions_version_check CHECK (version > 0),
    state text NOT NULL CONSTRAINT pdf_template_versions_state_check CHECK (state IN ('draft', 'published', 'archived')),
    document jsonb NOT NULL CONSTRAINT pdf_template_versions_document_check CHECK (jsonb_typeof(document) = 'object' AND octet_length(document::text) <= 262144),
    revision integer NOT NULL DEFAULT 1 CONSTRAINT pdf_template_versions_revision_check CHECK (revision > 0),
    created_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    published_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    CONSTRAINT pdf_template_versions_export_version_key UNIQUE (export_kind, version),
    CONSTRAINT pdf_template_versions_published_check CHECK (state = 'draft' OR published_at IS NOT NULL)
);
CREATE UNIQUE INDEX pdf_template_versions_one_draft_idx ON pdf_template_versions (export_kind) WHERE state = 'draft';
CREATE UNIQUE INDEX pdf_template_versions_one_published_idx ON pdf_template_versions (export_kind) WHERE state = 'published';

-- Images and graphics that templates may place. The content type is sniffed from the bytes by the application.
CREATE TABLE pdf_template_assets (
    id uuid PRIMARY KEY,
    file_name text NOT NULL CONSTRAINT pdf_template_assets_file_name_check CHECK (length(file_name) BETWEEN 1 AND 200),
    content_type text NOT NULL CONSTRAINT pdf_template_assets_content_type_check CHECK (content_type IN ('image/png', 'image/jpeg', 'image/svg+xml')),
    byte_size integer NOT NULL CONSTRAINT pdf_template_assets_byte_size_check CHECK (byte_size BETWEEN 1 AND 2097152),
    sha256 bytea NOT NULL CONSTRAINT pdf_template_assets_sha256_check CHECK (octet_length(sha256) = 32),
    data bytea NOT NULL CONSTRAINT pdf_template_assets_data_check CHECK (octet_length(data) = byte_size),
    width integer NOT NULL DEFAULT 0 CONSTRAINT pdf_template_assets_width_check CHECK (width BETWEEN 0 AND 4000),
    height integer NOT NULL DEFAULT 0 CONSTRAINT pdf_template_assets_height_check CHECK (height BETWEEN 0 AND 4000),
    created_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pdf_template_assets_created_idx ON pdf_template_assets (created_at DESC, id DESC);

-- +goose Down
-- Rolling back removes every stored template version and uploaded image; the built-in defaults take over again.
DROP TABLE pdf_template_assets;
DROP TABLE pdf_template_versions;
