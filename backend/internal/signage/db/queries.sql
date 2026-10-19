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

-- Displays ----------------------------------------------------------------------------------------------------

-- name: CreateSignageDisplay :one
INSERT INTO signage_displays (id, managed_device_id, name, location, orientation, resolution_width, resolution_height, visible_from_outside, default_playlist_id)
VALUES (sqlc.arg(id), sqlc.arg(managed_device_id), sqlc.arg(name), sqlc.arg(location), sqlc.arg(orientation), sqlc.arg(resolution_width),
        sqlc.arg(resolution_height), sqlc.arg(visible_from_outside), sqlc.arg(default_playlist_id))
RETURNING id;

-- name: ListSignageDisplayViews :many
SELECT d.id, d.managed_device_id, d.name, d.location, d.orientation, d.resolution_width, d.resolution_height, d.visible_from_outside,
       d.default_playlist_id, d.revoked_at, md.revoked_at AS device_revoked_at, d.version, d.created_at, d.updated_at,
       s.last_heartbeat_at, s.publication_revision AS reported_revision, s.current_rule, s.current_scene_id, s.player_version,
       s.cache_used_bytes, s.cache_quota_bytes, s.errors,
       COALESCE((SELECT revision FROM signage_publications WHERE display_id = d.id ORDER BY revision DESC LIMIT 1), 0)::int AS published_revision,
       COALESCE((SELECT published_at FROM signage_publications WHERE display_id = d.id ORDER BY revision DESC LIMIT 1), 'epoch'::timestamptz)::timestamptz AS published_at
FROM signage_displays d
JOIN managed_devices md ON md.id = d.managed_device_id
LEFT JOIN signage_display_states s ON s.display_id = d.id
ORDER BY lower(d.name), d.id;

-- name: GetSignageDisplayView :one
SELECT d.id, d.managed_device_id, d.name, d.location, d.orientation, d.resolution_width, d.resolution_height, d.visible_from_outside,
       d.default_playlist_id, d.revoked_at, md.revoked_at AS device_revoked_at, d.version, d.created_at, d.updated_at,
       s.last_heartbeat_at, s.publication_revision AS reported_revision, s.current_rule, s.current_scene_id, s.player_version,
       s.cache_used_bytes, s.cache_quota_bytes, s.errors,
       COALESCE((SELECT revision FROM signage_publications WHERE display_id = d.id ORDER BY revision DESC LIMIT 1), 0)::int AS published_revision,
       COALESCE((SELECT published_at FROM signage_publications WHERE display_id = d.id ORDER BY revision DESC LIMIT 1), 'epoch'::timestamptz)::timestamptz AS published_at
FROM signage_displays d
JOIN managed_devices md ON md.id = d.managed_device_id
LEFT JOIN signage_display_states s ON s.display_id = d.id
WHERE d.id = sqlc.arg(id);

-- name: GetSignageDisplayForUpdate :one
SELECT d.id, d.managed_device_id, d.name, d.location, d.orientation, d.resolution_width, d.resolution_height, d.visible_from_outside,
       d.default_playlist_id, d.revoked_at, md.revoked_at AS device_revoked_at, d.version
FROM signage_displays d JOIN managed_devices md ON md.id = d.managed_device_id
WHERE d.id = sqlc.arg(id) FOR UPDATE OF d;

-- name: GetSignageDisplayByDevice :one
SELECT d.id, d.name, d.location, d.orientation, d.resolution_width, d.resolution_height, d.visible_from_outside, d.revoked_at, md.revoked_at AS device_revoked_at
FROM signage_displays d JOIN managed_devices md ON md.id = d.managed_device_id
WHERE d.managed_device_id = sqlc.arg(managed_device_id);

-- name: UpdateSignageDisplay :one
UPDATE signage_displays
SET name = sqlc.arg(name), location = sqlc.arg(location), orientation = sqlc.arg(orientation), resolution_width = sqlc.arg(resolution_width),
    resolution_height = sqlc.arg(resolution_height), visible_from_outside = sqlc.arg(visible_from_outside), default_playlist_id = sqlc.arg(default_playlist_id),
    version = version + 1, updated_at = now()
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

-- name: LockSignagePlaylistForShare :one
SELECT id FROM signage_playlists WHERE id = sqlc.arg(id) FOR SHARE;

-- name: LockSignageSceneForShare :one
SELECT id, orientation FROM signage_scenes WHERE id = sqlc.arg(id) FOR SHARE;

-- name: CountSceneRulesWithOtherOrientation :one
SELECT count(*) FROM signage_rules r JOIN signage_scenes s ON s.id = r.target_scene_id
WHERE r.display_id = sqlc.arg(display_id) AND s.orientation <> sqlc.arg(orientation)::text;

-- Pairing -----------------------------------------------------------------------------------------------------

