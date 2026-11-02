-- +goose Up
-- Digital signage: display groups. A group owns the rules and the default scene list of its member displays;
-- a display is in at most one group and then has no rules or default list of its own. Announcements may
-- target groups.

CREATE TABLE signage_display_groups (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 100),
    aspect_width smallint NOT NULL CHECK (aspect_width BETWEEN 1 AND 100),
    aspect_height smallint NOT NULL CHECK (aspect_height BETWEEN 1 AND 100),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signage_display_groups_name_idx ON signage_display_groups (lower(name), id);

ALTER TABLE signage_displays ADD COLUMN group_id uuid REFERENCES signage_display_groups(id) ON DELETE RESTRICT;
CREATE INDEX signage_displays_group_idx ON signage_displays (group_id) WHERE group_id IS NOT NULL;

ALTER TABLE signage_rules
    ALTER COLUMN display_id DROP NOT NULL,
    ADD COLUMN group_id uuid REFERENCES signage_display_groups(id) ON DELETE CASCADE,
    ADD CONSTRAINT signage_rules_owner_check CHECK (num_nonnulls(display_id, group_id) = 1),
    ADD CONSTRAINT signage_rules_group_position_key UNIQUE (group_id, position) DEFERRABLE INITIALLY DEFERRED;

-- The surrogate-free key: one position per owner; NULL owners never collide.
ALTER TABLE signage_default_scenes
    DROP CONSTRAINT signage_default_scenes_pkey,
    ALTER COLUMN display_id DROP NOT NULL,
    ADD COLUMN group_id uuid REFERENCES signage_display_groups(id) ON DELETE CASCADE,
    ADD CONSTRAINT signage_default_scenes_owner_check CHECK (num_nonnulls(display_id, group_id) = 1),
    ADD CONSTRAINT signage_default_scenes_display_position_key UNIQUE (display_id, position),
    ADD CONSTRAINT signage_default_scenes_group_position_key UNIQUE (group_id, position);

CREATE TABLE signage_announcement_groups (
    announcement_id uuid NOT NULL REFERENCES signage_announcements(id) ON DELETE CASCADE,
    group_id uuid NOT NULL REFERENCES signage_display_groups(id) ON DELETE CASCADE,
    PRIMARY KEY (announcement_id, group_id)
);
CREATE INDEX signage_announcement_groups_group_idx ON signage_announcement_groups (group_id);

-- +goose Down
-- Groups are dropped. Member displays get a copy of their group's rules and default list first (as when a
-- display leaves its group) and announcements that targeted a group target its members instead; everything
-- else that belonged to a group (its name, ratio, and the content of groups without members) is lost.
CREATE TEMPORARY TABLE signage_group_rule_copies ON COMMIT DROP AS
SELECT r.id AS old_id, uuidv7() AS new_id, d.id AS display_id
FROM signage_rules r JOIN signage_displays d ON d.group_id = r.group_id;

INSERT INTO signage_rules (id, display_id, position, enabled, condition_kind, weekdays, time_from, time_to, machine_ids,
                           machine_match, announcement_template_ids, min_seconds, multi_mode, alternate_seconds)
SELECT c.new_id, c.display_id, r.position, r.enabled, r.condition_kind, r.weekdays, r.time_from, r.time_to, r.machine_ids,
       r.machine_match, r.announcement_template_ids, r.min_seconds, r.multi_mode, r.alternate_seconds
FROM signage_group_rule_copies c JOIN signage_rules r ON r.id = c.old_id;
INSERT INTO signage_rule_scenes (rule_id, position, scene_id, seconds, transition)
SELECT c.new_id, rs.position, rs.scene_id, rs.seconds, rs.transition
FROM signage_group_rule_copies c JOIN signage_rule_scenes rs ON rs.rule_id = c.old_id;

INSERT INTO signage_default_scenes (display_id, position, scene_id, seconds, transition)
SELECT d.id, ds.position, ds.scene_id, ds.seconds, ds.transition
FROM signage_displays d JOIN signage_default_scenes ds ON ds.group_id = d.group_id;

INSERT INTO signage_announcement_displays (announcement_id, display_id)
SELECT ag.announcement_id, d.id
FROM signage_announcement_groups ag JOIN signage_displays d ON d.group_id = ag.group_id
ON CONFLICT DO NOTHING;

DROP TABLE signage_announcement_groups;

DELETE FROM signage_default_scenes WHERE group_id IS NOT NULL;
ALTER TABLE signage_default_scenes
    DROP CONSTRAINT signage_default_scenes_group_position_key,
    DROP CONSTRAINT signage_default_scenes_display_position_key,
    DROP CONSTRAINT signage_default_scenes_owner_check,
    DROP COLUMN group_id,
    ALTER COLUMN display_id SET NOT NULL,
    ADD CONSTRAINT signage_default_scenes_pkey PRIMARY KEY (display_id, position);

DELETE FROM signage_rules WHERE group_id IS NOT NULL;
ALTER TABLE signage_rules
    DROP CONSTRAINT signage_rules_group_position_key,
    DROP CONSTRAINT signage_rules_owner_check,
    DROP COLUMN group_id,
    ALTER COLUMN display_id SET NOT NULL;

DROP INDEX signage_displays_group_idx;
ALTER TABLE signage_displays DROP COLUMN group_id;
DROP TABLE signage_display_groups;
