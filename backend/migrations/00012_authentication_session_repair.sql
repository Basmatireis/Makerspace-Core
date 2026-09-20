-- +goose Up
-- 00005 made authenticated_at NOT NULL after backfilling existing sessions,
-- but omitted the default required by every new session INSERT. This forward
-- repair is intentionally schema-only: identities and password hashes are not
-- rewritten or guessed.
ALTER TABLE sessions ALTER COLUMN authenticated_at SET DEFAULT now();

-- Fail rather than attempting to repair ambiguous credential ownership.
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM password_credentials pc
        LEFT JOIN auth_identities i ON i.id = pc.auth_identity_id
        WHERE i.id IS NULL OR i.kind <> 'password'
    ) THEN
        RAISE EXCEPTION 'password credential ownership is ambiguous; manual investigation required';
    END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
ALTER TABLE sessions ALTER COLUMN authenticated_at DROP DEFAULT;
