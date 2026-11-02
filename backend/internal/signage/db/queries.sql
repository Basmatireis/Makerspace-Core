-- Assets ------------------------------------------------------------------------------------------------------

-- name: CreateSignageAsset :one
INSERT INTO signage_assets (id, file_id, kind, name, width, height, duration_ms, created_by_account_id)
VALUES (sqlc.arg(id), sqlc.arg(file_id), sqlc.arg(kind), sqlc.arg(name), sqlc.narg(width), sqlc.narg(height), sqlc.narg(duration_ms), sqlc.narg(created_by_account_id))
RETURNING id;

-- name: GetSignageAsset :one
SELECT a.id, a.file_id, a.kind, a.name, a.width, a.height, a.duration_ms, a.created_by_account_id, a.created_at,
       f.content_type, f.size_bytes, f.sha256,
       COALESCE(NULLIF(btrim(COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, '')), ''), '')::text AS created_by_name
FROM signage_assets a JOIN files f ON f.id = a.file_id
LEFT JOIN accounts acc ON acc.id = a.created_by_account_id
LEFT JOIN people p ON p.id = acc.person_id
WHERE a.id = sqlc.arg(id);

-- name: GetSignageAssetForUpdate :one
SELECT id, file_id, kind, name FROM signage_assets WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: ListSignageAssets :many
SELECT a.id, a.file_id, a.kind, a.name, a.width, a.height, a.duration_ms, a.created_by_account_id, a.created_at,
       f.content_type, f.size_bytes, f.sha256,
       COALESCE(NULLIF(btrim(COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, '')), ''), '')::text AS created_by_name
FROM signage_assets a JOIN files f ON f.id = a.file_id
LEFT JOIN accounts acc ON acc.id = a.created_by_account_id
LEFT JOIN people p ON p.id = acc.person_id
WHERE (sqlc.narg(kind)::text IS NULL OR a.kind = sqlc.narg(kind)::text)
ORDER BY a.created_at DESC, a.id DESC;

-- name: RenameSignageAsset :execrows
UPDATE signage_assets SET name = sqlc.arg(name) WHERE id = sqlc.arg(id);

-- name: DeleteSignageAsset :one
DELETE FROM signage_assets WHERE id = sqlc.arg(id) RETURNING file_id;

-- name: ListSignageMachines :many
SELECT m.id, m.name, mt.name AS kind
FROM machines m JOIN processes mt ON mt.id = m.process_id
ORDER BY lower(m.name), m.id;

-- name: ListSignageCameraMachineIDs :many
-- Machines whose active, enabled printer-connector assignment relays the printer camera.
SELECT a.machine_id FROM printer_connector_assignments a
WHERE a.camera_streaming AND a.enabled AND a.ended_at IS NULL;

-- name: ListSignageStreamingCameras :many
-- Cameras the relay can serve right now: the active, enabled assignment switches the camera on, belongs to an
-- active connector, and the printer profile is enabled (the connector's configuration carries the camera only then).
SELECT a.machine_id, a.id AS assignment_id, a.connector_id
FROM printer_connector_assignments a
JOIN printer_connectors c ON c.id = a.connector_id
JOIN printer_profiles p ON p.machine_id = a.machine_id
JOIN machines m ON m.id = a.machine_id
WHERE a.camera_streaming AND a.enabled AND p.enabled AND a.ended_at IS NULL AND c.lifecycle = 'active'
ORDER BY lower(m.name), a.machine_id;

-- name: GetSignageStreamingCamera :one
-- The camera of one machine under the same conditions as ListSignageStreamingCameras.
SELECT a.machine_id, a.id AS assignment_id, a.connector_id
FROM printer_connector_assignments a
JOIN printer_connectors c ON c.id = a.connector_id
JOIN printer_profiles p ON p.machine_id = a.machine_id
WHERE a.machine_id = sqlc.arg(machine_id) AND a.camera_streaming AND a.enabled AND p.enabled AND a.ended_at IS NULL
  AND c.lifecycle = 'active';

-- name: ListSignageHiddenMachineIDs :many
-- Machines whose currently running run was opted out of signage by its operator or customer. A manual run
-- is running until its planned end; a recorded run while its state says so.
SELECT DISTINCT r.machine_id FROM machine_runs r
WHERE r.hidden_from_signage AND r.deleted_at IS NULL
  AND CASE WHEN r.source = 'manual'
           THEN COALESCE(r.state, CASE WHEN r.ended_at > sqlc.arg(now)::timestamptz THEN 'running' ELSE 'finished' END)
           ELSE r.state END = 'running';

-- name: ListSignageAssetKinds :many
SELECT id, kind FROM signage_assets WHERE id = ANY(sqlc.arg(ids)::text[]::uuid[]) FOR SHARE;

-- name: ListScenesReferencingAsset :many
SELECT id, name FROM signage_scenes
WHERE background_asset_id = sqlc.arg(id)::uuid OR position((sqlc.arg(id)::uuid)::text in zones::text) > 0
ORDER BY lower(name), id;

-- Scenes ------------------------------------------------------------------------------------------------------

-- name: CreateSignageScene :one
INSERT INTO signage_scenes (id, name, aspect_width, aspect_height, layout_id, custom_layout_id, background_color, background_asset_id, background_fit, background_dim, theme, zones)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(aspect_width), sqlc.arg(aspect_height), sqlc.arg(layout_id), sqlc.narg(custom_layout_id), sqlc.arg(background_color), sqlc.narg(background_asset_id),
        sqlc.arg(background_fit), sqlc.arg(background_dim), sqlc.arg(theme), sqlc.arg(zones)::text::jsonb)
