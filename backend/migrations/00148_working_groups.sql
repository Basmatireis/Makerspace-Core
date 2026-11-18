-- +goose Up
-- A working group is a team of members that looks after machines and places of the makerspace: one lead, any number
-- of members, the machines it looks after (a machine belongs to at most one group) and free-text places without a
-- machine. A person may be a member of several groups.
--
-- working_groups.read goes to every role except master and the Visitor membership role (master derives every
-- registered permission from application code and has no grants). working_groups.manage is granted to nobody here:
-- master holds it automatically, other roles get it through the roles UI.
CREATE TABLE working_groups (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 80),
    description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
    chat_url text CHECK (chat_url IS NULL OR (chat_url = btrim(chat_url) AND chat_url LIKE 'https://%' AND length(chat_url) <= 300)),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX working_groups_name_ci_idx ON working_groups (lower(name));

CREATE TABLE working_group_members (
    group_id uuid NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,
    person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    is_lead boolean NOT NULL DEFAULT false,
    joined_at timestamptz NOT NULL,
    PRIMARY KEY (group_id, person_id)
);

CREATE UNIQUE INDEX working_group_members_one_lead_idx ON working_group_members (group_id) WHERE is_lead;
CREATE INDEX working_group_members_person_idx ON working_group_members (person_id, group_id);

CREATE TABLE working_group_machines (
    group_id uuid NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,
    machine_id uuid NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, machine_id),
    UNIQUE (machine_id)
);

CREATE TABLE working_group_places (
    id uuid PRIMARY KEY,
    group_id uuid NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 80),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX working_group_places_name_ci_idx ON working_group_places (group_id, lower(name));

-- +goose StatementBegin
INSERT INTO role_permission_grants (id, role_id, permission_id, scope, minimum_assurance)
SELECT uuidv7(), r.id, 'working_groups.read', 'global', 'low'
FROM roles r
WHERE r.system_key IS DISTINCT FROM 'master' AND r.system_key IS DISTINCT FROM 'visitor'
  AND NOT EXISTS (
      SELECT 1 FROM role_permission_grants g
      WHERE g.role_id = r.id AND g.permission_id = 'working_groups.read' AND g.scope = 'global'
  );
-- +goose StatementEnd

-- +goose Down
DELETE FROM role_permission_grants WHERE permission_id IN ('working_groups.read', 'working_groups.manage');
DELETE FROM master_reauthentication_permissions WHERE permission_id IN ('working_groups.read', 'working_groups.manage');
DROP TABLE working_group_places;
DROP TABLE working_group_machines;
DROP TABLE working_group_members;
DROP TABLE working_groups;
