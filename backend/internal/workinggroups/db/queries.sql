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
       ) AS is_lead,
       (SELECT count(*) FROM working_group_tickets t WHERE t.group_id = g.id AND t.status IN ('new', 'planned'))::bigint AS open_ticket_count,
       (SELECT count(*) FROM working_group_todos d WHERE d.group_id = g.id AND d.done_at IS NULL)::bigint AS open_todo_count
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
       ) AS is_lead,
       (SELECT count(*) FROM working_group_tickets t WHERE t.group_id = g.id AND t.status IN ('new', 'planned'))::bigint AS open_ticket_count,
       (SELECT count(*) FROM working_group_todos d WHERE d.group_id = g.id AND d.done_at IS NULL)::bigint AS open_todo_count
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
SELECT mc.id, mc.name, wm.status, wm.status_note, wm.status_until, wm.status_changed_at,
       wm.status_changed_by AS changed_by_person_id,
       COALESCE(btrim(cp.first_name || ' ' || cp.last_name), '')::text AS changed_by_display_name
FROM working_group_machines wm
JOIN machines mc ON mc.id = wm.machine_id
LEFT JOIN people cp ON cp.id = wm.status_changed_by
WHERE wm.group_id = sqlc.arg(group_id)
ORDER BY lower(mc.name), mc.id;

-- name: ListWorkingGroupPlaces :many
SELECT pl.id, pl.name, pl.status, pl.status_note, pl.status_until, pl.status_changed_at,
       pl.status_changed_by AS changed_by_person_id,
       COALESCE(btrim(cp.first_name || ' ' || cp.last_name), '')::text AS changed_by_display_name
FROM working_group_places pl
LEFT JOIN people cp ON cp.id = pl.status_changed_by
WHERE pl.group_id = sqlc.arg(group_id)
ORDER BY lower(pl.name), pl.id;

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

-- name: DeleteWorkingGroupMachine :exec
DELETE FROM working_group_machines WHERE group_id = sqlc.arg(group_id) AND machine_id = sqlc.arg(machine_id);

-- name: DeleteWorkingGroupMachineStatusChanges :exec
-- A machine that leaves its group starts again at ok, without history.
DELETE FROM working_group_status_changes WHERE group_id = sqlc.arg(group_id) AND machine_id = sqlc.arg(machine_id);

-- name: AddWorkingGroupMachine :exec
INSERT INTO working_group_machines (group_id, machine_id) VALUES (sqlc.arg(group_id), sqlc.arg(machine_id));

-- name: AddWorkingGroupPlace :exec
INSERT INTO working_group_places (id, group_id, name) VALUES (sqlc.arg(id), sqlc.arg(group_id), sqlc.arg(name));

-- name: DeleteWorkingGroupPlace :execrows
DELETE FROM working_group_places WHERE id = sqlc.arg(id) AND group_id = sqlc.arg(group_id);

-- name: IsWorkingGroupMember :one
SELECT EXISTS (
    SELECT 1 FROM working_group_members WHERE group_id = sqlc.arg(group_id) AND person_id = sqlc.arg(person_id)
);

-- name: MachineBelongsToWorkingGroup :one
SELECT EXISTS (
    SELECT 1 FROM working_group_machines WHERE group_id = sqlc.arg(group_id) AND machine_id = sqlc.arg(machine_id)
);

-- name: ClearWorkingGroupTicketAssignments :exec
-- A person who leaves a group no longer carries its tickets and to-dos.
UPDATE working_group_tickets SET assignee_person_id = NULL, version = version + 1, updated_at = now()
WHERE group_id = sqlc.arg(group_id) AND assignee_person_id = sqlc.arg(person_id);

-- name: ClearWorkingGroupTodoAssignments :exec
UPDATE working_group_todos SET assignee_person_id = NULL, version = version + 1, updated_at = now()
WHERE group_id = sqlc.arg(group_id) AND assignee_person_id = sqlc.arg(person_id);

-- name: ListWorkingGroupColumns :many
SELECT id, name FROM working_group_columns WHERE group_id = sqlc.arg(group_id) ORDER BY position, id;

-- name: InsertWorkingGroupColumn :exec
INSERT INTO working_group_columns (id, group_id, name, position)
VALUES (sqlc.arg(id), sqlc.arg(group_id), sqlc.arg(name), sqlc.arg(position));

