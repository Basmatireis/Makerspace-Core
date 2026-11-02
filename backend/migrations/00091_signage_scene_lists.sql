-- +goose Up
-- Digital signage: rules and the display default show an ordered scene list instead of a scene or a playlist;
-- playlists are removed.

CREATE TABLE signage_rule_scenes (
    rule_id uuid NOT NULL REFERENCES signage_rules(id) ON DELETE CASCADE,
    position integer NOT NULL CHECK (position BETWEEN 0 AND 99),
    scene_id uuid NOT NULL REFERENCES signage_scenes(id) ON DELETE RESTRICT,
    seconds integer NOT NULL CHECK (seconds BETWEEN 3 AND 3600),
    transition text NOT NULL CHECK (transition IN ('cut', 'fade')),
    PRIMARY KEY (rule_id, position)
);
CREATE INDEX signage_rule_scenes_scene_idx ON signage_rule_scenes (scene_id);

-- Display groups (a later migration) add a group owner next to display_id.
CREATE TABLE signage_default_scenes (
    display_id uuid NOT NULL REFERENCES signage_displays(id) ON DELETE CASCADE,
    position integer NOT NULL CHECK (position BETWEEN 0 AND 99),
    scene_id uuid NOT NULL REFERENCES signage_scenes(id) ON DELETE RESTRICT,
    seconds integer NOT NULL CHECK (seconds BETWEEN 3 AND 3600),
    transition text NOT NULL CHECK (transition IN ('cut', 'fade')),
    PRIMARY KEY (display_id, position)
);
CREATE INDEX signage_default_scenes_scene_idx ON signage_default_scenes (scene_id);

-- A rule that showed a scene shows a one-item list; a rule that showed a playlist shows the playlist's items.
INSERT INTO signage_rule_scenes (rule_id, position, scene_id, seconds, transition)
SELECT id, 0, target_scene_id, 10, 'cut' FROM signage_rules WHERE target_kind = 'scene';
INSERT INTO signage_rule_scenes (rule_id, position, scene_id, seconds, transition)
SELECT r.id, (row_number() OVER (PARTITION BY r.id ORDER BY i.position) - 1)::integer, i.scene_id, i.seconds, i.transition
FROM signage_rules r JOIN signage_playlist_items i ON i.playlist_id = r.target_playlist_id
WHERE r.target_kind = 'playlist';
-- A rule whose playlist was empty showed nothing; later rules of its display close the position gap
-- (the position key is deferred, so the renumbering may pass through duplicates).
DELETE FROM signage_rules r
WHERE r.target_kind = 'playlist'
  AND NOT EXISTS (SELECT 1 FROM signage_playlist_items i WHERE i.playlist_id = r.target_playlist_id);
UPDATE signage_rules r SET position = ordered.position
FROM (
    SELECT id, (row_number() OVER (PARTITION BY display_id ORDER BY position) - 1)::integer AS position
    FROM signage_rules
) ordered
WHERE ordered.id = r.id AND r.position <> ordered.position;

-- A display's default playlist becomes its default list.
INSERT INTO signage_default_scenes (display_id, position, scene_id, seconds, transition)
SELECT d.id, (row_number() OVER (PARTITION BY d.id ORDER BY i.position) - 1)::integer, i.scene_id, i.seconds, i.transition
FROM signage_displays d JOIN signage_playlist_items i ON i.playlist_id = d.default_playlist_id;
-- A display whose default playlist was empty shows a black scene named Blank, created once per aspect ratio
-- that needs one. PostgreSQL 18's uuidv7() gives these migration-created rows the same id version the
-- application generates.
WITH needed AS (
    SELECT DISTINCT d.aspect_width, d.aspect_height FROM signage_displays d
    WHERE NOT EXISTS (SELECT 1 FROM signage_default_scenes s WHERE s.display_id = d.id)
), blank AS (
    INSERT INTO signage_scenes (id, name, aspect_width, aspect_height, layout_id, background_color, theme, zones)
    SELECT uuidv7(), 'Blank', aspect_width, aspect_height, 'full', '#000000', 'dark', '{"main": {"type": "empty"}}'::jsonb
    FROM needed
    RETURNING id, aspect_width, aspect_height
)
INSERT INTO signage_default_scenes (display_id, position, scene_id, seconds, transition)
SELECT d.id, 0, b.id, 10, 'cut'
FROM signage_displays d JOIN blank b ON b.aspect_width = d.aspect_width AND b.aspect_height = d.aspect_height
WHERE NOT EXISTS (SELECT 1 FROM signage_default_scenes s WHERE s.display_id = d.id);

-- Dropping the target columns drops their CHECK constraints, foreign keys and indexes with them.
ALTER TABLE signage_rules
    DROP COLUMN target_kind,
    DROP COLUMN target_scene_id,
    DROP COLUMN target_playlist_id;
ALTER TABLE signage_displays DROP COLUMN default_playlist_id;
DROP TABLE signage_playlist_items;
DROP TABLE signage_playlists;

-- +goose Down
-- Rebuilds one playlist per scene list: "Default of <display>" for each default list (with the display's id)
-- and "Rule <n> of <display>" for each rule list (with the rule's id). Blank scenes created on the way up stay.
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

INSERT INTO signage_playlists (id, name)
SELECT id, btrim(left('Default of ' || name, 100)) FROM signage_displays;
INSERT INTO signage_playlist_items (playlist_id, position, scene_id, seconds, transition)
SELECT display_id, position, scene_id, seconds, transition FROM signage_default_scenes;
ALTER TABLE signage_displays ADD COLUMN default_playlist_id uuid REFERENCES signage_playlists(id) ON DELETE RESTRICT;
UPDATE signage_displays SET default_playlist_id = id;
ALTER TABLE signage_displays ALTER COLUMN default_playlist_id SET NOT NULL;
CREATE INDEX signage_displays_default_playlist_idx ON signage_displays (default_playlist_id);

INSERT INTO signage_playlists (id, name)
SELECT r.id, btrim(left('Rule ' || (r.position + 1) || ' of ' || d.name, 100))
FROM signage_rules r JOIN signage_displays d ON d.id = r.display_id;
INSERT INTO signage_playlist_items (playlist_id, position, scene_id, seconds, transition)
SELECT rule_id, position, scene_id, seconds, transition FROM signage_rule_scenes;
ALTER TABLE signage_rules
    ADD COLUMN target_kind text,
    ADD COLUMN target_scene_id uuid REFERENCES signage_scenes(id) ON DELETE RESTRICT,
    ADD COLUMN target_playlist_id uuid REFERENCES signage_playlists(id) ON DELETE RESTRICT;
UPDATE signage_rules SET target_kind = 'playlist', target_playlist_id = id;
ALTER TABLE signage_rules
    ALTER COLUMN target_kind SET NOT NULL,
    ADD CONSTRAINT signage_rules_target_kind_check CHECK (target_kind IN ('scene', 'playlist')),
    ADD CONSTRAINT signage_rules_check CHECK ((target_kind = 'scene' AND target_scene_id IS NOT NULL AND target_playlist_id IS NULL)
        OR (target_kind = 'playlist' AND target_playlist_id IS NOT NULL AND target_scene_id IS NULL));
CREATE INDEX signage_rules_target_scene_idx ON signage_rules (target_scene_id) WHERE target_scene_id IS NOT NULL;
CREATE INDEX signage_rules_target_playlist_idx ON signage_rules (target_playlist_id) WHERE target_playlist_id IS NOT NULL;

DROP TABLE signage_default_scenes;
DROP TABLE signage_rule_scenes;
