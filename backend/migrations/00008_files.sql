-- +goose Up
CREATE TABLE files (
    id uuid PRIMARY KEY,
    storage_key text NOT NULL UNIQUE CHECK (storage_key = btrim(storage_key) AND storage_key <> '' AND length(storage_key) <= 255),
    original_filename text NOT NULL CHECK (original_filename = btrim(original_filename) AND original_filename <> '' AND length(original_filename) <= 255),
    content_type text NOT NULL CHECK (content_type = btrim(content_type) AND content_type <> '' AND length(content_type) <= 255),
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
    sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
    created_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX files_creator_idx ON files (created_by_account_id, created_at DESC);

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM files) THEN
        RAISE EXCEPTION 'cannot downgrade while private file metadata exists';
    END IF;
END $$;
-- +goose StatementEnd
DROP TABLE files;