-- name: ParkWorkingGroupColumnName :exec
-- Gives a column a name nobody else can want, so renames and swaps never meet the unique name index halfway.
UPDATE working_group_columns SET name = id::text WHERE id = sqlc.arg(id) AND group_id = sqlc.arg(group_id);

-- name: UpdateWorkingGroupColumn :exec
UPDATE working_group_columns SET name = sqlc.arg(name), position = sqlc.arg(position)
WHERE id = sqlc.arg(id) AND group_id = sqlc.arg(group_id);

-- name: MoveWorkingGroupTicketsToColumn :exec
UPDATE working_group_tickets SET column_id = sqlc.arg(to_column_id), version = version + 1, updated_at = now()
WHERE group_id = sqlc.arg(group_id) AND column_id = sqlc.arg(from_column_id);

-- name: MoveWorkingGroupTodosToColumn :exec
UPDATE working_group_todos SET column_id = sqlc.arg(to_column_id), version = version + 1, updated_at = now()
WHERE group_id = sqlc.arg(group_id) AND column_id = sqlc.arg(from_column_id);

-- name: DeleteWorkingGroupColumn :exec
DELETE FROM working_group_columns WHERE id = sqlc.arg(id) AND group_id = sqlc.arg(group_id);

-- name: GetWorkingGroupTicketCore :one
SELECT id, group_id, machine_id, status, author_person_id, assignee_person_id, due_on, column_id, version
FROM working_group_tickets WHERE id = sqlc.arg(id);

-- name: CreateWorkingGroupTicket :exec
INSERT INTO working_group_tickets (id, group_id, machine_id, kind, subject, body, blocks_use, author_person_id)
VALUES (sqlc.arg(id), sqlc.arg(group_id), sqlc.narg(machine_id), sqlc.arg(kind), sqlc.arg(subject), sqlc.arg(body),
        sqlc.arg(blocks_use), sqlc.arg(author_person_id));

-- name: SetWorkingGroupTicketState :execrows
UPDATE working_group_tickets
SET status = sqlc.arg(status),
    assignee_person_id = sqlc.narg(assignee_person_id),
    due_on = sqlc.narg(due_on)::date,
    column_id = sqlc.narg(column_id),
    closed_at = CASE WHEN sqlc.arg(status)::text IN ('done', 'declined') THEN now() ELSE NULL END,
    version = version + 1,
    updated_at = now()
WHERE id = sqlc.arg(id);

-- name: ListWorkingGroupTickets :many
-- One query for the list and the single ticket: id, group and status are optional filters.
SELECT t.id, t.group_id, g.name AS group_name, t.machine_id, mc.name AS machine_name, t.kind, t.subject, t.body,
       t.blocks_use, t.status,
       t.author_person_id, COALESCE(btrim(author.first_name || ' ' || author.last_name), '')::text AS author_name,
       t.assignee_person_id, COALESCE(btrim(assignee.first_name || ' ' || assignee.last_name), '')::text AS assignee_name,
       t.due_on, t.column_id,
       (SELECT count(*) FROM working_group_ticket_followers f WHERE f.ticket_id = t.id)::bigint AS follower_count,
       EXISTS (
           SELECT 1 FROM working_group_ticket_followers f
           WHERE f.ticket_id = t.id AND f.person_id = sqlc.arg(caller_person_id)
       ) AS is_following,
       COALESCE(t.author_person_id = sqlc.arg(caller_person_id) OR t.assignee_person_id = sqlc.arg(caller_person_id), false)::boolean AS is_mine,
       (SELECT count(*) FROM working_group_comments c
        WHERE c.ticket_id = t.id AND (NOT c.internal OR sqlc.arg(caller_manage)::boolean OR EXISTS (
            SELECT 1 FROM working_group_members me WHERE me.group_id = t.group_id AND me.person_id = sqlc.arg(caller_person_id)
        )))::bigint AS comment_count,
       (sqlc.arg(caller_manage)::boolean OR EXISTS (
           SELECT 1 FROM working_group_members me WHERE me.group_id = t.group_id AND me.person_id = sqlc.arg(caller_person_id)
       ))::boolean AS inside,
       t.version, t.created_at, t.updated_at, t.closed_at
