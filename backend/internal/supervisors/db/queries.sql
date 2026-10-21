-- name: ListStaffingPeople :many
-- Everyone holding at least one role with a staffing level, with their kind (supervisor wins over trainee).
WITH current_version AS (
    SELECT id FROM laborordnung_versions
    WHERE status = 'published' AND effective_at <= now()
    ORDER BY effective_at DESC, id DESC LIMIT 1
), staffing_people AS (
    SELECT p.id, p.first_name, p.last_name, p.profile_image_file_id, p.created_at,
        CASE WHEN bool_or(designated.staffing_level = 'supervisor') THEN 'supervisor' ELSE 'trainee' END::text AS kind
    FROM people p
    JOIN person_roles pr ON pr.person_id = p.id
    JOIN roles designated ON designated.id = pr.role_id AND designated.staffing_level IS NOT NULL
    GROUP BY p.id
), modes AS (
    SELECT p.id AS person_id,
        COALESCE(max(CASE r.laborordnung_mode WHEN 'blocking' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END), 0)::integer AS mode_rank
    FROM people p
    LEFT JOIN person_roles pr ON pr.person_id = p.id
    LEFT JOIN roles r ON r.id = pr.role_id
    GROUP BY p.id
)
SELECT sp.id AS person_id, sp.first_name, sp.last_name, sp.kind, sp.created_at AS member_since,
    (sp.profile_image_file_id IS NOT NULL)::boolean AS has_profile_image,
    CASE
      WHEN m.mode_rank = 0 THEN 'not_required'
      WHEN NOT EXISTS (SELECT 1 FROM current_version) THEN 'no_published_version'
      WHEN EXISTS (
          SELECT 1 FROM laborordnung_requests lr, current_version cv
          WHERE lr.person_id = sp.id AND lr.status = 'completed' AND lr.required_version_id = cv.id
      ) THEN 'current'
      ELSE 'outdated'
    END::text AS laborordnung_state
FROM staffing_people sp
JOIN modes m ON m.person_id = sp.id
ORDER BY lower(sp.last_name), lower(sp.first_name), sp.id;