RETURNING *;

-- name: GetSignageScene :one
SELECT * FROM signage_scenes WHERE id = sqlc.arg(id);

-- name: GetSignageSceneForUpdate :one
SELECT * FROM signage_scenes WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: ListSignageScenes :many
SELECT * FROM signage_scenes ORDER BY lower(name), id;

-- name: UpdateSignageScene :one
UPDATE signage_scenes
SET name = sqlc.arg(name), aspect_width = sqlc.arg(aspect_width), aspect_height = sqlc.arg(aspect_height), layout_id = sqlc.arg(layout_id), custom_layout_id = sqlc.narg(custom_layout_id),
    background_color = sqlc.arg(background_color),
    background_asset_id = sqlc.narg(background_asset_id), background_fit = sqlc.arg(background_fit), background_dim = sqlc.arg(background_dim),
    theme = sqlc.arg(theme), zones = sqlc.arg(zones)::text::jsonb, version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: SetSignageSceneZones :exec
-- Rewrites the widgets of a scene whose custom layout changed its zones.
UPDATE signage_scenes SET zones = sqlc.arg(zones)::text::jsonb, version = version + 1, updated_at = now() WHERE id = sqlc.arg(id);

-- name: DeleteSignageScene :one
DELETE FROM signage_scenes WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING id;

-- name: ListSignageSceneIDs :many
SELECT id FROM signage_scenes WHERE id = ANY(sqlc.arg(ids)::text[]::uuid[]);

-- name: ListRulesReferencingScene :many
-- Rules of displays and of groups whose scene list shows the scene; owner_id is the display's or the group's.
SELECT r.id AS rule_id, r.position, COALESCE(r.display_id, r.group_id)::uuid AS owner_id, (r.group_id IS NOT NULL)::boolean AS group_owned,
       COALESCE(d.name, g.name)::text AS owner_name
FROM signage_rules r LEFT JOIN signage_displays d ON d.id = r.display_id LEFT JOIN signage_display_groups g ON g.id = r.group_id
WHERE EXISTS (SELECT 1 FROM signage_rule_scenes rs WHERE rs.rule_id = r.id AND rs.scene_id = sqlc.arg(scene_id))
ORDER BY 4, 5, 3, r.position;

-- name: ListDisplaysWithDefaultScene :many
SELECT d.id, d.name FROM signage_displays d
WHERE EXISTS (SELECT 1 FROM signage_default_scenes ds WHERE ds.display_id = d.id AND ds.scene_id = sqlc.arg(scene_id))
ORDER BY d.name, d.id;

-- name: ListGroupsWithDefaultScene :many
SELECT g.id, g.name FROM signage_display_groups g
WHERE EXISTS (SELECT 1 FROM signage_default_scenes ds WHERE ds.group_id = g.id AND ds.scene_id = sqlc.arg(scene_id))
ORDER BY g.name, g.id;

-- Custom layouts ----------------------------------------------------------------------------------------------

-- name: CreateSignageCustomLayout :one
INSERT INTO signage_custom_layouts (id, name, mode, columns, rows, zones)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(mode), sqlc.arg(columns)::int[], sqlc.arg(rows)::int[], sqlc.arg(zones)::text::jsonb)
RETURNING *;

-- name: GetSignageCustomLayout :one
SELECT * FROM signage_custom_layouts WHERE id = sqlc.arg(id);

-- name: GetSignageCustomLayoutForUpdate :one
SELECT * FROM signage_custom_layouts WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: GetSignageCustomLayoutForShare :one
-- Scene writes share-lock the layout so that a concurrent layout update or deletion waits for them.
SELECT * FROM signage_custom_layouts WHERE id = sqlc.arg(id) FOR SHARE;

-- name: ListSignageCustomLayouts :many
SELECT l.id, l.name, l.mode, l.columns, l.rows, l.zones, l.version, l.created_at, l.updated_at,
       (SELECT count(*) FROM signage_scenes s WHERE s.custom_layout_id = l.id)::int AS scene_count
FROM signage_custom_layouts l ORDER BY lower(l.name), l.id;

-- name: CountScenesUsingCustomLayout :one
SELECT count(*)::int FROM signage_scenes WHERE custom_layout_id = sqlc.arg(id)::uuid;

-- name: ListSignageCustomLayoutsByIDs :many
SELECT * FROM signage_custom_layouts WHERE id = ANY(sqlc.arg(ids)::text[]::uuid[]) ORDER BY id;

