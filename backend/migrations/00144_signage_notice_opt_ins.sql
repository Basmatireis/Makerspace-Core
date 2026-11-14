-- +goose Up
-- Signage displays and display groups choose which notification rules' notices they show, instead of each rule
-- naming its displays. A display shows a rule's notice when the display or its group opted in to the rule or to all
-- signage notices. Notices are stored once per delivery and matched to displays when the player asks, so a display
-- that joins a group picks up the group's notices at once.
ALTER TABLE signage_displays ADD COLUMN all_rule_notices boolean NOT NULL DEFAULT false;
ALTER TABLE signage_display_groups ADD COLUMN all_rule_notices boolean NOT NULL DEFAULT false;

CREATE TABLE signage_notice_opt_ins (
    id uuid PRIMARY KEY,
    rule_id uuid NOT NULL REFERENCES notification_rules(id) ON DELETE CASCADE,
    display_id uuid REFERENCES signage_displays(id) ON DELETE CASCADE,
    group_id uuid REFERENCES signage_display_groups(id) ON DELETE CASCADE,
    CHECK (num_nonnulls(display_id, group_id) = 1),
    UNIQUE (display_id, rule_id),
    UNIQUE (group_id, rule_id)
);
CREATE INDEX signage_notice_opt_ins_rule_idx ON signage_notice_opt_ins (rule_id);

