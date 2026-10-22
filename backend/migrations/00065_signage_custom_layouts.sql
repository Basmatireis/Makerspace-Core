-- +goose Up
-- Digital signage: custom layouts (grid or free), font assets and rich announcement bodies.

CREATE TABLE signage_custom_layouts (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 100),
    mode text NOT NULL CHECK (mode IN ('grid', 'free')),
    -- Grid track weights in fr; free layouts store {1} / {1}.
    columns integer[] NOT NULL CHECK (cardinality(columns) BETWEEN 1 AND 12 AND 1 <= ALL (columns) AND 100 >= ALL (columns)),
    rows integer[] NOT NULL CHECK (cardinality(rows) BETWEEN 1 AND 12 AND 1 <= ALL (rows) AND 100 >= ALL (rows)),
    -- Ordered zones; the Go service validates ids, bounds and overlaps.
    zones jsonb NOT NULL CHECK (jsonb_typeof(zones) = 'array' AND jsonb_array_length(zones) BETWEEN 1 AND 12),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signage_custom_layouts_name_idx ON signage_custom_layouts (lower(name), id);

ALTER TABLE signage_scenes
    ADD COLUMN custom_layout_id uuid REFERENCES signage_custom_layouts(id) ON DELETE RESTRICT;
ALTER TABLE signage_scenes
    ADD CONSTRAINT signage_scenes_custom_layout_check CHECK ((layout_id = 'custom') = (custom_layout_id IS NOT NULL));
CREATE INDEX signage_scenes_custom_layout_idx ON signage_scenes (custom_layout_id) WHERE custom_layout_id IS NOT NULL;

-- Fonts are assets without dimensions or duration.
ALTER TABLE signage_assets DROP CONSTRAINT signage_assets_kind_check;
ALTER TABLE signage_assets ADD CONSTRAINT signage_assets_kind_check CHECK (kind IN ('image', 'video', 'font'));
ALTER TABLE signage_assets DROP CONSTRAINT signage_assets_check1;
ALTER TABLE signage_assets ADD CONSTRAINT signage_assets_dimensions_check CHECK (
    kind = 'video'
    OR (kind = 'image' AND width IS NOT NULL AND duration_ms IS NULL)
    OR (kind = 'font' AND width IS NULL AND duration_ms IS NULL)
);

ALTER TABLE signage_announcement_templates
    ADD COLUMN body_format text NOT NULL DEFAULT 'plain' CHECK (body_format IN ('plain', 'markdown', 'html')),
    ADD COLUMN body_css text NOT NULL DEFAULT '' CHECK (length(body_css) <= 20000);
ALTER TABLE signage_announcement_templates DROP CONSTRAINT signage_announcement_templates_body_check;
ALTER TABLE signage_announcement_templates
    ADD CONSTRAINT signage_announcement_templates_body_check CHECK (length(body) <= 5000);

-- +goose Down
ALTER TABLE signage_announcement_templates DROP CONSTRAINT signage_announcement_templates_body_check;
UPDATE signage_announcement_templates SET body = left(body, 2000) WHERE length(body) > 2000;
ALTER TABLE signage_announcement_templates
    ADD CONSTRAINT signage_announcement_templates_body_check CHECK (length(body) <= 2000);
ALTER TABLE signage_announcement_templates DROP COLUMN body_css, DROP COLUMN body_format;

-- The stored font bytes stay behind in the files table; only the asset rows go.
DELETE FROM signage_assets WHERE kind = 'font';
ALTER TABLE signage_assets DROP CONSTRAINT signage_assets_dimensions_check;
ALTER TABLE signage_assets ADD CONSTRAINT signage_assets_check1 CHECK (kind = 'video' OR (width IS NOT NULL AND duration_ms IS NULL));
ALTER TABLE signage_assets DROP CONSTRAINT signage_assets_kind_check;
ALTER TABLE signage_assets ADD CONSTRAINT signage_assets_kind_check CHECK (kind IN ('image', 'video'));

-- Scenes on a custom layout fall back to the full-screen layout with an empty widget.
UPDATE signage_scenes
SET layout_id = 'full', custom_layout_id = NULL, zones = '{"main": {"type": "empty"}}'::jsonb, version = version + 1
WHERE layout_id = 'custom';
DROP INDEX signage_scenes_custom_layout_idx;
ALTER TABLE signage_scenes DROP CONSTRAINT signage_scenes_custom_layout_check;
ALTER TABLE signage_scenes DROP COLUMN custom_layout_id;
DROP TABLE signage_custom_layouts;