-- name: UpdateSignageCustomLayout :one
UPDATE signage_custom_layouts
SET name = sqlc.arg(name), mode = sqlc.arg(mode), columns = sqlc.arg(columns)::int[], rows = sqlc.arg(rows)::int[],
    zones = sqlc.arg(zones)::text::jsonb, version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: DeleteSignageCustomLayout :one
DELETE FROM signage_custom_layouts WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING id;

-- name: ListScenesUsingCustomLayoutForUpdate :many
-- Locks every scene that uses the layout (in id order) before the layout zones change.
SELECT id, name, zones FROM signage_scenes WHERE custom_layout_id = sqlc.arg(id)::uuid ORDER BY id FOR UPDATE;

-- Announcement templates --------------------------------------------------------------------------------------

-- name: CreateSignageTemplate :one
INSERT INTO signage_announcement_templates (id, name, tone, title, body, body_format, body_css)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(tone), sqlc.arg(title), sqlc.arg(body), sqlc.arg(body_format), sqlc.arg(body_css)) RETURNING *;

-- name: GetSignageTemplate :one
SELECT * FROM signage_announcement_templates WHERE id = sqlc.arg(id);

-- name: GetSignageTemplateForUpdate :one
SELECT * FROM signage_announcement_templates WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: ListSignageTemplates :many
SELECT * FROM signage_announcement_templates ORDER BY lower(name), id;

-- name: UpdateSignageTemplate :one
UPDATE signage_announcement_templates
SET name = sqlc.arg(name), tone = sqlc.arg(tone), title = sqlc.arg(title), body = sqlc.arg(body), body_format = sqlc.arg(body_format),
    body_css = sqlc.arg(body_css), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING *;

-- name: DeleteSignageTemplate :one
DELETE FROM signage_announcement_templates WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING id;

-- name: InsertSignageTemplateField :exec
INSERT INTO signage_announcement_template_fields (template_id, position, key, label, type, required, default_value, helper_text, options)
VALUES (sqlc.arg(template_id), sqlc.arg(position), sqlc.arg(key), sqlc.arg(label), sqlc.arg(type), sqlc.arg(required),
        sqlc.arg(default_value), sqlc.arg(helper_text), sqlc.arg(options)::text[]);

-- name: DeleteSignageTemplateFields :exec
DELETE FROM signage_announcement_template_fields WHERE template_id = sqlc.arg(template_id);

-- name: ListSignageTemplateFields :many
SELECT * FROM signage_announcement_template_fields WHERE template_id = ANY(sqlc.arg(template_ids)::text[]::uuid[]) ORDER BY template_id, position;

-- name: DeleteSignageAnnouncementValuesNotIn :exec
DELETE FROM signage_announcement_values v USING signage_announcements a
WHERE v.announcement_id = a.id AND a.template_id = sqlc.arg(template_id) AND NOT (v.key = ANY(sqlc.arg(keys)::text[]));

-- name: ListAnnouncementsUsingTemplate :many
SELECT id FROM signage_announcements WHERE template_id = sqlc.arg(template_id) AND (ends_at IS NULL OR ends_at > sqlc.arg(now)::timestamptz) ORDER BY starts_at, id;

-- name: DeleteEndedAnnouncementsOfTemplate :exec
DELETE FROM signage_announcements WHERE template_id = sqlc.arg(template_id) AND ends_at IS NOT NULL AND ends_at <= sqlc.arg(now)::timestamptz;

-- name: ListRulesFilteringTemplate :many
SELECT r.id AS rule_id, r.position, COALESCE(r.display_id, r.group_id)::uuid AS owner_id, (r.group_id IS NOT NULL)::boolean AS group_owned,
       COALESCE(d.name, g.name)::text AS owner_name
FROM signage_rules r LEFT JOIN signage_displays d ON d.id = r.display_id LEFT JOIN signage_display_groups g ON g.id = r.group_id
WHERE r.announcement_template_ids @> ARRAY[sqlc.arg(template_id)::uuid] ORDER BY 4, 5, r.position;

-- name: ListSignageTemplateIDsForShare :many
SELECT id FROM signage_announcement_templates WHERE id = ANY(sqlc.arg(ids)::text[]::uuid[]) FOR SHARE;

-- name: ListScenesReferencingTemplate :many
SELECT id, name FROM signage_scenes WHERE position((sqlc.arg(template_id)::uuid)::text in zones::text) > 0 ORDER BY lower(name), id;

-- Announcements -----------------------------------------------------------------------------------------------

-- name: CreateSignageAnnouncement :one
INSERT INTO signage_announcements (id, template_id, all_displays, starts_at, ends_at, created_by_account_id)
VALUES (sqlc.arg(id), sqlc.arg(template_id), sqlc.arg(all_displays), sqlc.arg(starts_at), sqlc.narg(ends_at), sqlc.narg(created_by_account_id))
RETURNING *;

-- name: GetSignageAnnouncement :one
SELECT * FROM signage_announcements WHERE id = sqlc.arg(id);

