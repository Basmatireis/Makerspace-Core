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
INSERT INTO working_group_status_changes (id, group_id, machine_id, place_id, status, changed_at)
VALUES (sqlc.arg(id), sqlc.arg(group_id), sqlc.narg(machine_id), sqlc.narg(place_id), sqlc.arg(status), sqlc.arg(changed_at));

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

-- Budget and purchases. Money is carried as exact decimal text between the database and the application:
-- parameters are cast from text, numeric columns are read as text.

-- name: IsMemberOfAnyWorkingGroup :one
SELECT EXISTS (SELECT 1 FROM working_group_members WHERE person_id = sqlc.arg(person_id));

-- name: ListWorkingGroupBudgetPeriods :many
SELECT id, name, starts_on, ends_on, total_amount::text AS total_amount, closed_at, version, created_at
FROM working_group_budget_periods
ORDER BY starts_on DESC, id DESC;

-- name: GetWorkingGroupBudgetPeriod :one
SELECT id, name, starts_on, ends_on, total_amount::text AS total_amount, closed_at, version, created_at
FROM working_group_budget_periods WHERE id = sqlc.arg(id);

-- name: LockWorkingGroupBudgetPeriod :one
-- Exclusive lock for changes of the period itself (edit, close, shares).
SELECT id, closed_at, version FROM working_group_budget_periods WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: ShareLockWorkingGroupBudgetPeriod :one
-- Shared lock for everything that books into the period, so a period cannot be closed under a running change.
SELECT id, closed_at FROM working_group_budget_periods WHERE id = sqlc.arg(id) FOR SHARE;

-- name: CurrentWorkingGroupBudgetPeriod :one
-- The open period that contains today; the one that started last when several do.
SELECT id FROM working_group_budget_periods
WHERE closed_at IS NULL AND starts_on <= sqlc.arg(today)::date AND ends_on >= sqlc.arg(today)::date
ORDER BY starts_on DESC, id DESC
LIMIT 1
FOR SHARE;

-- name: CreateWorkingGroupBudgetPeriod :exec
INSERT INTO working_group_budget_periods (id, name, starts_on, ends_on, total_amount)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(starts_on), sqlc.arg(ends_on), sqlc.arg(total_amount)::text::numeric);

-- name: UpdateWorkingGroupBudgetPeriod :execrows
UPDATE working_group_budget_periods
SET name = sqlc.arg(name), starts_on = sqlc.arg(starts_on), ends_on = sqlc.arg(ends_on),
    total_amount = sqlc.arg(total_amount)::text::numeric, version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id);

-- name: CloseWorkingGroupBudgetPeriod :execrows
UPDATE working_group_budget_periods SET closed_at = now(), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND closed_at IS NULL;

-- name: CopyWorkingGroupBudgetShares :exec
INSERT INTO working_group_budget_shares (period_id, group_id, amount)
SELECT sqlc.arg(period_id), s.group_id, s.amount FROM working_group_budget_shares s WHERE s.period_id = sqlc.arg(source_period_id);

-- name: UpsertWorkingGroupBudgetShare :exec
INSERT INTO working_group_budget_shares (period_id, group_id, amount)
VALUES (sqlc.arg(period_id), sqlc.arg(group_id), sqlc.arg(amount)::text::numeric)
ON CONFLICT (period_id, group_id) DO UPDATE SET amount = EXCLUDED.amount, updated_at = now();

-- name: ListWorkingGroupBudgetFigures :many
-- The figures of every group (all_groups) or of the groups the caller is a member of, optionally of one group.
SELECT g.id AS group_id, g.name AS group_name,
       COALESCE(s.amount, 0)::text AS given,
       (COALESCE((SELECT sum(COALESCE(p.receipt_amount, p.quantity * p.unit_price)) FROM working_group_purchases p
                  WHERE p.group_id = g.id AND p.period_id = sqlc.arg(period_id) AND p.status IN ('ordered', 'bought', 'received', 'refunded')), 0)
        + COALESCE((SELECT sum(b.amount) FROM working_group_bookings b WHERE b.group_id = g.id AND b.period_id = sqlc.arg(period_id)), 0))::text AS spent,
       COALESCE((SELECT sum(p.quantity * p.unit_price) FROM working_group_purchases p
                 WHERE p.group_id = g.id AND p.period_id = sqlc.arg(period_id) AND p.status = 'approved'), 0)::text AS reserved