FROM working_group_tickets t
JOIN working_groups g ON g.id = t.group_id
LEFT JOIN machines mc ON mc.id = t.machine_id
LEFT JOIN people author ON author.id = t.author_person_id
LEFT JOIN people assignee ON assignee.id = t.assignee_person_id
WHERE (sqlc.narg(id)::uuid IS NULL OR t.id = sqlc.narg(id)::uuid)
  AND (sqlc.narg(group_id)::uuid IS NULL OR t.group_id = sqlc.narg(group_id)::uuid)
  AND (sqlc.narg(status)::text IS NULL OR t.status = sqlc.narg(status)::text)
ORDER BY (t.status IN ('done', 'declined')), t.created_at DESC, t.id DESC
LIMIT sqlc.arg(row_limit);

-- name: DeleteWorkingGroupTicket :execrows
DELETE FROM working_group_tickets WHERE id = sqlc.arg(id);

-- name: DeleteWorkingGroupTicketComment :execrows
DELETE FROM working_group_comments WHERE id = sqlc.arg(id) AND ticket_id = sqlc.arg(ticket_id);

-- name: DeleteWorkingGroupTodoComment :execrows
DELETE FROM working_group_comments WHERE id = sqlc.arg(id) AND todo_id = sqlc.arg(todo_id);

-- name: OpenWorkingGroupTodoSuccessorExists :one
-- Whether an open to-do with the same group, title and repeat interval exists besides the one just done.
SELECT EXISTS (
    SELECT 1 FROM working_group_todos
    WHERE group_id = sqlc.arg(group_id) AND title = sqlc.arg(title) AND repeat_every_days = sqlc.arg(repeat_every_days)::integer
      AND done_at IS NULL AND id <> sqlc.arg(id)
);

-- name: ListWorkingGroupTicketFollowers :many
SELECT f.person_id, COALESCE(btrim(p.first_name || ' ' || p.last_name), '')::text AS display_name
FROM working_group_ticket_followers f
JOIN people p ON p.id = f.person_id
WHERE f.ticket_id = sqlc.arg(ticket_id)
ORDER BY f.created_at, f.person_id;

-- name: AddWorkingGroupTicketFollower :execrows
INSERT INTO working_group_ticket_followers (ticket_id, person_id) VALUES (sqlc.arg(ticket_id), sqlc.arg(person_id))
ON CONFLICT DO NOTHING;

-- name: DeleteWorkingGroupTicketFollower :execrows
DELETE FROM working_group_ticket_followers WHERE ticket_id = sqlc.arg(ticket_id) AND person_id = sqlc.arg(person_id);

-- name: AddWorkingGroupComment :exec
INSERT INTO working_group_comments (id, ticket_id, todo_id, author_person_id, text, internal)
VALUES (sqlc.arg(id), sqlc.narg(ticket_id), sqlc.narg(todo_id), sqlc.arg(author_person_id), sqlc.arg(text), sqlc.arg(internal));

-- name: ListWorkingGroupTicketComments :many
SELECT c.id, c.author_person_id, COALESCE(btrim(p.first_name || ' ' || p.last_name), '')::text AS author_name, c.text, c.internal, c.created_at
FROM working_group_comments c
LEFT JOIN people p ON p.id = c.author_person_id
WHERE c.ticket_id = sqlc.arg(ticket_id) AND (NOT c.internal OR sqlc.arg(include_internal)::boolean)
ORDER BY c.created_at, c.id;

-- name: ListWorkingGroupTodoComments :many
SELECT c.id, c.author_person_id, COALESCE(btrim(p.first_name || ' ' || p.last_name), '')::text AS author_name, c.text, c.internal, c.created_at
FROM working_group_comments c
LEFT JOIN people p ON p.id = c.author_person_id
WHERE c.todo_id = sqlc.arg(todo_id)
ORDER BY c.created_at, c.id;

-- name: GetWorkingGroupTodoCore :one
SELECT id, group_id, title, assignee_person_id, due_on, column_id, repeat_every_days, done_at, version
FROM working_group_todos WHERE id = sqlc.arg(id);

-- name: CreateWorkingGroupTodo :exec
INSERT INTO working_group_todos (id, group_id, title, assignee_person_id, due_on, column_id, repeat_every_days, created_by_person_id)
VALUES (sqlc.arg(id), sqlc.arg(group_id), sqlc.arg(title), sqlc.narg(assignee_person_id), sqlc.arg(due_on)::date,
        sqlc.arg(column_id), sqlc.narg(repeat_every_days)::integer, sqlc.narg(created_by_person_id));