-- name: GetSignageAnnouncementForUpdate :one
SELECT * FROM signage_announcements WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: ListLiveSignageAnnouncements :many
SELECT * FROM signage_announcements WHERE ends_at IS NULL OR ends_at > sqlc.arg(now)::timestamptz ORDER BY starts_at, id;

-- name: UpdateSignageAnnouncement :one
UPDATE signage_announcements
SET all_displays = sqlc.arg(all_displays), starts_at = sqlc.arg(starts_at), ends_at = sqlc.narg(ends_at), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING *;

-- name: DeleteSignageAnnouncement :one
DELETE FROM signage_announcements WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING id;

-- name: DeleteExpiredSignageAnnouncements :many
DELETE FROM signage_announcements WHERE ends_at IS NOT NULL AND ends_at < sqlc.arg(cutoff)::timestamptz RETURNING id;

-- name: InsertSignageAnnouncementValue :exec
INSERT INTO signage_announcement_values (announcement_id, key, value) VALUES (sqlc.arg(announcement_id), sqlc.arg(key), sqlc.arg(value));

-- name: DeleteSignageAnnouncementValues :exec
DELETE FROM signage_announcement_values WHERE announcement_id = sqlc.arg(announcement_id);

-- name: ListSignageAnnouncementValues :many
SELECT * FROM signage_announcement_values WHERE announcement_id = ANY(sqlc.arg(announcement_ids)::text[]::uuid[]) ORDER BY announcement_id, key;

-- name: InsertSignageAnnouncementDisplay :exec
INSERT INTO signage_announcement_displays (announcement_id, display_id) VALUES (sqlc.arg(announcement_id), sqlc.arg(display_id));

-- name: DeleteSignageAnnouncementDisplays :exec
DELETE FROM signage_announcement_displays WHERE announcement_id = sqlc.arg(announcement_id);

-- name: ListSignageAnnouncementDisplays :many
SELECT * FROM signage_announcement_displays WHERE announcement_id = ANY(sqlc.arg(announcement_ids)::text[]::uuid[]) ORDER BY announcement_id, display_id;

-- name: InsertSignageAnnouncementGroup :exec
INSERT INTO signage_announcement_groups (announcement_id, group_id) VALUES (sqlc.arg(announcement_id), sqlc.arg(group_id));

-- name: DeleteSignageAnnouncementGroups :exec
DELETE FROM signage_announcement_groups WHERE announcement_id = sqlc.arg(announcement_id);

-- name: ListSignageAnnouncementGroups :many
SELECT * FROM signage_announcement_groups WHERE announcement_id = ANY(sqlc.arg(announcement_ids)::text[]::uuid[]) ORDER BY announcement_id, group_id;

-- name: ListSignageDisplayGroupIDs :many
SELECT id FROM signage_display_groups WHERE id = ANY(sqlc.arg(ids)::text[]::uuid[]) FOR SHARE;

-- name: ListSignageDisplayIDs :many
SELECT id FROM signage_displays WHERE id = ANY(sqlc.arg(ids)::text[]::uuid[]);

-- name: ListSignageMachineNames :many
SELECT id, name FROM machines WHERE id = ANY(sqlc.arg(ids)::text[]::uuid[]);

-- Displays ----------------------------------------------------------------------------------------------------

-- name: CreateSignageDisplay :one
INSERT INTO signage_displays (id, managed_device_id, name, location, aspect_width, aspect_height, visible_from_outside, allow_camera_outside, group_id)
VALUES (sqlc.arg(id), sqlc.arg(managed_device_id), sqlc.arg(name), sqlc.arg(location), sqlc.arg(aspect_width), sqlc.arg(aspect_height),
        sqlc.arg(visible_from_outside), sqlc.arg(allow_camera_outside), sqlc.narg(group_id))
RETURNING id;

-- name: ListSignageDisplayViews :many
SELECT d.id, d.managed_device_id, d.name, d.location, d.aspect_width, d.aspect_height, d.visible_from_outside, d.allow_camera_outside, d.group_id,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('sceneId', ds.scene_id, 'seconds', ds.seconds, 'transition', ds.transition) ORDER BY ds.position)
                 FROM signage_default_scenes ds WHERE ds.display_id = d.id), '[]'::jsonb)::text AS default_scenes,
       d.revoked_at, md.revoked_at AS device_revoked_at, d.version, d.created_at, d.updated_at,
       s.last_heartbeat_at, s.publication_revision AS reported_revision, s.current_rule, s.current_scene_id, s.player_version,
       s.cache_used_bytes, s.cache_quota_bytes, s.errors,
       COALESCE((SELECT revision FROM signage_publications WHERE display_id = d.id ORDER BY revision DESC LIMIT 1), 0)::int AS published_revision,
       COALESCE((SELECT published_at FROM signage_publications WHERE display_id = d.id ORDER BY revision DESC LIMIT 1), 'epoch'::timestamptz)::timestamptz AS published_at
FROM signage_displays d
JOIN managed_devices md ON md.id = d.managed_device_id
LEFT JOIN signage_display_states s ON s.display_id = d.id
ORDER BY lower(d.name), d.id;