-- name: DeleteExpiredSignagePairingRequests :exec
DELETE FROM signage_pairing_requests WHERE expires_at <= sqlc.arg(now)::timestamptz;

-- name: CountOpenSignagePairingRequests :one
SELECT count(*) FROM signage_pairing_requests WHERE expires_at > sqlc.arg(now)::timestamptz;

-- name: CreateSignagePairingRequest :exec
INSERT INTO signage_pairing_requests (id, code_digest, poll_secret_digest, created_at, expires_at)
VALUES (sqlc.arg(id), sqlc.arg(code_digest), sqlc.arg(poll_secret_digest), sqlc.arg(created_at), sqlc.arg(expires_at));

-- name: DeleteSignagePairingRequestByPollDigest :exec
DELETE FROM signage_pairing_requests WHERE poll_secret_digest = sqlc.arg(poll_secret_digest);

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
SELECT id, display_id, position, enabled, condition_kind, weekdays, COALESCE(time_from::text, '')::text AS time_from, COALESCE(time_to::text, '')::text AS time_to,
       machine_ids::text[] AS machine_ids, machine_match, announcement_template_ids::text[] AS announcement_template_ids,
       target_kind, target_scene_id, target_playlist_id, min_seconds, multi_mode, alternate_seconds
FROM signage_rules WHERE display_id = ANY(sqlc.arg(display_ids)::text[]::uuid[]) ORDER BY display_id, position;

-- name: InsertSignageRule :exec
INSERT INTO signage_rules (id, display_id, position, enabled, condition_kind, weekdays, time_from, time_to, machine_ids, machine_match,
                           announcement_template_ids, target_kind, target_scene_id, target_playlist_id, min_seconds, multi_mode, alternate_seconds)
VALUES (sqlc.arg(id), sqlc.arg(display_id), sqlc.arg(position), sqlc.arg(enabled), sqlc.arg(condition_kind), sqlc.arg(weekdays)::smallint[],
        sqlc.narg(time_from)::text::time, sqlc.narg(time_to)::text::time, sqlc.arg(machine_ids)::text[]::uuid[], sqlc.narg(machine_match),
        sqlc.arg(announcement_template_ids)::text[]::uuid[], sqlc.arg(target_kind), sqlc.narg(target_scene_id), sqlc.narg(target_playlist_id),
        sqlc.arg(min_seconds), sqlc.arg(multi_mode), sqlc.arg(alternate_seconds));

-- name: UpdateSignageRule :execrows
UPDATE signage_rules
SET enabled = sqlc.arg(enabled), condition_kind = sqlc.arg(condition_kind), weekdays = sqlc.arg(weekdays)::smallint[],
    time_from = sqlc.narg(time_from)::text::time, time_to = sqlc.narg(time_to)::text::time, machine_ids = sqlc.arg(machine_ids)::text[]::uuid[],
    machine_match = sqlc.narg(machine_match), announcement_template_ids = sqlc.arg(announcement_template_ids)::text[]::uuid[],
    target_kind = sqlc.arg(target_kind), target_scene_id = sqlc.narg(target_scene_id), target_playlist_id = sqlc.narg(target_playlist_id),
    min_seconds = sqlc.arg(min_seconds), multi_mode = sqlc.arg(multi_mode), alternate_seconds = sqlc.arg(alternate_seconds)
WHERE id = sqlc.arg(id) AND display_id = sqlc.arg(display_id);

-- name: SetSignageRuleEnabled :execrows
UPDATE signage_rules SET enabled = sqlc.arg(enabled) WHERE id = sqlc.arg(id) AND display_id = sqlc.arg(display_id);

-- name: SetSignageRulePosition :exec
UPDATE signage_rules SET position = sqlc.arg(position) WHERE id = sqlc.arg(id) AND display_id = sqlc.arg(display_id);

-- name: DeleteSignageRule :execrows
DELETE FROM signage_rules WHERE id = sqlc.arg(id) AND display_id = sqlc.arg(display_id);

-- name: ListSignageTemplateIDsByIDs :many
SELECT id FROM signage_announcement_templates WHERE id = ANY(sqlc.arg(ids)::text[]::uuid[]) FOR SHARE;

-- Publications and manifest content ---------------------------------------------------------------------------

-- name: ListSignageScenesByIDs :many
SELECT * FROM signage_scenes WHERE id = ANY(sqlc.arg(ids)::text[]::uuid[]) ORDER BY id;

-- name: ListSignagePlaylistsByIDs :many
SELECT * FROM signage_playlists WHERE id = ANY(sqlc.arg(ids)::text[]::uuid[]) ORDER BY id;

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
  AND (a.all_displays OR EXISTS (SELECT 1 FROM signage_announcement_displays ad WHERE ad.announcement_id = a.id AND ad.display_id = sqlc.arg(display_id)))
ORDER BY a.starts_at, a.id;