-- name: UpdateWorkingGroupTodo :execrows
UPDATE working_group_todos
SET title = sqlc.arg(title),
    assignee_person_id = sqlc.narg(assignee_person_id),
    due_on = sqlc.arg(due_on)::date,
    column_id = sqlc.arg(column_id),
    repeat_every_days = sqlc.narg(repeat_every_days)::integer,
    version = version + 1,
    updated_at = now()
WHERE id = sqlc.arg(id);

-- name: SetWorkingGroupTodoDone :execrows
UPDATE working_group_todos
SET done_at = CASE WHEN sqlc.arg(done)::boolean THEN now() ELSE NULL END, version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id);

-- name: DeleteWorkingGroupTodo :execrows
DELETE FROM working_group_todos WHERE id = sqlc.arg(id);

-- name: ListWorkingGroupTodos :many
-- To-dos exist only for people inside the group (a member or working_groups.manage); everybody else gets no rows.
SELECT t.id, t.group_id, g.name AS group_name, t.title,
       t.assignee_person_id, COALESCE(btrim(assignee.first_name || ' ' || assignee.last_name), '')::text AS assignee_name,
       t.created_by_person_id, COALESCE(btrim(creator.first_name || ' ' || creator.last_name), '')::text AS creator_name,
       t.due_on, t.column_id, t.repeat_every_days, t.done_at,
       COALESCE(t.assignee_person_id = sqlc.arg(caller_person_id), false)::boolean AS is_mine,
       (SELECT count(*) FROM working_group_comments c WHERE c.todo_id = t.id)::bigint AS comment_count,
       t.version, t.created_at, t.updated_at
FROM working_group_todos t
JOIN working_groups g ON g.id = t.group_id
LEFT JOIN people assignee ON assignee.id = t.assignee_person_id
LEFT JOIN people creator ON creator.id = t.created_by_person_id
WHERE (sqlc.arg(caller_manage)::boolean OR EXISTS (
          SELECT 1 FROM working_group_members me WHERE me.group_id = t.group_id AND me.person_id = sqlc.arg(caller_person_id)
      ))
  AND (sqlc.narg(id)::uuid IS NULL OR t.id = sqlc.narg(id)::uuid)
  AND (sqlc.narg(group_id)::uuid IS NULL OR t.group_id = sqlc.narg(group_id)::uuid)
ORDER BY (t.done_at IS NOT NULL), t.due_on, t.created_at, t.id
LIMIT sqlc.arg(row_limit);

-- name: ListWorkingGroupNotes :many
SELECT n.id, n.group_id, COALESCE(g.name, '')::text AS group_name, n.is_public, n.text, n.created_at,
       n.author_person_id, COALESCE(btrim(ap.first_name || ' ' || ap.last_name), '')::text AS author_display_name,
       (COALESCE(n.author_person_id = sqlc.arg(caller_person_id)::uuid, false)
           OR sqlc.arg(caller_manage)::boolean
           OR EXISTS (SELECT 1 FROM working_group_members le
                      WHERE le.group_id = n.group_id AND le.person_id = sqlc.arg(caller_person_id)::uuid AND le.is_lead)) AS can_delete
FROM working_group_notes n
LEFT JOIN working_groups g ON g.id = n.group_id
LEFT JOIN people ap ON ap.id = n.author_person_id
WHERE (n.group_id IS NULL OR n.is_public OR sqlc.arg(caller_manage)::boolean
       OR EXISTS (SELECT 1 FROM working_group_members me WHERE me.group_id = n.group_id AND me.person_id = sqlc.arg(caller_person_id)::uuid))
  AND (sqlc.narg(group_id)::uuid IS NULL OR n.group_id = sqlc.narg(group_id)::uuid)
ORDER BY n.created_at DESC, n.id DESC
LIMIT sqlc.arg(row_limit);

-- name: GetWorkingGroupNote :one
SELECT n.id, n.group_id, COALESCE(g.name, '')::text AS group_name, n.is_public, n.text, n.created_at,
       n.author_person_id, COALESCE(btrim(ap.first_name || ' ' || ap.last_name), '')::text AS author_display_name,
       (COALESCE(n.author_person_id = sqlc.arg(caller_person_id)::uuid, false)
           OR sqlc.arg(caller_manage)::boolean
           OR EXISTS (SELECT 1 FROM working_group_members le
                      WHERE le.group_id = n.group_id AND le.person_id = sqlc.arg(caller_person_id)::uuid AND le.is_lead)) AS can_delete
