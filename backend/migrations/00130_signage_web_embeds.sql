-- +goose Up
-- A web embed is a signage display without a device: other websites show it in an iframe. It reuses the display's
-- rules, default scene list, group membership, publications and announcement targets, so it is a row of
-- signage_displays with kind 'web_embed' and no managed device, plus its embed settings in signage_web_embeds.
ALTER TABLE signage_displays ADD COLUMN kind text NOT NULL DEFAULT 'device';
ALTER TABLE signage_displays ADD CONSTRAINT signage_displays_kind_check CHECK (kind IN ('device', 'web_embed'));
ALTER TABLE signage_displays ALTER COLUMN managed_device_id DROP NOT NULL;
ALTER TABLE signage_displays
    ADD CONSTRAINT signage_displays_kind_device_check CHECK ((kind = 'device') = (managed_device_id IS NOT NULL));
-- A web embed only ever shows what a screen that is visible from outside may show; its cameras are switched per
-- embed in signage_web_embeds, never by allow_camera_outside.
ALTER TABLE signage_displays
    ADD CONSTRAINT signage_displays_web_embed_public_check
    CHECK (kind = 'device' OR (visible_from_outside AND NOT allow_camera_outside));
-- Lets signage_web_embeds reference only displays of kind web_embed.
ALTER TABLE signage_displays ADD CONSTRAINT signage_displays_id_kind_key UNIQUE (id, kind);

-- The embed key is a public identifier like a URL slug, not a secret: it ends up in the HTML of every website that
-- embeds the screen. It is therefore stored in plain text, so staff can copy the embed code at any time. Protection
-- comes from the allowed origins (frame-ancestors), the enabled switch and the per-embed camera and timelapse
-- switches; a new key ends every copy of the old one.
CREATE TABLE signage_web_embeds (
    display_id uuid PRIMARY KEY,
    display_kind text NOT NULL DEFAULT 'web_embed' CHECK (display_kind = 'web_embed'),
    embed_key text NOT NULL UNIQUE CHECK (embed_key ~ '^[A-Za-z0-9_-]{32}$'),
    allowed_origins text[] NOT NULL CHECK (cardinality(allowed_origins) BETWEEN 1 AND 20),
    open_directly boolean NOT NULL DEFAULT false,
    enabled boolean NOT NULL DEFAULT true,
    camera_enabled boolean NOT NULL DEFAULT false,
    camera_machine_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(camera_machine_ids) <= 20),
    camera_viewer_limit smallint NOT NULL DEFAULT 10 CHECK (camera_viewer_limit BETWEEN 1 AND 20),
    timelapse_enabled boolean NOT NULL DEFAULT false,
    timelapse_count smallint NOT NULL DEFAULT 5 CHECK (timelapse_count BETWEEN 1 AND 20),
    timelapse_max_age_days smallint NOT NULL DEFAULT 14 CHECK (timelapse_max_age_days BETWEEN 1 AND 90),
    -- Page loads (manifest requests without a known revision), counted per UTC day; not audited.
    last_loaded_at timestamptz,
    loads_day date,
    loads_count integer NOT NULL DEFAULT 0 CHECK (loads_count >= 0),
    FOREIGN KEY (display_id, display_kind) REFERENCES signage_displays (id, kind) ON DELETE CASCADE
);

-- +goose Down
-- Web embeds cannot exist without the kind column; their displays go with their rules, publications and targets.
DELETE FROM signage_displays WHERE kind = 'web_embed';
DROP TABLE signage_web_embeds;
ALTER TABLE signage_displays DROP CONSTRAINT signage_displays_id_kind_key;
ALTER TABLE signage_displays DROP CONSTRAINT signage_displays_web_embed_public_check;
ALTER TABLE signage_displays DROP CONSTRAINT signage_displays_kind_device_check;
ALTER TABLE signage_displays ALTER COLUMN managed_device_id SET NOT NULL;
ALTER TABLE signage_displays DROP CONSTRAINT signage_displays_kind_check;
ALTER TABLE signage_displays DROP COLUMN kind;
