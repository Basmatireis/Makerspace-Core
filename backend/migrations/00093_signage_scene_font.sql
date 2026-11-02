-- +goose Up
-- Digital signage: a scene has a font family; widgets whose font family is "inherit" use it.
ALTER TABLE signage_scenes
    ADD COLUMN font_family text NOT NULL DEFAULT 'sans' CHECK (font_family IN ('sans', 'serif', 'mono', 'custom')),
    ADD COLUMN font_asset_id uuid NULL REFERENCES signage_assets (id) ON DELETE RESTRICT,
    ADD CONSTRAINT signage_scenes_font_check CHECK ((font_family = 'custom') = (font_asset_id IS NOT NULL));
CREATE INDEX signage_scenes_font_asset_idx ON signage_scenes (font_asset_id) WHERE font_asset_id IS NOT NULL;

-- +goose Down
DROP INDEX signage_scenes_font_asset_idx;
ALTER TABLE signage_scenes
    DROP CONSTRAINT signage_scenes_font_check,
    DROP COLUMN font_asset_id,
    DROP COLUMN font_family;
