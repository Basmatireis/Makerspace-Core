-- +goose Up
-- Timelapse limits next to the retention period: the largest accepted video, how many videos are kept and how much
-- storage they may take. 0 means no limit for the count and the total.
ALTER TABLE run_recording_settings
    ADD COLUMN timelapse_max_bytes bigint NOT NULL DEFAULT 2147483648
        CHECK (timelapse_max_bytes BETWEEN 1048576 AND 8589934592),
    ADD COLUMN timelapse_max_count integer NOT NULL DEFAULT 0 CHECK (timelapse_max_count >= 0),
    ADD COLUMN timelapse_max_total_bytes bigint NOT NULL DEFAULT 0 CHECK (timelapse_max_total_bytes >= 0);

-- Who is told about printer errors besides the operator of the running print, and from which severity on.
CREATE TABLE printer_notification_settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    error_role_id uuid REFERENCES roles(id) ON DELETE SET NULL,
    error_min_severity text NOT NULL DEFAULT 'serious'
        CHECK (error_min_severity IN ('fatal', 'serious', 'common', 'info')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO printer_notification_settings (singleton) VALUES (true);

-- What a printer error code means, kept by the makerspace. The connector only knows the code.
CREATE TABLE printer_error_codes (
    id uuid PRIMARY KEY,
    source_family text NOT NULL CHECK (source_family IN ('print', 'hms')),
    code text NOT NULL CHECK (code = btrim(code) AND code <> '' AND length(code) <= 120),
    title text NOT NULL CHECK (title = btrim(title) AND title <> '' AND length(title) <= 160),
    description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
    link text CHECK (link IS NULL OR (link LIKE 'https://%' AND length(link) <= 500)),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_family, code)
);

-- The severity a Bambu HMS code carries (its third group), so repeats of harmless notices stay quiet.
ALTER TABLE printer_error_occurrences
    ADD COLUMN severity text CHECK (severity IS NULL OR severity IN ('fatal', 'serious', 'common', 'info')),
    ADD COLUMN cleared_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL;

-- +goose Down
ALTER TABLE printer_error_occurrences DROP COLUMN cleared_by_account_id, DROP COLUMN severity;
DROP TABLE printer_error_codes;
DROP TABLE printer_notification_settings;
ALTER TABLE run_recording_settings
    DROP COLUMN timelapse_max_total_bytes, DROP COLUMN timelapse_max_count, DROP COLUMN timelapse_max_bytes;