FROM working_groups g
LEFT JOIN working_group_budget_shares s ON s.group_id = g.id AND s.period_id = sqlc.arg(period_id)
WHERE (sqlc.arg(all_groups)::boolean
       OR EXISTS (SELECT 1 FROM working_group_members m WHERE m.group_id = g.id AND m.person_id = sqlc.arg(caller_person_id)))
  AND (sqlc.narg(group_id)::uuid IS NULL OR g.id = sqlc.narg(group_id))
ORDER BY lower(g.name), g.id;

-- name: GetWorkingGroupFinanceRules :one
SELECT project_threshold::text AS project_threshold, offers_threshold::text AS offers_threshold, version
FROM working_group_finance_rules WHERE singleton;

-- name: LockWorkingGroupFinanceRules :one
SELECT version FROM working_group_finance_rules WHERE singleton FOR UPDATE;

-- name: UpdateWorkingGroupFinanceRules :execrows
UPDATE working_group_finance_rules
SET project_threshold = sqlc.arg(project_threshold)::text::numeric, offers_threshold = sqlc.arg(offers_threshold)::text::numeric,
    version = version + 1, updated_at = now()
WHERE singleton;

-- name: ListWorkingGroupProjectRequests :many
SELECT id, number, label FROM working_group_project_requests ORDER BY lower(number), id;

-- name: GetWorkingGroupProjectRequest :one
SELECT id, number, label FROM working_group_project_requests WHERE id = sqlc.arg(id);

-- name: CreateWorkingGroupProjectRequest :exec
INSERT INTO working_group_project_requests (id, number, label) VALUES (sqlc.arg(id), sqlc.arg(number), sqlc.arg(label));

-- name: UpdateWorkingGroupProjectRequest :execrows
UPDATE working_group_project_requests SET number = sqlc.arg(number), label = sqlc.arg(label) WHERE id = sqlc.arg(id);

-- name: DeleteWorkingGroupProjectRequest :execrows
DELETE FROM working_group_project_requests WHERE id = sqlc.arg(id);

-- name: ListWorkingGroupPurchases :many
-- Purchases the caller may see: every one for a finance manager, otherwise those of the caller's groups.
SELECT p.id, p.group_id, g.name AS group_name, p.period_id, per.name AS period_name,
       (per.closed_at IS NOT NULL)::boolean AS period_closed,
       p.item, p.link, p.quantity, p.unit_price::text AS unit_price, (p.quantity * p.unit_price)::text AS estimated_total,
       COALESCE(p.receipt_amount::text, '')::text AS receipt_amount, p.how, p.status, p.decline_reason,
       p.requester_person_id, COALESCE(btrim(rp.first_name || ' ' || rp.last_name), '')::text AS requester_display_name,
       (p.attachment_file_id IS NOT NULL)::boolean AS has_attachment, (p.receipt_file_id IS NOT NULL)::boolean AS has_receipt,
       p.order_id, p.created_at, p.approved_at, p.declined_at, p.ordered_at, p.received_at, p.bought_at, p.refunded_at, p.version,
       EXISTS (SELECT 1 FROM working_group_members m WHERE m.group_id = p.group_id AND m.person_id = sqlc.arg(caller_person_id)) AS caller_is_member,
       EXISTS (SELECT 1 FROM working_group_members m WHERE m.group_id = p.group_id AND m.person_id = sqlc.arg(caller_person_id) AND m.is_lead) AS caller_is_lead
