-- name: ListOpenPeriods :many
SELECT id, name, status
FROM open_day_periods
WHERE status IN ('staffing', 'published')
ORDER BY starts_on, id;

-- name: ListSupervisors :many
WITH current_version AS (
    SELECT id FROM laborordnung_versions
    WHERE status = 'published' AND effective_at <= now()
    ORDER BY effective_at DESC, id DESC LIMIT 1
), supervisor_people AS (
    SELECT DISTINCT p.id, p.first_name, p.last_name, p.profile_image_file_id
    FROM people p
    JOIN accounts a ON a.person_id = p.id
    JOIN account_roles ar ON ar.account_id = a.id
    JOIN roles designated ON designated.id = ar.role_id AND designated.supervisor_dashboard
), modes AS (
    SELECT a.person_id,
        COALESCE(max(CASE r.laborordnung_mode WHEN 'blocking' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END), 0)::integer AS mode_rank
    FROM accounts a
    LEFT JOIN account_roles ar ON ar.account_id = a.id
    LEFT JOIN roles r ON r.id = ar.role_id
    GROUP BY a.person_id
)
SELECT sp.id AS person_id, sp.first_name, sp.last_name,
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
FROM supervisor_people sp
JOIN modes m ON m.person_id = sp.id
ORDER BY lower(sp.last_name), lower(sp.first_name), sp.id;

-- name: ListSupervisorAssignmentCounts :many
SELECT a.person_id, p.id AS period_id, count(*)::bigint AS assignment_count
FROM open_day_assignments a
JOIN open_days d ON d.id = a.open_day_id AND d.status = 'scheduled'
JOIN open_day_periods p ON p.id = d.period_id AND p.status IN ('staffing', 'published')
JOIN open_day_staff_requirements r ON r.id = a.requirement_id AND r.kind = 'supervisor'
GROUP BY a.person_id, p.id
ORDER BY a.person_id, p.id;
