-- +goose Up
-- Digital signage: media assets, scenes, playlists, announcements, displays, rules and publications.
-- Streaming-gateway tables follow in a later migration. A display is bound 1:1 to a managed device;
-- the managed-device mode `signage_player` itself is added together with the player API.

CREATE TABLE signage_assets (
    id uuid PRIMARY KEY,
    file_id uuid NOT NULL UNIQUE REFERENCES files(id) ON DELETE RESTRICT,
    kind text NOT NULL CHECK (kind IN ('image', 'video')),
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 150),
    width integer CHECK (width IS NULL OR width BETWEEN 1 AND 20000),
    height integer CHECK (height IS NULL OR height BETWEEN 1 AND 20000),
    duration_ms integer CHECK (duration_ms IS NULL OR duration_ms > 0),
    created_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((width IS NULL) = (height IS NULL)),
    CHECK (kind = 'video' OR (width IS NOT NULL AND duration_ms IS NULL))
);
CREATE INDEX signage_assets_created_idx ON signage_assets (created_at DESC, id DESC);

CREATE TABLE signage_scenes (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 100),
    orientation text NOT NULL CHECK (orientation IN ('portrait', 'landscape')),
    layout_id text NOT NULL CHECK (layout_id ~ '^[a-z][a-z0-9_]{0,39}$'),
    background_color text NOT NULL CHECK (background_color ~ '^#[0-9a-f]{6}$'),
    background_asset_id uuid REFERENCES signage_assets(id) ON DELETE RESTRICT,
    background_fit text NOT NULL DEFAULT 'cover' CHECK (background_fit IN ('cover', 'contain')),
    background_dim integer NOT NULL DEFAULT 0 CHECK (background_dim BETWEEN 0 AND 80),
    theme text NOT NULL CHECK (theme IN ('dark', 'light')),
    zones jsonb NOT NULL CHECK (jsonb_typeof(zones) = 'object'),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signage_scenes_name_idx ON signage_scenes (lower(name), id);
CREATE INDEX signage_scenes_background_asset_idx ON signage_scenes (background_asset_id) WHERE background_asset_id IS NOT NULL;

CREATE TABLE signage_playlists (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 100),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signage_playlists_name_idx ON signage_playlists (lower(name), id);

CREATE TABLE signage_playlist_items (
    playlist_id uuid NOT NULL REFERENCES signage_playlists(id) ON DELETE CASCADE,
    position integer NOT NULL CHECK (position >= 0),
    scene_id uuid NOT NULL REFERENCES signage_scenes(id) ON DELETE RESTRICT,
    seconds integer NOT NULL CHECK (seconds BETWEEN 3 AND 3600),
    transition text NOT NULL CHECK (transition IN ('cut', 'fade')),
    PRIMARY KEY (playlist_id, position)
);
CREATE INDEX signage_playlist_items_scene_idx ON signage_playlist_items (scene_id);

CREATE TABLE signage_announcement_templates (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 100),
    tone text NOT NULL CHECK (tone IN ('info', 'warning', 'critical', 'neutral')),
    title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    body text NOT NULL DEFAULT '' CHECK (length(body) <= 2000),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signage_announcement_templates_name_idx ON signage_announcement_templates (lower(name), id);

CREATE TABLE signage_announcement_template_fields (
    template_id uuid NOT NULL REFERENCES signage_announcement_templates(id) ON DELETE CASCADE,
    position integer NOT NULL CHECK (position >= 0),
    key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$' AND key NOT IN ('ends_at', 'ends_on', 'ends', 'starts_at', 'today', 'display', 'location')),
    label text NOT NULL CHECK (label = btrim(label) AND label <> '' AND length(label) <= 100),
    type text NOT NULL CHECK (type IN ('text', 'longtext', 'time', 'date', 'datetime', 'number', 'choice', 'machine')),
    required boolean NOT NULL DEFAULT false,
    default_value text NOT NULL DEFAULT '' CHECK (length(default_value) <= 2000),
    helper_text text NOT NULL DEFAULT '' CHECK (length(helper_text) <= 300),
    options text[] NOT NULL DEFAULT '{}',
    PRIMARY KEY (template_id, position),
    UNIQUE (template_id, key),
    CHECK ((type = 'choice') = (cardinality(options) > 0))
);