-- name: GetSignageDisplayView :one
SELECT d.id, d.managed_device_id, d.name, d.location, d.aspect_width, d.aspect_height, d.visible_from_outside, d.allow_camera_outside, d.group_id,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('sceneId', ds.scene_id, 'seconds', ds.seconds, 'transition', ds.transition) ORDER BY ds.position)
                 FROM signage_default_scenes ds WHERE ds.display_id = d.id), '[]'::jsonb)::text AS default_scenes,
       d.revoked_at, md.revoked_at AS device_revoked_at, d.version, d.created_at, d.updated_at,
       s.last_heartbeat_at, s.publication_revision AS reported_revision, s.current_rule, s.current_scene_id, s.player_version,
       s.cache_used_bytes, s.cache_quota_bytes, s.errors,
       COALESCE((SELECT revision FROM signage_publications WHERE display_id = d.id ORDER BY revision DESC LIMIT 1), 0)::int AS published_revision,
       COALESCE((SELECT published_at FROM signage_publications WHERE display_id = d.id ORDER BY revision DESC LIMIT 1), 'epoch'::timestamptz)::timestamptz AS published_at
FROM signage_displays d
JOIN managed_devices md ON md.id = d.managed_device_id
LEFT JOIN signage_display_states s ON s.display_id = d.id
WHERE d.id = sqlc.arg(id);

-- name: GetSignageDisplayForUpdate :one
SELECT d.id, d.managed_device_id, d.name, d.location, d.aspect_width, d.aspect_height, d.visible_from_outside, d.allow_camera_outside, d.group_id,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('sceneId', ds.scene_id, 'seconds', ds.seconds, 'transition', ds.transition) ORDER BY ds.position)
                 FROM signage_default_scenes ds WHERE ds.display_id = d.id), '[]'::jsonb)::text AS default_scenes,
       d.revoked_at, md.revoked_at AS device_revoked_at, d.version
FROM signage_displays d JOIN managed_devices md ON md.id = d.managed_device_id
WHERE d.id = sqlc.arg(id) FOR UPDATE OF d;

-- name: GetSignageDisplayByDevice :one
SELECT d.id, d.name, d.location, d.aspect_width, d.aspect_height, d.visible_from_outside, d.allow_camera_outside, d.revoked_at, md.revoked_at AS device_revoked_at
FROM signage_displays d JOIN managed_devices md ON md.id = d.managed_device_id
WHERE d.managed_device_id = sqlc.arg(managed_device_id);

-- name: UpdateSignageDisplay :one
UPDATE signage_displays
SET name = sqlc.arg(name), location = sqlc.arg(location), aspect_width = sqlc.arg(aspect_width), aspect_height = sqlc.arg(aspect_height),
    visible_from_outside = sqlc.arg(visible_from_outside), allow_camera_outside = sqlc.arg(allow_camera_outside),
    group_id = sqlc.narg(group_id), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND revoked_at IS NULL
RETURNING id;

-- name: BumpSignageDisplayVersion :one
UPDATE signage_displays SET version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING version;

-- name: RevokeSignageDisplay :one
UPDATE signage_displays SET revoked_at = now(), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND revoked_at IS NULL RETURNING id;

-- name: DeleteSignageDisplay :one
DELETE FROM signage_displays WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING managed_device_id;

-- name: LockSignageScenesForShare :many
-- The scenes a scene list refers to, share-locked so that a concurrent deletion or change of a scene's ratio
-- either waits for this transaction or is seen by it.
SELECT id, aspect_width, aspect_height FROM signage_scenes WHERE id = ANY(sqlc.arg(ids)::text[]::uuid[]) ORDER BY id FOR SHARE;

-- name: CountSceneRulesWithOtherAspectRatio :one
-- Rules of a display or a group whose scene list shows a scene with another aspect ratio. The scenes are share-locked so
-- that a concurrent change of a scene's ratio either waits for this transaction or is seen by it.
SELECT count(DISTINCT mismatched.rule_id) FROM (
    SELECT r.id AS rule_id FROM signage_rules r
    JOIN signage_rule_scenes rs ON rs.rule_id = r.id
    JOIN signage_scenes s ON s.id = rs.scene_id
    WHERE (r.display_id = sqlc.narg(display_id)::uuid OR r.group_id = sqlc.narg(group_id)::uuid)
      AND (s.aspect_width <> sqlc.arg(aspect_width)::smallint OR s.aspect_height <> sqlc.arg(aspect_height)::smallint)
    FOR SHARE OF s
) mismatched;