FROM working_group_notes n
LEFT JOIN working_groups g ON g.id = n.group_id
LEFT JOIN people ap ON ap.id = n.author_person_id
WHERE n.id = sqlc.arg(id);

-- name: GetWorkingGroupNoteCore :one
SELECT group_id, is_public, author_person_id FROM working_group_notes WHERE id = sqlc.arg(id);

-- name: CreateWorkingGroupNote :exec
INSERT INTO working_group_notes (id, group_id, is_public, text, author_person_id)
VALUES (sqlc.arg(id), sqlc.narg(group_id), sqlc.arg(is_public), sqlc.arg(text), sqlc.arg(author_person_id));

-- name: DeleteWorkingGroupNote :execrows
DELETE FROM working_group_notes WHERE id = sqlc.arg(id);

-- name: GetWorkingGroupMachineStatus :one
SELECT status, status_note, status_until FROM working_group_machines
WHERE group_id = sqlc.arg(group_id) AND machine_id = sqlc.arg(machine_id);

-- name: GetWorkingGroupPlaceStatus :one
SELECT status, status_note, status_until FROM working_group_places
WHERE group_id = sqlc.arg(group_id) AND id = sqlc.arg(place_id);

-- name: SetWorkingGroupMachineStatus :execrows
UPDATE working_group_machines
SET status = sqlc.arg(status), status_note = sqlc.narg(status_note), status_until = sqlc.narg(status_until),
    status_changed_at = sqlc.arg(changed_at), status_changed_by = sqlc.arg(changed_by)
WHERE group_id = sqlc.arg(group_id) AND machine_id = sqlc.arg(machine_id);

-- name: SetWorkingGroupPlaceStatus :execrows
UPDATE working_group_places
SET status = sqlc.arg(status), status_note = sqlc.narg(status_note), status_until = sqlc.narg(status_until),
    status_changed_at = sqlc.arg(changed_at), status_changed_by = sqlc.arg(changed_by)
WHERE group_id = sqlc.arg(group_id) AND id = sqlc.arg(place_id);

-- name: InsertWorkingGroupStatusChange :exec
INSERT INTO working_group_status_changes (id, group_id, machine_id, place_id, status, changed_at, changed_by_person_id)
VALUES (sqlc.arg(id), sqlc.arg(group_id), sqlc.narg(machine_id), sqlc.narg(place_id), sqlc.arg(status),
        sqlc.arg(changed_at), sqlc.arg(changed_by_person_id));

-- name: ListWorkingGroupItemStatuses :many
SELECT 'machine'::text AS kind, mc.id AS item_id, mc.name AS item_name, g.id AS group_id, g.name AS group_name,
       wm.status, wm.status_note, wm.status_until, wm.status_changed_at,
       wm.status_changed_by AS changed_by_person_id,
       COALESCE(btrim(cp.first_name || ' ' || cp.last_name), '')::text AS changed_by_display_name
FROM working_group_machines wm
JOIN machines mc ON mc.id = wm.machine_id
JOIN working_groups g ON g.id = wm.group_id
LEFT JOIN people cp ON cp.id = wm.status_changed_by
UNION ALL
SELECT 'place'::text, pl.id, pl.name, g.id, g.name,
       pl.status, pl.status_note, pl.status_until, pl.status_changed_at,
       pl.status_changed_by,
       COALESCE(btrim(cp.first_name || ' ' || cp.last_name), '')::text
FROM working_group_places pl
JOIN working_groups g ON g.id = pl.group_id
LEFT JOIN people cp ON cp.id = pl.status_changed_by;

-- name: ListWorkingGroupStatusChangesSince :many
SELECT COALESCE(machine_id, place_id)::uuid AS item_id, status, changed_at
FROM working_group_status_changes
WHERE changed_at >= sqlc.arg(window_start)::timestamptz
ORDER BY changed_at, id;

-- name: ListWorkingGroupStatusBaselines :many
-- The last change before the window of every item: the status the window starts with.
SELECT DISTINCT ON (COALESCE(machine_id, place_id)) COALESCE(machine_id, place_id)::uuid AS item_id, status, changed_at
FROM working_group_status_changes
WHERE changed_at < sqlc.arg(window_start)::timestamptz
ORDER BY COALESCE(machine_id, place_id), changed_at DESC, id DESC;