CREATE TABLE signage_announcements (
    id uuid PRIMARY KEY,
    template_id uuid NOT NULL REFERENCES signage_announcement_templates(id) ON DELETE RESTRICT,
    all_displays boolean NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz,
    created_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX signage_announcements_template_idx ON signage_announcements (template_id);
CREATE INDEX signage_announcements_ends_idx ON signage_announcements (ends_at) WHERE ends_at IS NOT NULL;

CREATE TABLE signage_announcement_values (
    announcement_id uuid NOT NULL REFERENCES signage_announcements(id) ON DELETE CASCADE,
    key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
    value text NOT NULL CHECK (length(value) <= 2000),
    PRIMARY KEY (announcement_id, key)
);

CREATE TABLE signage_displays (
    id uuid PRIMARY KEY,
    managed_device_id uuid NOT NULL UNIQUE REFERENCES managed_devices(id) ON DELETE RESTRICT,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 100),
    location text NOT NULL DEFAULT '' CHECK (location = btrim(location) AND length(location) <= 150),
    orientation text NOT NULL CHECK (orientation IN ('portrait', 'landscape')),
    resolution_width integer NOT NULL CHECK (resolution_width BETWEEN 320 AND 16384),
    resolution_height integer NOT NULL CHECK (resolution_height BETWEEN 320 AND 16384),
    visible_from_outside boolean NOT NULL DEFAULT false,
    default_playlist_id uuid NOT NULL REFERENCES signage_playlists(id) ON DELETE RESTRICT,
    revoked_at timestamptz,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signage_displays_default_playlist_idx ON signage_displays (default_playlist_id);

CREATE TABLE signage_announcement_displays (
    announcement_id uuid NOT NULL REFERENCES signage_announcements(id) ON DELETE CASCADE,
    display_id uuid NOT NULL REFERENCES signage_displays(id) ON DELETE CASCADE,
    PRIMARY KEY (announcement_id, display_id)
);
CREATE INDEX signage_announcement_displays_display_idx ON signage_announcement_displays (display_id);

CREATE TABLE signage_pairing_requests (
    id uuid PRIMARY KEY,
    code_digest bytea NOT NULL CHECK (octet_length(code_digest) = 32),
    poll_secret_digest bytea NOT NULL CHECK (octet_length(poll_secret_digest) = 32),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    claimed_display_id uuid REFERENCES signage_displays(id) ON DELETE CASCADE,
    claimed_at timestamptz,
    delivered_at timestamptz,
    CHECK (expires_at > created_at),
    CHECK ((claimed_display_id IS NULL) = (claimed_at IS NULL))
);
CREATE UNIQUE INDEX signage_pairing_requests_open_code_idx ON signage_pairing_requests (code_digest) WHERE claimed_at IS NULL;
CREATE UNIQUE INDEX signage_pairing_requests_poll_idx ON signage_pairing_requests (poll_secret_digest);
CREATE INDEX signage_pairing_requests_expires_idx ON signage_pairing_requests (expires_at);

CREATE TABLE signage_rules (
    id uuid PRIMARY KEY,
    display_id uuid NOT NULL REFERENCES signage_displays(id) ON DELETE CASCADE,
    position integer NOT NULL CHECK (position >= 0),
    enabled boolean NOT NULL DEFAULT true,
    condition_kind text NOT NULL CHECK (condition_kind IN ('time_window', 'machine_printing', 'announcement_active', 'live_data_unavailable')),
    weekdays smallint[] NOT NULL DEFAULT '{}' CHECK (weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]),
    time_from time,
    time_to time,
    machine_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(machine_ids) <= 20),
    machine_match text CHECK (machine_match IN ('any', 'all')),
    announcement_template_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(announcement_template_ids) <= 50),
    target_kind text NOT NULL CHECK (target_kind IN ('scene', 'playlist')),
    target_scene_id uuid REFERENCES signage_scenes(id) ON DELETE RESTRICT,
    target_playlist_id uuid REFERENCES signage_playlists(id) ON DELETE RESTRICT,
    min_seconds integer NOT NULL DEFAULT 20 CHECK (min_seconds BETWEEN 0 AND 600),
    multi_mode text NOT NULL DEFAULT 'split' CHECK (multi_mode IN ('split', 'alternate')),
    alternate_seconds integer NOT NULL DEFAULT 10 CHECK (alternate_seconds BETWEEN 3 AND 600),
    CONSTRAINT signage_rules_display_position_key UNIQUE (display_id, position) DEFERRABLE INITIALLY DEFERRED,
    CHECK ((target_kind = 'scene' AND target_scene_id IS NOT NULL AND target_playlist_id IS NULL)
        OR (target_kind = 'playlist' AND target_playlist_id IS NOT NULL AND target_scene_id IS NULL)),
    CHECK (condition_kind <> 'time_window' OR (cardinality(weekdays) BETWEEN 1 AND 7 AND time_from IS NOT NULL AND time_to IS NOT NULL
        AND cardinality(machine_ids) = 0 AND machine_match IS NULL AND cardinality(announcement_template_ids) = 0)),
    CHECK (condition_kind <> 'machine_printing' OR (cardinality(machine_ids) >= 1 AND machine_match IS NOT NULL
        AND cardinality(weekdays) = 0 AND time_from IS NULL AND time_to IS NULL AND cardinality(announcement_template_ids) = 0)),
    CHECK (condition_kind <> 'announcement_active' OR (cardinality(weekdays) = 0 AND time_from IS NULL AND time_to IS NULL
        AND cardinality(machine_ids) = 0 AND machine_match IS NULL)),
    CHECK (condition_kind <> 'live_data_unavailable' OR (cardinality(weekdays) = 0 AND time_from IS NULL AND time_to IS NULL
        AND cardinality(machine_ids) = 0 AND machine_match IS NULL AND cardinality(announcement_template_ids) = 0))
);
CREATE INDEX signage_rules_target_scene_idx ON signage_rules (target_scene_id) WHERE target_scene_id IS NOT NULL;
CREATE INDEX signage_rules_target_playlist_idx ON signage_rules (target_playlist_id) WHERE target_playlist_id IS NOT NULL;