-- name: CountSceneListsWithOtherAspectRatioForScene :one
-- Rule lists and default lists that show the scene on a display or a group with another aspect ratio.
SELECT (
    SELECT count(DISTINCT r.id) FROM signage_rules r
    JOIN signage_rule_scenes rs ON rs.rule_id = r.id
    LEFT JOIN signage_displays d ON d.id = r.display_id
    LEFT JOIN signage_display_groups g ON g.id = r.group_id
    WHERE rs.scene_id = sqlc.arg(scene_id)
      AND (COALESCE(d.aspect_width, g.aspect_width) <> sqlc.arg(aspect_width)::smallint
           OR COALESCE(d.aspect_height, g.aspect_height) <> sqlc.arg(aspect_height)::smallint)
) + (
    SELECT count(DISTINCT COALESCE(ds.display_id, ds.group_id)) FROM signage_default_scenes ds
    LEFT JOIN signage_displays d ON d.id = ds.display_id
    LEFT JOIN signage_display_groups g ON g.id = ds.group_id
    WHERE ds.scene_id = sqlc.arg(scene_id)
      AND (COALESCE(d.aspect_width, g.aspect_width) <> sqlc.arg(aspect_width)::smallint
           OR COALESCE(d.aspect_height, g.aspect_height) <> sqlc.arg(aspect_height)::smallint)
)::bigint AS mismatched;

-- name: DeleteSignageDefaultScenes :exec
DELETE FROM signage_default_scenes WHERE display_id = sqlc.narg(display_id)::uuid OR group_id = sqlc.narg(group_id)::uuid;

-- name: InsertSignageDefaultScenes :exec
INSERT INTO signage_default_scenes (display_id, group_id, position, scene_id, seconds, transition)
SELECT sqlc.narg(display_id)::uuid, sqlc.narg(group_id)::uuid, unnest(sqlc.arg(positions)::int[]), unnest(sqlc.arg(scene_ids)::text[]::uuid[]),
       unnest(sqlc.arg(seconds)::int[]), unnest(sqlc.arg(transitions)::text[]);

-- Pairing -----------------------------------------------------------------------------------------------------

-- name: DeleteExpiredSignagePairingRequests :exec
DELETE FROM signage_pairing_requests WHERE expires_at <= sqlc.arg(now)::timestamptz;

-- name: CountOpenSignagePairingRequests :one
SELECT count(*) FROM signage_pairing_requests WHERE expires_at > sqlc.arg(now)::timestamptz;

-- name: CreateSignagePairingRequest :exec
INSERT INTO signage_pairing_requests (id, code_digest, poll_secret_digest, created_at, expires_at)
VALUES (sqlc.arg(id), sqlc.arg(code_digest), sqlc.arg(poll_secret_digest), sqlc.arg(created_at), sqlc.arg(expires_at));

-- name: DeleteSignagePairingRequestByPollDigest :exec
DELETE FROM signage_pairing_requests WHERE poll_secret_digest = sqlc.arg(poll_secret_digest) AND claimed_display_id IS NULL;

-- name: GetSignagePairingRequestForPoll :one
SELECT r.id, r.expires_at, r.claimed_display_id, d.managed_device_id
FROM signage_pairing_requests r LEFT JOIN signage_displays d ON d.id = r.claimed_display_id
WHERE r.poll_secret_digest = sqlc.arg(poll_secret_digest) FOR UPDATE OF r;

-- name: GetOpenSignagePairingRequestByCode :one
SELECT id FROM signage_pairing_requests
WHERE code_digest = sqlc.arg(code_digest) AND claimed_at IS NULL AND expires_at > sqlc.arg(now)::timestamptz FOR UPDATE;

-- name: ClaimSignagePairingRequest :exec
UPDATE signage_pairing_requests SET claimed_display_id = sqlc.arg(display_id), claimed_at = sqlc.arg(now)::timestamptz, expires_at = sqlc.arg(delivery_deadline)
WHERE id = sqlc.arg(id);

-- name: DeleteSignagePairingRequest :exec
DELETE FROM signage_pairing_requests WHERE id = sqlc.arg(id);

-- Rules -------------------------------------------------------------------------------------------------------

-- name: ListSignageRules :many
SELECT r.id, r.display_id, r.group_id, r.position, r.enabled, r.condition_kind, r.weekdays,
       COALESCE(r.time_from::text, '')::text AS time_from, COALESCE(r.time_to::text, '')::text AS time_to,
       r.machine_ids::text[] AS machine_ids, r.machine_match, r.announcement_template_ids::text[] AS announcement_template_ids,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('sceneId', rs.scene_id, 'seconds', rs.seconds, 'transition', rs.transition) ORDER BY rs.position)
                 FROM signage_rule_scenes rs WHERE rs.rule_id = r.id), '[]'::jsonb)::text AS scenes,
       r.min_seconds, r.multi_mode, r.alternate_seconds
FROM signage_rules r
WHERE r.display_id = ANY(sqlc.arg(display_ids)::text[]::uuid[]) OR r.group_id = ANY(sqlc.arg(group_ids)::text[]::uuid[])
ORDER BY r.display_id, r.group_id, r.position;

-- name: InsertSignageRule :exec
INSERT INTO signage_rules (id, display_id, group_id, position, enabled, condition_kind, weekdays, time_from, time_to, machine_ids, machine_match,
                           announcement_template_ids, min_seconds, multi_mode, alternate_seconds)