FROM working_group_purchases p
JOIN working_groups g ON g.id = p.group_id
JOIN working_group_budget_periods per ON per.id = p.period_id
LEFT JOIN people rp ON rp.id = p.requester_person_id
WHERE (sqlc.arg(caller_finance)::boolean
       OR EXISTS (SELECT 1 FROM working_group_members m WHERE m.group_id = p.group_id AND m.person_id = sqlc.arg(caller_person_id)))
  AND (sqlc.narg(purchase_id)::uuid IS NULL OR p.id = sqlc.narg(purchase_id))
  AND (sqlc.narg(group_id)::uuid IS NULL OR p.group_id = sqlc.narg(group_id))
  AND (sqlc.narg(period_id)::uuid IS NULL OR p.period_id = sqlc.narg(period_id))
  AND (sqlc.narg(status)::text IS NULL OR p.status = sqlc.narg(status))
ORDER BY p.created_at DESC, p.id DESC
LIMIT sqlc.arg(row_limit);

-- name: GetWorkingGroupPurchaseGroup :one
SELECT group_id FROM working_group_purchases WHERE id = sqlc.arg(id);

-- name: LockWorkingGroupPurchase :one
SELECT id, group_id, period_id, how, status, requester_person_id, version, (quantity * unit_price)::text AS estimated_total,
       attachment_file_id, receipt_file_id, order_id
FROM working_group_purchases WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: CreateWorkingGroupPurchase :exec
INSERT INTO working_group_purchases (id, group_id, period_id, item, link, quantity, unit_price, how, requester_person_id)
VALUES (sqlc.arg(id), sqlc.arg(group_id), sqlc.arg(period_id), sqlc.arg(item), sqlc.narg(link), sqlc.arg(quantity),
        sqlc.arg(unit_price)::text::numeric, sqlc.arg(how), sqlc.arg(requester_person_id));

-- name: ApproveWorkingGroupPurchase :exec
UPDATE working_group_purchases SET status = 'approved', approved_at = now(), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id);

-- name: DeclineWorkingGroupPurchase :exec
UPDATE working_group_purchases
SET status = 'declined', declined_at = now(), decline_reason = sqlc.narg(reason), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id);

-- name: ReceiveWorkingGroupPurchase :exec
UPDATE working_group_purchases SET status = 'received', received_at = now(), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id);

-- name: RefundWorkingGroupPurchase :exec
UPDATE working_group_purchases SET status = 'refunded', refunded_at = now(), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id);

-- name: HandInWorkingGroupPurchaseReceipt :exec
UPDATE working_group_purchases
SET status = 'bought', bought_at = now(), receipt_amount = sqlc.arg(amount)::text::numeric, receipt_file_id = sqlc.arg(file_id),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id);

-- name: SetWorkingGroupPurchaseAttachment :exec
UPDATE working_group_purchases SET attachment_file_id = sqlc.arg(file_id), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id);

-- name: DeleteWorkingGroupPurchase :one
DELETE FROM working_group_purchases WHERE id = sqlc.arg(id) RETURNING attachment_file_id, receipt_file_id;

-- name: ListWorkingGroupFileIDs :many
-- Every stored file of the purchases of a group, collected before the group is deleted.
SELECT attachment_file_id::uuid AS file_id FROM working_group_purchases WHERE group_id = sqlc.arg(target_group)::uuid AND attachment_file_id IS NOT NULL
UNION
SELECT receipt_file_id::uuid FROM working_group_purchases WHERE group_id = sqlc.arg(target_group)::uuid AND receipt_file_id IS NOT NULL;

-- name: LockWorkingGroupPurchasesForOrder :many
SELECT id, group_id, period_id, how, status, (quantity * unit_price)::text AS estimated_total
FROM working_group_purchases WHERE id = ANY((sqlc.arg(ids)::text[])::uuid[]) ORDER BY id FOR UPDATE;

-- name: CreateWorkingGroupPurchaseOrder :exec
INSERT INTO working_group_purchase_orders (id, period_id, shop, total_amount, project_request_id, project_number)
VALUES (sqlc.arg(id), sqlc.arg(period_id), sqlc.arg(shop), sqlc.arg(total_amount)::text::numeric,
        sqlc.narg(project_request_id), sqlc.narg(project_number));

