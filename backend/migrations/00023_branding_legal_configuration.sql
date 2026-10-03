-- +goose Up
CREATE TABLE branding_configuration (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    legal_organization_name text NOT NULL CHECK (legal_organization_name = btrim(legal_organization_name) AND legal_organization_name <> '' AND length(legal_organization_name) <= 200),
    display_name text NOT NULL CHECK (display_name = btrim(display_name) AND display_name <> '' AND length(display_name) <= 100),
    application_name text NOT NULL CHECK (application_name = btrim(application_name) AND application_name <> '' AND length(application_name) <= 150),
    tagline text CHECK (tagline IS NULL OR (tagline = btrim(tagline) AND tagline <> '' AND length(tagline) <= 240)),
    primary_color text NOT NULL CHECK (primary_color ~ '^#[0-9a-f]{6}$'),
    secondary_color text NOT NULL CHECK (secondary_color ~ '^#[0-9a-f]{6}$'),
    accent_color text NOT NULL CHECK (accent_color ~ '^#[0-9a-f]{6}$'),
    background_color text NOT NULL CHECK (background_color ~ '^#[0-9a-f]{6}$'),
    imprint_mode text NOT NULL CHECK (imprint_mode IN ('internal', 'external')),
    imprint_markdown text NOT NULL CHECK (octet_length(imprint_markdown) <= 102400),
    imprint_external_url text NOT NULL CHECK (length(imprint_external_url) <= 2048),
    privacy_mode text NOT NULL CHECK (privacy_mode IN ('internal', 'external')),
    privacy_markdown text NOT NULL CHECK (octet_length(privacy_markdown) <= 102400),
    privacy_external_url text NOT NULL CHECK (length(privacy_external_url) <= 2048),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO branding_configuration (
    singleton, legal_organization_name, display_name, application_name, tagline,
    primary_color, secondary_color, accent_color, background_color,
    imprint_mode, imprint_markdown, imprint_external_url,
    privacy_mode, privacy_markdown, privacy_external_url
) VALUES (
    true, 'HTU Graz', 'Makerspace', 'HTU Graz Makerspace', NULL,
    '#57569f', '#ffbf3d', '#e76f12', '#111621',
    'internal', '', '', 'internal', '', ''
);

CREATE TABLE branding_asset_overrides (
    slot text PRIMARY KEY CHECK (slot IN ('logo', 'compact_logo', 'favicon', 'application_background', 'authentication_background')),
    mode text NOT NULL CHECK (mode IN ('custom', 'none')),
    file_id uuid UNIQUE REFERENCES files(id) ON DELETE RESTRICT,
    updated_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((mode = 'custom' AND file_id IS NOT NULL) OR (mode = 'none' AND file_id IS NULL))
);

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM branding_asset_overrides WHERE file_id IS NOT NULL) THEN
        RAISE EXCEPTION 'cannot downgrade while custom branding assets exist';
    END IF;
END $$;
-- +goose StatementEnd
DROP TABLE branding_asset_overrides;
DROP TABLE branding_configuration;
