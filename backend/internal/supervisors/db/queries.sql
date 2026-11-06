-- name: ListStaffingPeople :many
-- Everyone with the supervisor or trainee membership, with the names of their extra roles.
WITH current_version AS (
    SELECT id FROM laborordnung_versions
    WHERE status = 'published' AND effective_at <= now()
    ORDER BY effective_at DESC, id DESC LIMIT 1
), staffing_people AS (
    SELECT p.id, p.version, p.first_name, p.last_name, p.profile_image_file_id, p.member_since,
        membership.system_key AS membership
    FROM people p
    JOIN person_roles mp ON mp.person_id = p.id
    JOIN roles membership ON membership.id = mp.role_id AND membership.system_key IN ('supervisor', 'trainee')
), modes AS (
    SELECT p.id AS person_id,
        COALESCE(max(CASE r.laborordnung_mode WHEN 'blocking' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END), 0)::integer AS mode_rank
    FROM people p
    LEFT JOIN person_roles pr ON pr.person_id = p.id
    LEFT JOIN roles r ON r.id = pr.role_id
    GROUP BY p.id
)
SELECT sp.id AS person_id, sp.version AS person_version, sp.first_name, sp.last_name, sp.membership::text AS membership,
    sp.member_since,
    (sp.profile_image_file_id IS NOT NULL)::boolean AS has_profile_image,
    COALESCE((
        SELECT array_agg(r.name ORDER BY lower(r.name), r.id)
        FROM person_roles pr JOIN roles r ON r.id = pr.role_id
        WHERE pr.person_id = sp.id AND r.system_key IS NULL
    ), '{}')::text[] AS extra_roles,
    CASE
      WHEN m.mode_rank = 0 THEN 'not_required'
      WHEN NOT EXISTS (SELECT 1 FROM current_version) THEN 'no_published_version'
      WHEN EXISTS (
          SELECT 1 FROM laborordnung_confirmations lc, current_version cv
          WHERE lc.person_id = sp.id AND lc.version_id = cv.id
      ) THEN 'current'
      ELSE 'outdated'
    END::text AS laborordnung_state
FROM staffing_people sp
JOIN modes m ON m.person_id = sp.id
ORDER BY lower(sp.last_name), lower(sp.first_name), sp.id;
