-- name: ListWorkingGroups :many
SELECT g.id, g.name, g.description,
       lead.person_id AS lead_person_id,
       btrim(lead_person.first_name || ' ' || lead_person.last_name)::text AS lead_display_name,
       (SELECT count(*) FROM working_group_members m WHERE m.group_id = g.id)::bigint AS member_count,
       (SELECT count(*) FROM working_group_machines wm WHERE wm.group_id = g.id)::bigint AS machine_count,
       EXISTS (
           SELECT 1 FROM working_group_members me WHERE me.group_id = g.id AND me.person_id = sqlc.arg(caller_person_id)
       ) AS is_member,
       EXISTS (
           SELECT 1 FROM working_group_members me
           WHERE me.group_id = g.id AND me.person_id = sqlc.arg(caller_person_id) AND me.is_lead
       ) AS is_lead
FROM working_groups g
LEFT JOIN working_group_members lead ON lead.group_id = g.id AND lead.is_lead
LEFT JOIN people lead_person ON lead_person.id = lead.person_id
ORDER BY lower(g.name), g.id;

-- name: GetWorkingGroup :one
SELECT g.id, g.name, g.description, g.chat_url, g.version,
       lead.person_id AS lead_person_id,
       btrim(lead_person.first_name || ' ' || lead_person.last_name)::text AS lead_display_name,
       (SELECT count(*) FROM working_group_members m WHERE m.group_id = g.id)::bigint AS member_count,
       (SELECT count(*) FROM working_group_machines wm WHERE wm.group_id = g.id)::bigint AS machine_count,
       EXISTS (
           SELECT 1 FROM working_group_members me WHERE me.group_id = g.id AND me.person_id = sqlc.arg(caller_person_id)
       ) AS is_member,
       EXISTS (
           SELECT 1 FROM working_group_members me
           WHERE me.group_id = g.id AND me.person_id = sqlc.arg(caller_person_id) AND me.is_lead
       ) AS is_lead
FROM working_groups g
LEFT JOIN working_group_members lead ON lead.group_id = g.id AND lead.is_lead
LEFT JOIN people lead_person ON lead_person.id = lead.person_id
WHERE g.id = sqlc.arg(id);

-- name: LockWorkingGroup :one
-- Locks the group row; every mutation takes it first so lead and membership changes of one group are serialized.
SELECT id, name, description, chat_url, version FROM working_groups WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: CreateWorkingGroup :exec
INSERT INTO working_groups (id, name, description) VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(description));

-- name: UpdateWorkingGroup :execrows
UPDATE working_groups
SET name = COALESCE(sqlc.narg(name)::text, name),
    description = COALESCE(sqlc.narg(description)::text, description),
    chat_url = CASE WHEN sqlc.arg(set_chat_url)::boolean THEN sqlc.narg(chat_url)::text ELSE chat_url END,
    version = version + 1,
    updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version);

-- name: DeleteWorkingGroup :execrows
DELETE FROM working_groups WHERE id = sqlc.arg(id);

-- name: ListWorkingGroupMembers :many
SELECT m.person_id, btrim(p.first_name || ' ' || p.last_name)::text AS display_name, m.is_lead, m.joined_at
FROM working_group_members m
JOIN people p ON p.id = m.person_id
WHERE m.group_id = sqlc.arg(group_id)
ORDER BY m.is_lead DESC, lower(p.last_name), lower(p.first_name), m.person_id;

-- name: ListWorkingGroupMachines :many
SELECT mc.id, mc.name
FROM working_group_machines wm
JOIN machines mc ON mc.id = wm.machine_id
WHERE wm.group_id = sqlc.arg(group_id)
ORDER BY lower(mc.name), mc.id;

-- name: ListWorkingGroupPlaces :many
SELECT id, name FROM working_group_places WHERE group_id = sqlc.arg(group_id) ORDER BY lower(name), id;

-- name: IsWorkingGroupLead :one
SELECT EXISTS (
    SELECT 1 FROM working_group_members WHERE group_id = sqlc.arg(group_id) AND person_id = sqlc.arg(person_id) AND is_lead
);

-- name: LeadsAnyWorkingGroup :one
SELECT EXISTS (SELECT 1 FROM working_group_members WHERE person_id = sqlc.arg(person_id) AND is_lead);

-- name: PersonExists :one
SELECT EXISTS (SELECT 1 FROM people WHERE id = sqlc.arg(id));

-- name: GetWorkingGroupMember :one
SELECT person_id, is_lead FROM working_group_members
WHERE group_id = sqlc.arg(group_id) AND person_id = sqlc.arg(person_id);

-- name: AddWorkingGroupMember :exec
INSERT INTO working_group_members (group_id, person_id, is_lead, joined_at)
VALUES (sqlc.arg(group_id), sqlc.arg(person_id), sqlc.arg(is_lead), sqlc.arg(joined_at));

-- name: DeleteWorkingGroupMember :execrows
DELETE FROM working_group_members WHERE group_id = sqlc.arg(group_id) AND person_id = sqlc.arg(person_id);

-- name: ClearWorkingGroupLead :exec
UPDATE working_group_members SET is_lead = false WHERE group_id = sqlc.arg(group_id) AND is_lead;

-- name: MarkWorkingGroupLead :exec
UPDATE working_group_members SET is_lead = true WHERE group_id = sqlc.arg(group_id) AND person_id = sqlc.arg(person_id);

-- name: FindWorkingGroupPeople :many
SELECT p.id, btrim(p.first_name || ' ' || p.last_name)::text AS display_name
FROM people p
WHERE (sqlc.arg(search)::text = ''
       OR lower(p.first_name || ' ' || p.last_name) LIKE '%' || lower(sqlc.arg(search)::text) || '%')
  AND NOT EXISTS (
      SELECT 1 FROM person_roles pr JOIN roles r ON r.id = pr.role_id
      WHERE pr.person_id = p.id AND r.system_key = 'visitor'
  )
ORDER BY p.last_name, p.first_name, p.id
LIMIT sqlc.arg(page_limit);

-- name: IsVisitorPerson :one
SELECT EXISTS (
    SELECT 1 FROM person_roles pr JOIN roles r ON r.id = pr.role_id
    WHERE pr.person_id = sqlc.arg(person_id) AND r.system_key = 'visitor'
);

-- name: ListWorkingGroupMachineOptions :many
SELECT mc.id, mc.name, wm.group_id AS working_group_id, g.name AS working_group_name
FROM machines mc
LEFT JOIN working_group_machines wm ON wm.machine_id = mc.id
LEFT JOIN working_groups g ON g.id = wm.group_id
ORDER BY lower(mc.name), mc.id;

-- name: ListExistingMachineIDs :many
SELECT id FROM machines WHERE id = ANY(sqlc.arg(ids)::uuid[]);

-- name: ListMachineGroupAssignments :many
SELECT machine_id, group_id FROM working_group_machines WHERE machine_id = ANY(sqlc.arg(ids)::uuid[]);

-- name: DeleteWorkingGroupMachines :exec
DELETE FROM working_group_machines WHERE group_id = sqlc.arg(group_id);

-- name: AddWorkingGroupMachine :exec
INSERT INTO working_group_machines (group_id, machine_id) VALUES (sqlc.arg(group_id), sqlc.arg(machine_id));

-- name: AddWorkingGroupPlace :exec
INSERT INTO working_group_places (id, group_id, name) VALUES (sqlc.arg(id), sqlc.arg(group_id), sqlc.arg(name));

-- name: DeleteWorkingGroupPlace :execrows
DELETE FROM working_group_places WHERE id = sqlc.arg(id) AND group_id = sqlc.arg(group_id);