-- Today's displayIds become opt-ins of the displays (that still exist and are real screens), then leave the rules.
INSERT INTO signage_notice_opt_ins (id, rule_id, display_id)
SELECT uuidv7(), picked.rule_id, picked.display_id
FROM (
    SELECT DISTINCT r.id AS rule_id, (display.value #>> '{}')::uuid AS display_id
    FROM notification_rules r
    CROSS JOIN LATERAL (
        SELECT a.value FROM jsonb_array_elements(COALESCE(r.definition -> 'actions', '[]'::jsonb)) a
        UNION ALL
        SELECT s.value -> 'action' FROM jsonb_array_elements(COALESCE(r.definition #> '{escalation,steps}', '[]'::jsonb)) s
    ) action
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(action.value #> '{signage,displayIds}', '[]'::jsonb)) display
    WHERE action.value ->> 'channel' = 'signage'
) picked
JOIN signage_displays d ON d.id = picked.display_id AND d.kind = 'device';

-- +goose StatementBegin
CREATE FUNCTION pg_temp.strip_signage_displays(action jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN action ? 'signage' AND jsonb_typeof(action -> 'signage') = 'object'
                THEN jsonb_set(action, '{signage}', (action -> 'signage') - 'displayIds')
                ELSE action END
$$;
-- +goose StatementEnd

UPDATE notification_rules r SET definition = jsonb_set(r.definition, '{actions}', (
    SELECT COALESCE(jsonb_agg(pg_temp.strip_signage_displays(a.value) ORDER BY a.ordinality), '[]'::jsonb)
    FROM jsonb_array_elements(r.definition -> 'actions') WITH ORDINALITY a))
WHERE jsonb_typeof(r.definition -> 'actions') = 'array';

UPDATE notification_rules r SET definition = jsonb_set(r.definition, '{escalation,steps}', (
    SELECT COALESCE(jsonb_agg(CASE WHEN s.value ? 'action'
                                   THEN jsonb_set(s.value, '{action}', pg_temp.strip_signage_displays(s.value -> 'action'))
                                   ELSE s.value END ORDER BY s.ordinality), '[]'::jsonb)
    FROM jsonb_array_elements(r.definition #> '{escalation,steps}') WITH ORDINALITY s))
WHERE jsonb_typeof(r.definition #> '{escalation,steps}') = 'array';

-- A notice now belongs to its rule rather than to one display. One delivery wrote one row per display; keep one of
-- them. Rows whose firing is gone can no longer be matched to a rule and go; their notices ended long ago (a notice is
-- in force for a day at most, a firing is kept far longer).
ALTER TABLE signage_rule_notices ADD COLUMN rule_id uuid REFERENCES notification_rules(id) ON DELETE CASCADE;
UPDATE signage_rule_notices n SET rule_id = f.rule_id FROM notification_firings f WHERE f.id = n.firing_id;
DELETE FROM signage_rule_notices WHERE rule_id IS NULL;
DELETE FROM signage_rule_notices n USING signage_rule_notices keep
WHERE keep.firing_id = n.firing_id AND keep.title = n.title AND keep.body = n.body AND keep.tone = n.tone
  AND keep.starts_at = n.starts_at AND keep.ends_at = n.ends_at AND keep.id < n.id;
DROP INDEX signage_rule_notices_display_idx;
-- The table holds short notices that the delivery retention clears, and only this code read display_id, so the scan is
-- short and no client breaks.
-- squawk-ignore ban-drop-column, adding-not-nullable-field
ALTER TABLE signage_rule_notices DROP COLUMN display_id, ALTER COLUMN rule_id SET NOT NULL;
CREATE INDEX signage_rule_notices_rule_idx ON signage_rule_notices (rule_id, ends_at);

-- +goose Down
-- A notice is in force for a day at most; the per-display rows of the old shape are not rebuilt.
DELETE FROM signage_rule_notices;
DROP INDEX signage_rule_notices_rule_idx;
ALTER TABLE signage_rule_notices
    DROP COLUMN rule_id,
    ADD COLUMN display_id uuid NOT NULL REFERENCES signage_displays(id) ON DELETE CASCADE;
CREATE INDEX signage_rule_notices_display_idx ON signage_rule_notices (display_id, ends_at);

-- Each signage action gets back the displays that show the rule's notices: the display's own opt-ins, the members of
-- opted-in groups and, for "all signage notices", every screen in scope, at most 20 (the old limit; further displays
-- are dropped). A rule that no display shows gets an empty list, which the old validator refuses on the rule's next
-- edit until displays are chosen again.
-- +goose StatementBegin
CREATE FUNCTION pg_temp.with_signage_displays(action jsonb, displays jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN action ->> 'channel' = 'signage' AND jsonb_typeof(action -> 'signage') = 'object'
                THEN jsonb_set(action, '{signage,displayIds}', displays)
                ELSE action END
$$;
-- +goose StatementEnd

WITH shown AS (
    SELECT r.id AS rule_id, COALESCE((
        SELECT jsonb_agg(to_jsonb(d.id::text) ORDER BY d.id) FROM (
            SELECT d.id FROM signage_displays d
            WHERE d.kind = 'device' AND (
                d.all_rule_notices
                OR EXISTS (SELECT 1 FROM signage_notice_opt_ins o WHERE o.rule_id = r.id AND o.display_id = d.id)
                OR EXISTS (SELECT 1 FROM signage_display_groups g WHERE g.id = d.group_id AND (g.all_rule_notices
                    OR EXISTS (SELECT 1 FROM signage_notice_opt_ins o WHERE o.rule_id = r.id AND o.group_id = g.id))))
            ORDER BY d.id LIMIT 20) d), '[]'::jsonb) AS displays
    FROM notification_rules r
)
UPDATE notification_rules r SET definition = jsonb_set(
    CASE WHEN jsonb_typeof(r.definition #> '{escalation,steps}') = 'array'
         THEN jsonb_set(r.definition, '{escalation,steps}', (
             SELECT COALESCE(jsonb_agg(CASE WHEN s.value ? 'action'
                                            THEN jsonb_set(s.value, '{action}', pg_temp.with_signage_displays(s.value -> 'action', shown.displays))
                                            ELSE s.value END ORDER BY s.ordinality), '[]'::jsonb)
             FROM jsonb_array_elements(r.definition #> '{escalation,steps}') WITH ORDINALITY s))
         ELSE r.definition END,
    '{actions}', (
        SELECT COALESCE(jsonb_agg(pg_temp.with_signage_displays(a.value, shown.displays) ORDER BY a.ordinality), '[]'::jsonb)
        FROM jsonb_array_elements(r.definition -> 'actions') WITH ORDINALITY a))
FROM shown
WHERE shown.rule_id = r.id AND jsonb_typeof(r.definition -> 'actions') = 'array';

DROP TABLE signage_notice_opt_ins;
ALTER TABLE signage_display_groups DROP COLUMN all_rule_notices;
ALTER TABLE signage_displays DROP COLUMN all_rule_notices;