CREATE TABLE signage_publications (
    id uuid PRIMARY KEY,
    display_id uuid NOT NULL REFERENCES signage_displays(id) ON DELETE CASCADE,
    revision integer NOT NULL CHECK (revision > 0),
    manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
    manifest_sha256 bytea NOT NULL CHECK (octet_length(manifest_sha256) = 32),
    published_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    published_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (display_id, revision)
);

CREATE TABLE signage_display_states (
    display_id uuid PRIMARY KEY REFERENCES signage_displays(id) ON DELETE CASCADE,
    last_heartbeat_at timestamptz NOT NULL,
    publication_revision integer CHECK (publication_revision IS NULL OR publication_revision > 0),
    current_rule text CHECK (current_rule IS NULL OR length(current_rule) <= 64),
    current_scene_id uuid,
    player_version text CHECK (player_version IS NULL OR length(player_version) <= 64),
    cache_used_bytes bigint CHECK (cache_used_bytes IS NULL OR cache_used_bytes >= 0),
    cache_quota_bytes bigint CHECK (cache_quota_bytes IS NULL OR cache_quota_bytes >= 0),
    errors jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(errors) = 'array' AND jsonb_array_length(errors) <= 20)
);

-- +goose Down
DROP TABLE signage_display_states;
DROP TABLE signage_publications;
DROP TABLE signage_rules;
DROP TABLE signage_pairing_requests;
DROP TABLE signage_announcement_displays;
DROP TABLE signage_displays;
DROP TABLE signage_announcement_values;
DROP TABLE signage_announcements;
DROP TABLE signage_announcement_template_fields;
DROP TABLE signage_announcement_templates;
DROP TABLE signage_playlist_items;
DROP TABLE signage_playlists;
DROP TABLE signage_scenes;
DROP TABLE signage_assets;