VALUES (sqlc.arg(id), sqlc.narg(display_id), sqlc.narg(group_id), sqlc.arg(position), sqlc.arg(enabled), sqlc.arg(condition_kind), sqlc.arg(weekdays)::smallint[],
        sqlc.narg(time_from)::text::time, sqlc.narg(time_to)::text::time, sqlc.arg(machine_ids)::text[]::uuid[], sqlc.narg(machine_match),
        sqlc.arg(announcement_template_ids)::text[]::uuid[], sqlc.arg(min_seconds), sqlc.arg(multi_mode), sqlc.arg(alternate_seconds));

-- name: UpdateSignageRule :execrows
UPDATE signage_rules
SET enabled = sqlc.arg(enabled), condition_kind = sqlc.arg(condition_kind), weekdays = sqlc.arg(weekdays)::smallint[],
    time_from = sqlc.narg(time_from)::text::time, time_to = sqlc.narg(time_to)::text::time, machine_ids = sqlc.arg(machine_ids)::text[]::uuid[],
    machine_match = sqlc.narg(machine_match), announcement_template_ids = sqlc.arg(announcement_template_ids)::text[]::uuid[],
    min_seconds = sqlc.arg(min_seconds), multi_mode = sqlc.arg(multi_mode), alternate_seconds = sqlc.arg(alternate_seconds)
WHERE id = sqlc.arg(id) AND (display_id = sqlc.narg(display_id)::uuid OR group_id = sqlc.narg(group_id)::uuid);

-- name: SetSignageRuleEnabled :execrows
UPDATE signage_rules SET enabled = sqlc.arg(enabled) WHERE id = sqlc.arg(id) AND (display_id = sqlc.narg(display_id)::uuid OR group_id = sqlc.narg(group_id)::uuid);

-- name: SetSignageRulePosition :exec
UPDATE signage_rules SET position = sqlc.arg(position) WHERE id = sqlc.arg(id) AND (display_id = sqlc.narg(display_id)::uuid OR group_id = sqlc.narg(group_id)::uuid);

-- name: DeleteSignageRule :execrows
DELETE FROM signage_rules WHERE id = sqlc.arg(id) AND (display_id = sqlc.narg(display_id)::uuid OR group_id = sqlc.narg(group_id)::uuid);

-- name: DeleteSignageRulesOfDisplay :exec
DELETE FROM signage_rules WHERE display_id = sqlc.arg(display_id);

-- name: DeleteSignageRuleScenes :exec
DELETE FROM signage_rule_scenes WHERE rule_id = sqlc.arg(rule_id);

-- name: InsertSignageRuleScenes :exec
INSERT INTO signage_rule_scenes (rule_id, position, scene_id, seconds, transition)
SELECT sqlc.arg(rule_id)::uuid, unnest(sqlc.arg(positions)::int[]), unnest(sqlc.arg(scene_ids)::text[]::uuid[]),
       unnest(sqlc.arg(seconds)::int[]), unnest(sqlc.arg(transitions)::text[]);

-- name: ListSignageTemplateIDsByIDs :many
SELECT id FROM signage_announcement_templates WHERE id = ANY(sqlc.arg(ids)::text[]::uuid[]) FOR SHARE;

-- Publications and manifest content ---------------------------------------------------------------------------

-- name: ListSignageScenesByIDs :many
SELECT * FROM signage_scenes WHERE id = ANY(sqlc.arg(ids)::text[]::uuid[]) ORDER BY id;

-- name: ListSignageAssetsByIDs :many
SELECT a.id, a.kind, a.name, a.width, a.height, a.duration_ms, f.content_type, f.size_bytes, f.sha256
FROM signage_assets a JOIN files f ON f.id = a.file_id
WHERE a.id = ANY(sqlc.arg(ids)::text[]::uuid[]) ORDER BY a.id;

-- name: NextSignagePublicationRevision :one
SELECT (COALESCE(max(revision), 0) + 1)::int AS revision FROM signage_publications WHERE display_id = sqlc.arg(display_id);

-- name: InsertSignagePublication :exec
INSERT INTO signage_publications (id, display_id, revision, manifest, manifest_sha256, published_by_account_id, published_at)
VALUES (sqlc.arg(id), sqlc.arg(display_id), sqlc.arg(revision), sqlc.arg(manifest)::text::jsonb, sqlc.arg(manifest_sha256), sqlc.narg(published_by_account_id), sqlc.arg(published_at));

-- name: PruneSignagePublications :exec
DELETE FROM signage_publications WHERE display_id = sqlc.arg(display_id) AND revision <= sqlc.arg(max_revision)::int;

-- name: GetLatestSignagePublication :one
SELECT revision, manifest, manifest_sha256, published_at FROM signage_publications WHERE display_id = sqlc.arg(display_id) ORDER BY revision DESC LIMIT 1;

-- name: ListLatestSignagePublications :many
SELECT DISTINCT ON (display_id) display_id, revision, manifest FROM signage_publications
WHERE display_id = ANY(sqlc.arg(display_ids)::text[]::uuid[]) ORDER BY display_id, revision DESC;

-- Player ------------------------------------------------------------------------------------------------------

