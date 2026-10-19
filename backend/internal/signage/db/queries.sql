-- Assets ------------------------------------------------------------------------------------------------------

-- name: CreateSignageAsset :one
INSERT INTO signage_assets (id, file_id, kind, name, width, height, duration_ms, created_by_account_id)
VALUES (sqlc.arg(id), sqlc.arg(file_id), sqlc.arg(kind), sqlc.arg(name), sqlc.narg(width), sqlc.narg(height), sqlc.narg(duration_ms), sqlc.narg(created_by_account_id))
RETURNING id;

-- name: GetSignageAsset :one
SELECT a.id, a.file_id, a.kind, a.name, a.width, a.height, a.duration_ms, a.created_by_account_id, a.created_at,
       f.content_type, f.size_bytes, f.sha256
FROM signage_assets a JOIN files f ON f.id = a.file_id
WHERE a.id = sqlc.arg(id);

-- name: GetSignageAssetForUpdate :one
SELECT id, file_id, kind, name FROM signage_assets WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: ListSignageAssets :many
SELECT a.id, a.file_id, a.kind, a.name, a.width, a.height, a.duration_ms, a.created_by_account_id, a.created_at,
       f.content_type, f.size_bytes, f.sha256
FROM signage_assets a JOIN files f ON f.id = a.file_id
WHERE (sqlc.narg(kind)::text IS NULL OR a.kind = sqlc.narg(kind)::text)
ORDER BY a.created_at DESC, a.id DESC;

-- name: RenameSignageAsset :execrows
UPDATE signage_assets SET name = sqlc.arg(name) WHERE id = sqlc.arg(id);

-- name: DeleteSignageAsset :one
DELETE FROM signage_assets WHERE id = sqlc.arg(id) RETURNING file_id;

-- name: ListSignageAssetKinds :many
SELECT id, kind FROM signage_assets WHERE id = ANY(sqlc.arg(ids)::text[]::uuid[]) FOR SHARE;

-- name: ListScenesReferencingAsset :many
SELECT id, name FROM signage_scenes
WHERE background_asset_id = sqlc.arg(id)::uuid OR position((sqlc.arg(id)::uuid)::text in zones::text) > 0
ORDER BY lower(name), id;

-- Scenes ------------------------------------------------------------------------------------------------------

-- name: CreateSignageScene :one
INSERT INTO signage_scenes (id, name, orientation, layout_id, background_color, background_asset_id, background_fit, background_dim, theme, zones)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(orientation), sqlc.arg(layout_id), sqlc.arg(background_color), sqlc.narg(background_asset_id),
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
SET name = sqlc.arg(name), orientation = sqlc.arg(orientation), layout_id = sqlc.arg(layout_id), background_color = sqlc.arg(background_color),
    background_asset_id = sqlc.narg(background_asset_id), background_fit = sqlc.arg(background_fit), background_dim = sqlc.arg(background_dim),
    theme = sqlc.arg(theme), zones = sqlc.arg(zones)::text::jsonb, version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: DeleteSignageScene :one
DELETE FROM signage_scenes WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING id;

-- name: ListSignageSceneIDs :many
SELECT id FROM signage_scenes WHERE id = ANY(sqlc.arg(ids)::text[]::uuid[]);

-- name: ListPlaylistsReferencingScene :many
SELECT DISTINCT p.id, p.name FROM signage_playlist_items i JOIN signage_playlists p ON p.id = i.playlist_id
WHERE i.scene_id = sqlc.arg(scene_id) ORDER BY p.name, p.id;

-- name: ListRulesReferencingScene :many
SELECT r.id AS rule_id, d.id AS display_id, d.name AS display_name FROM signage_rules r JOIN signage_displays d ON d.id = r.display_id
WHERE r.target_scene_id = sqlc.arg(scene_id) ORDER BY d.name, r.position;

-- Playlists ---------------------------------------------------------------------------------------------------

-- name: CreateSignagePlaylist :one
INSERT INTO signage_playlists (id, name) VALUES (sqlc.arg(id), sqlc.arg(name)) RETURNING *;

-- name: GetSignagePlaylist :one
SELECT * FROM signage_playlists WHERE id = sqlc.arg(id);

-- name: GetSignagePlaylistForUpdate :one
SELECT * FROM signage_playlists WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: ListSignagePlaylists :many
SELECT * FROM signage_playlists ORDER BY lower(name), id;

-- name: UpdateSignagePlaylist :one
UPDATE signage_playlists SET name = sqlc.arg(name), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING *;

-- name: DeleteSignagePlaylist :one
DELETE FROM signage_playlists WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING id;

-- name: InsertSignagePlaylistItem :exec
INSERT INTO signage_playlist_items (playlist_id, position, scene_id, seconds, transition)
VALUES (sqlc.arg(playlist_id), sqlc.arg(position), sqlc.arg(scene_id), sqlc.arg(seconds), sqlc.arg(transition));

-- name: DeleteSignagePlaylistItems :exec
DELETE FROM signage_playlist_items WHERE playlist_id = sqlc.arg(playlist_id);

-- name: ListSignagePlaylistItems :many
SELECT * FROM signage_playlist_items WHERE playlist_id = ANY(sqlc.arg(playlist_ids)::text[]::uuid[]) ORDER BY playlist_id, position;

-- name: ListDisplaysByDefaultPlaylist :many
SELECT id, name FROM signage_displays WHERE default_playlist_id = sqlc.arg(playlist_id) ORDER BY name, id;

-- name: ListRulesReferencingPlaylist :many
SELECT r.id AS rule_id, d.id AS display_id, d.name AS display_name FROM signage_rules r JOIN signage_displays d ON d.id = r.display_id
WHERE r.target_playlist_id = sqlc.arg(playlist_id) ORDER BY d.name, r.position;

-- Announcement templates --------------------------------------------------------------------------------------

-- name: CreateSignageTemplate :one
INSERT INTO signage_announcement_templates (id, name, tone, title, body)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(tone), sqlc.arg(title), sqlc.arg(body)) RETURNING *;

-- name: GetSignageTemplate :one
SELECT * FROM signage_announcement_templates WHERE id = sqlc.arg(id);

-- name: GetSignageTemplateForUpdate :one
SELECT * FROM signage_announcement_templates WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: ListSignageTemplates :many
SELECT * FROM signage_announcement_templates ORDER BY lower(name), id;

-- name: UpdateSignageTemplate :one
UPDATE signage_announcement_templates
SET name = sqlc.arg(name), tone = sqlc.arg(tone), title = sqlc.arg(title), body = sqlc.arg(body), version = version + 1, updated_at = now()
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
SELECT r.id AS rule_id, d.id AS display_id, d.name AS display_name FROM signage_rules r JOIN signage_displays d ON d.id = r.display_id
WHERE r.announcement_template_ids @> ARRAY[sqlc.arg(template_id)::uuid] ORDER BY d.name, r.position;

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

-- name: ListSignageDisplayIDs :many
SELECT id FROM signage_displays WHERE id = ANY(sqlc.arg(ids)::text[]::uuid[]);

-- name: ListSignageMachineNames :many
SELECT id, name FROM machines WHERE id = ANY(sqlc.arg(ids)::text[]::uuid[]);
