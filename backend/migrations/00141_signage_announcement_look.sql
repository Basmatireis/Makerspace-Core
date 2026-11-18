-- +goose Up
-- Announcements get a look: a template sets the default colour (#rrggbb, null = the tone colour) and background
-- image; an announcement with own_look overrides both. An image is only a reference; deleting the asset clears it
-- (the application refuses the delete while a template or a live announcement with its own look uses it).
ALTER TABLE signage_announcement_templates
    ADD COLUMN color text NULL CONSTRAINT signage_announcement_templates_color_check CHECK (color ~ '^#[0-9a-f]{6}$'),
    ADD COLUMN image_asset_id uuid NULL REFERENCES signage_assets (id) ON DELETE SET NULL;
CREATE INDEX signage_announcement_templates_image_idx ON signage_announcement_templates (image_asset_id)
    WHERE image_asset_id IS NOT NULL;

ALTER TABLE signage_announcements
    ADD COLUMN own_look boolean NOT NULL DEFAULT false,
    ADD COLUMN color text NULL CONSTRAINT signage_announcements_color_check CHECK (color ~ '^#[0-9a-f]{6}$'),
    ADD COLUMN image_asset_id uuid NULL REFERENCES signage_assets (id) ON DELETE SET NULL,
    ADD CONSTRAINT signage_announcements_look_check CHECK (own_look OR (color IS NULL AND image_asset_id IS NULL));
CREATE INDEX signage_announcements_image_idx ON signage_announcements (image_asset_id)
    WHERE image_asset_id IS NOT NULL;

-- +goose Down
ALTER TABLE signage_announcements
    DROP COLUMN image_asset_id,
    DROP COLUMN color,
    DROP COLUMN own_look;
ALTER TABLE signage_announcement_templates
    DROP COLUMN image_asset_id,
    DROP COLUMN color;
