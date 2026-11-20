-- +goose Up
-- Tickets and to-dos of working groups. A ticket is a problem, request or question that anyone with
-- working_groups.read writes for a group; the group plans it into one of its columns and closes it. A to-do is a task
-- of the group, visible to its members and to management only. Comments hang on either.
--
-- People are referenced with ON DELETE SET NULL: when a person is deleted their tickets, to-dos and comments stay and
-- show a former member. Followers are only a link and go with the person.
CREATE TABLE working_group_columns (
    id uuid PRIMARY KEY,
    group_id uuid NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 40),
    position integer NOT NULL CHECK (position >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, group_id)
);

CREATE UNIQUE INDEX working_group_columns_name_ci_idx ON working_group_columns (group_id, lower(name));
CREATE INDEX working_group_columns_position_idx ON working_group_columns (group_id, position);

-- Every group starts with the columns "To do" and "In progress".
-- +goose StatementBegin
INSERT INTO working_group_columns (id, group_id, name, position)
SELECT uuidv7(), g.id, c.name, c.position
FROM working_groups g
CROSS JOIN (VALUES ('To do', 0), ('In progress', 1)) AS c(name, position);
-- +goose StatementEnd

CREATE TABLE working_group_tickets (
    id uuid PRIMARY KEY,
    group_id uuid NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,
    machine_id uuid REFERENCES machines(id) ON DELETE SET NULL,
    kind text NOT NULL CHECK (kind IN ('problem', 'request', 'question')),
    subject text NOT NULL CHECK (subject = btrim(subject) AND subject <> '' AND length(subject) <= 120),
    body text NOT NULL DEFAULT '' CHECK (length(body) <= 2000),
    blocks_use boolean NOT NULL DEFAULT false,
    author_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'planned', 'done', 'declined')),
    assignee_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
    due_on date,
    column_id uuid,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    closed_at timestamptz,
    -- A column of this very group; not checked while the ticket has no column.
    FOREIGN KEY (column_id, group_id) REFERENCES working_group_columns (id, group_id),
    -- Assignee, due date and column only exist while a ticket is planned.
    CHECK ((status = 'planned') = (column_id IS NOT NULL)),
    CHECK (status = 'planned' OR (assignee_person_id IS NULL AND due_on IS NULL)),
    CHECK ((status IN ('done', 'declined')) = (closed_at IS NOT NULL))
);

CREATE INDEX working_group_tickets_group_idx ON working_group_tickets (group_id, status, created_at DESC);
CREATE INDEX working_group_tickets_created_idx ON working_group_tickets (created_at DESC, id DESC);
CREATE INDEX working_group_tickets_author_idx ON working_group_tickets (author_person_id) WHERE author_person_id IS NOT NULL;
CREATE INDEX working_group_tickets_assignee_idx ON working_group_tickets (assignee_person_id) WHERE assignee_person_id IS NOT NULL;
CREATE INDEX working_group_tickets_column_idx ON working_group_tickets (column_id) WHERE column_id IS NOT NULL;
CREATE INDEX working_group_tickets_machine_idx ON working_group_tickets (machine_id) WHERE machine_id IS NOT NULL;

CREATE TABLE working_group_ticket_followers (
    ticket_id uuid NOT NULL REFERENCES working_group_tickets(id) ON DELETE CASCADE,
    person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (ticket_id, person_id)
);

CREATE INDEX working_group_ticket_followers_person_idx ON working_group_ticket_followers (person_id);

CREATE TABLE working_group_todos (
    id uuid PRIMARY KEY,
    group_id uuid NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,
    title text NOT NULL CHECK (title = btrim(title) AND title <> '' AND length(title) <= 160),
    assignee_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
    due_on date NOT NULL,
    column_id uuid NOT NULL,
    repeat_every_days integer CHECK (repeat_every_days IS NULL OR repeat_every_days BETWEEN 1 AND 730),
    done_at timestamptz,
    created_by_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (column_id, group_id) REFERENCES working_group_columns (id, group_id)
);

CREATE INDEX working_group_todos_group_idx ON working_group_todos (group_id, done_at, due_on);
CREATE INDEX working_group_todos_assignee_idx ON working_group_todos (assignee_person_id) WHERE assignee_person_id IS NOT NULL;
CREATE INDEX working_group_todos_creator_idx ON working_group_todos (created_by_person_id) WHERE created_by_person_id IS NOT NULL;
CREATE INDEX working_group_todos_column_idx ON working_group_todos (column_id);

-- One table for the comments of tickets and of to-dos. Comments of to-dos are always internal.
CREATE TABLE working_group_comments (
    id uuid PRIMARY KEY,
    ticket_id uuid REFERENCES working_group_tickets(id) ON DELETE CASCADE,
    todo_id uuid REFERENCES working_group_todos(id) ON DELETE CASCADE,
    author_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
    text text NOT NULL CHECK (text = btrim(text) AND text <> '' AND length(text) <= 2000),
    internal boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (num_nonnulls(ticket_id, todo_id) = 1),
    CHECK (ticket_id IS NOT NULL OR internal)
);

CREATE INDEX working_group_comments_ticket_idx ON working_group_comments (ticket_id, created_at) WHERE ticket_id IS NOT NULL;
CREATE INDEX working_group_comments_todo_idx ON working_group_comments (todo_id, created_at) WHERE todo_id IS NOT NULL;
CREATE INDEX working_group_comments_author_idx ON working_group_comments (author_person_id) WHERE author_person_id IS NOT NULL;

-- +goose Down
-- Deletes all tickets, to-dos, comments, followers and columns of every working group.
DROP TABLE working_group_comments;
DROP TABLE working_group_todos;
DROP TABLE working_group_ticket_followers;
DROP TABLE working_group_tickets;
DROP TABLE working_group_columns;