-- name: MarkWorkingGroupPurchasesOrdered :execrows
UPDATE working_group_purchases
SET status = 'ordered', order_id = sqlc.arg(order_id), ordered_at = now(), version = version + 1, updated_at = now()
WHERE id = ANY((sqlc.arg(ids)::text[])::uuid[]);

-- name: ListWorkingGroupPurchaseOrders :many
SELECT o.id, o.period_id, o.shop, o.total_amount::text AS total_amount, o.status, o.project_request_id, o.project_number,
       (o.invoice_file_id IS NOT NULL)::boolean AS has_invoice, o.arrived_at, o.version, o.created_at
FROM working_group_purchase_orders o
WHERE (sqlc.narg(order_id)::uuid IS NULL OR o.id = sqlc.narg(order_id))
ORDER BY o.created_at DESC, o.id DESC
LIMIT sqlc.arg(row_limit);

-- name: ListWorkingGroupOrderPurchaseIDs :many
SELECT order_id::uuid AS order_id, id FROM working_group_purchases
WHERE order_id = ANY((sqlc.arg(order_ids)::text[])::uuid[]) ORDER BY created_at, id;

-- name: LockWorkingGroupPurchaseOrder :one
SELECT id, period_id, status, version, invoice_file_id FROM working_group_purchase_orders WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: MarkWorkingGroupPurchaseOrderArrived :exec
UPDATE working_group_purchase_orders SET status = 'arrived', arrived_at = now(), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id);

-- name: ReceiveWorkingGroupOrderPurchases :many
UPDATE working_group_purchases SET status = 'received', received_at = now(), version = version + 1, updated_at = now()
WHERE order_id = sqlc.arg(order_id) AND status = 'ordered'
RETURNING id;

-- name: SetWorkingGroupPurchaseOrderInvoice :exec
UPDATE working_group_purchase_orders SET invoice_file_id = sqlc.arg(file_id), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id);

-- name: CreateWorkingGroupBooking :exec
INSERT INTO working_group_bookings (id, group_id, period_id, text, amount, booked_on)
VALUES (sqlc.arg(id), sqlc.arg(group_id), sqlc.arg(period_id), sqlc.arg(text), sqlc.arg(amount)::text::numeric, sqlc.arg(booked_on));

-- name: ListWorkingGroupBookings :many
SELECT b.id, b.group_id, g.name AS group_name, b.period_id, b.text, b.amount::text AS amount, b.booked_on, b.created_at
FROM working_group_bookings b
JOIN working_groups g ON g.id = b.group_id
WHERE (sqlc.arg(caller_finance)::boolean
       OR EXISTS (SELECT 1 FROM working_group_members m WHERE m.group_id = b.group_id AND m.person_id = sqlc.arg(caller_person_id)))
  AND (sqlc.narg(booking_id)::uuid IS NULL OR b.id = sqlc.narg(booking_id))
  AND (sqlc.narg(group_id)::uuid IS NULL OR b.group_id = sqlc.narg(group_id))
  AND (sqlc.narg(period_id)::uuid IS NULL OR b.period_id = sqlc.narg(period_id))
ORDER BY b.created_at DESC, b.id DESC
LIMIT sqlc.arg(row_limit);

-- name: GetWorkingGroupBookingPeriod :one
SELECT period_id FROM working_group_bookings WHERE id = sqlc.arg(id);

-- name: DeleteWorkingGroupBooking :execrows
DELETE FROM working_group_bookings WHERE id = sqlc.arg(id);

-- name: GetWorkingGroupPurchaseFiles :one
SELECT attachment_file_id, receipt_file_id FROM working_group_purchases WHERE id = sqlc.arg(id);

-- name: GetWorkingGroupPurchaseOrderInvoice :one
SELECT invoice_file_id FROM working_group_purchase_orders WHERE id = sqlc.arg(id);