-- name: UpsertSignageDisplayState :exec
INSERT INTO signage_display_states (display_id, last_heartbeat_at, publication_revision, current_rule, current_scene_id, player_version, cache_used_bytes, cache_quota_bytes, errors)
VALUES (sqlc.arg(display_id), sqlc.arg(last_heartbeat_at), sqlc.narg(publication_revision), sqlc.narg(current_rule), sqlc.narg(current_scene_id),
        sqlc.narg(player_version), sqlc.narg(cache_used_bytes), sqlc.narg(cache_quota_bytes), sqlc.arg(errors)::text::jsonb)
ON CONFLICT (display_id) DO UPDATE SET last_heartbeat_at = EXCLUDED.last_heartbeat_at, publication_revision = EXCLUDED.publication_revision,
    current_rule = EXCLUDED.current_rule, current_scene_id = EXCLUDED.current_scene_id, player_version = EXCLUDED.player_version,
    cache_used_bytes = EXCLUDED.cache_used_bytes, cache_quota_bytes = EXCLUDED.cache_quota_bytes, errors = EXCLUDED.errors;

-- name: ListSignageLiveStatuses :many
SELECT s.machine_id, s.observed_at, s.received_at, s.snapshot
FROM printer_live_statuses s JOIN printer_connector_assignments a ON a.id = s.assignment_id
WHERE a.ended_at IS NULL AND s.machine_id = ANY(sqlc.arg(ids)::text[]::uuid[]);

-- name: ListLiveSignageAnnouncementsForDisplay :many
SELECT a.* FROM signage_announcements a
WHERE a.starts_at <= sqlc.arg(now)::timestamptz AND (a.ends_at IS NULL OR a.ends_at > sqlc.arg(now)::timestamptz)
  AND (a.all_displays
       OR EXISTS (SELECT 1 FROM signage_announcement_displays ad WHERE ad.announcement_id = a.id AND ad.display_id = sqlc.arg(display_id))
       OR EXISTS (SELECT 1 FROM signage_announcement_groups ag JOIN signage_displays d ON d.group_id = ag.group_id
                  WHERE ag.announcement_id = a.id AND d.id = sqlc.arg(display_id)))
ORDER BY a.starts_at, a.id;

-- Display groups ----------------------------------------------------------------------------------------------

-- name: CreateSignageDisplayGroup :exec
INSERT INTO signage_display_groups (id, name, aspect_width, aspect_height)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(aspect_width), sqlc.arg(aspect_height));

-- name: ListSignageDisplayGroupViews :many
-- Groups with their default list (as JSON) and their member display ids by display name. ids empty means all.
SELECT g.id, g.name, g.aspect_width, g.aspect_height, g.version, g.created_at, g.updated_at,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('sceneId', ds.scene_id, 'seconds', ds.seconds, 'transition', ds.transition) ORDER BY ds.position)
                 FROM signage_default_scenes ds WHERE ds.group_id = g.id), '[]'::jsonb)::text AS default_scenes,
       COALESCE((SELECT array_agg(d.id::text ORDER BY lower(d.name), d.id) FROM signage_displays d WHERE d.group_id = g.id), '{}')::text[] AS display_ids
FROM signage_display_groups g
WHERE cardinality(sqlc.arg(ids)::text[]) = 0 OR g.id = ANY(sqlc.arg(ids)::text[]::uuid[])
ORDER BY lower(g.name), g.id;

-- name: GetSignageDisplayGroupForUpdate :one
SELECT g.id, g.name, g.aspect_width, g.aspect_height, g.version,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('sceneId', ds.scene_id, 'seconds', ds.seconds, 'transition', ds.transition) ORDER BY ds.position)
                 FROM signage_default_scenes ds WHERE ds.group_id = g.id), '[]'::jsonb)::text AS default_scenes
FROM signage_display_groups g WHERE g.id = sqlc.arg(id) FOR UPDATE;

-- name: GetSignageDisplayGroupForShare :one
SELECT g.id, g.name, g.aspect_width, g.aspect_height, g.version FROM signage_display_groups g WHERE g.id = sqlc.arg(id) FOR SHARE;

-- name: UpdateSignageDisplayGroup :one
UPDATE signage_display_groups
SET name = sqlc.arg(name), aspect_width = sqlc.arg(aspect_width), aspect_height = sqlc.arg(aspect_height), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING version;

-- name: BumpSignageDisplayGroupVersion :one
UPDATE signage_display_groups SET version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING version;

-- name: DeleteSignageDisplayGroup :one
DELETE FROM signage_display_groups WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING id;

-- name: ListSignageGroupMembers :many
-- Member displays of groups by name, with what a group publication and the pending-change diff need.
SELECT d.id, d.group_id::uuid AS group_id, d.name, d.aspect_width, d.aspect_height, d.visible_from_outside,
       (d.revoked_at IS NOT NULL OR md.revoked_at IS NOT NULL)::boolean AS revoked
FROM signage_displays d JOIN managed_devices md ON md.id = d.managed_device_id
WHERE d.group_id = ANY(sqlc.arg(group_ids)::text[]::uuid[])
ORDER BY lower(d.name), d.id;
