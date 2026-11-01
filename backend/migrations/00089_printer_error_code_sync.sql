-- +goose Up
-- The catalog knows where a meaning came from: entered here, or fetched from Bambu Lab's published list. The sync
-- never overwrites what someone wrote here.
ALTER TABLE printer_error_codes
    ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'bambu'));
CREATE TABLE printer_error_code_sync (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    last_attempt_at timestamptz,
    last_success_at timestamptz,
    last_error text CHECK (last_error IS NULL OR length(last_error) <= 500),
    imported_count integer NOT NULL DEFAULT 0 CHECK (imported_count >= 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO printer_error_code_sync (singleton) VALUES (true);

-- +goose Down
DROP TABLE printer_error_code_sync;
DELETE FROM printer_error_codes WHERE source = 'bambu';
ALTER TABLE printer_error_codes DROP COLUMN source;
