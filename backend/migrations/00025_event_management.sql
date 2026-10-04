-- +goose Up
CREATE TABLE events (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (btrim(name) <> ''),
    internal_description text,
    location text,
    owner_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'planning', 'confirmed', 'completed', 'cancelled', 'archived')),
    public_title text,
    public_description text,
    public_location text,
    public_id text NOT NULL UNIQUE CHECK (public_id ~ '^[A-Za-z0-9_-]{43}$'),
    is_public boolean NOT NULL DEFAULT false,
    public_signup_enabled boolean NOT NULL DEFAULT false,
    closed_at timestamptz,
    created_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (public_title IS NULL OR btrim(public_title) <> ''),
    CHECK (closed_at IS NULL OR status IN ('completed', 'cancelled', 'archived')),
    CHECK (status NOT IN ('completed', 'cancelled', 'archived') OR closed_at IS NOT NULL),
    CHECK (status <> 'archived' OR NOT is_public)
);

CREATE INDEX events_status_updated_idx ON events (status, updated_at DESC, id);
CREATE INDEX events_owner_idx ON events (owner_person_id, updated_at DESC) WHERE owner_person_id IS NOT NULL;

CREATE TABLE event_sessions (
    id uuid PRIMARY KEY,
    event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name text,
    location text,
    description text,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    is_public boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, event_id),
    CHECK (name IS NULL OR btrim(name) <> ''),
    CHECK (ends_at > starts_at)
);

CREATE INDEX event_sessions_event_time_idx ON event_sessions (event_id, starts_at, id);
CREATE INDEX event_sessions_public_idx ON event_sessions (event_id, starts_at, id) WHERE is_public AND status = 'scheduled';

CREATE TABLE event_task_lists (
    id uuid PRIMARY KEY,
    event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (btrim(name) <> ''),
    description text,
    sort_order integer NOT NULL DEFAULT 0,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, event_id)
);

CREATE INDEX event_task_lists_event_sort_idx ON event_task_lists (event_id, sort_order, id);

CREATE TABLE event_tasks (
    id uuid PRIMARY KEY,
    event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    task_list_id uuid,
    title text NOT NULL CHECK (btrim(title) <> ''),
    description text,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'blocked', 'done', 'cancelled')),
    priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    assignee_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
    due_at timestamptz,
    completed_at timestamptz,
    completed_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    sort_order integer NOT NULL DEFAULT 0,
    created_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (task_list_id, event_id) REFERENCES event_task_lists(id, event_id) ON DELETE SET NULL (task_list_id),
    CHECK ((status = 'done') = (completed_at IS NOT NULL)),
    CHECK (status = 'done' OR completed_by_account_id IS NULL)
);

CREATE INDEX event_tasks_event_status_due_idx ON event_tasks (event_id, status, due_at, id);
CREATE INDEX event_tasks_assignee_idx ON event_tasks (assignee_person_id, due_at, id) WHERE assignee_person_id IS NOT NULL;
CREATE INDEX event_tasks_list_sort_idx ON event_tasks (event_id, task_list_id, sort_order, id);

CREATE TABLE event_shifts (
    id uuid PRIMARY KEY,
    event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    session_id uuid,
    name text NOT NULL CHECK (btrim(name) <> ''),
    description text,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    signup_opens_at timestamptz,
    signup_closes_at timestamptz,
    is_public boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed', 'cancelled')),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, event_id),
    FOREIGN KEY (session_id, event_id) REFERENCES event_sessions(id, event_id) ON DELETE SET NULL (session_id),
    CHECK (ends_at > starts_at),
    CHECK (signup_closes_at IS NULL OR signup_opens_at IS NULL OR signup_closes_at > signup_opens_at)
);

CREATE INDEX event_shifts_event_time_idx ON event_shifts (event_id, starts_at, id);
CREATE INDEX event_shifts_public_idx ON event_shifts (event_id, starts_at, id) WHERE is_public AND status = 'open';

CREATE TABLE event_shift_requirements (
    id uuid PRIMARY KEY,
    event_id uuid NOT NULL,
    shift_id uuid NOT NULL,
    name text NOT NULL CHECK (btrim(name) <> ''),
    description text,
    required_count integer NOT NULL CHECK (required_count BETWEEN 1 AND 1000),
    eligibility_mode text NOT NULL DEFAULT 'anyone' CHECK (eligibility_mode IN ('anyone', 'roles')),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, shift_id),
    UNIQUE (id, event_id),
    FOREIGN KEY (shift_id, event_id) REFERENCES event_shifts(id, event_id) ON DELETE CASCADE
);

CREATE INDEX event_shift_requirements_shift_idx ON event_shift_requirements (shift_id, id);
CREATE UNIQUE INDEX event_shift_requirements_name_unique_idx ON event_shift_requirements (shift_id, lower(name));

CREATE TABLE event_shift_requirement_roles (
    requirement_id uuid NOT NULL REFERENCES event_shift_requirements(id) ON DELETE CASCADE,
    role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (requirement_id, role_id)
);

CREATE INDEX event_shift_requirement_roles_role_idx ON event_shift_requirement_roles (role_id, requirement_id);

CREATE TABLE event_shift_assignments (
    id uuid PRIMARY KEY,
    event_id uuid NOT NULL,
    shift_id uuid NOT NULL,
    requirement_id uuid NOT NULL,
    person_id uuid REFERENCES people(id) ON DELETE CASCADE,
    first_name_snapshot text,
    last_name_snapshot text,
    email_snapshot text,
    email_normalized text,
    phone_snapshot text,
    phone_normalized text,
    source text NOT NULL CHECK (source IN ('public_signup', 'authenticated_self', 'authenticated_on_behalf', 'staff_entry')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
    created_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    management_token_digest bytea,
    conflict_overridden_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    cancelled_at timestamptz,
    cancelled_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    personal_data_erased_at timestamptz,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (shift_id, event_id) REFERENCES event_shifts(id, event_id) ON DELETE CASCADE,
    FOREIGN KEY (requirement_id, shift_id) REFERENCES event_shift_requirements(id, shift_id) ON DELETE RESTRICT,
    CHECK (email_normalized IS NULL OR email_snapshot IS NOT NULL),
    CHECK (phone_normalized IS NULL OR phone_snapshot IS NOT NULL),
    CHECK (
        (personal_data_erased_at IS NULL AND first_name_snapshot IS NOT NULL AND last_name_snapshot IS NOT NULL AND btrim(first_name_snapshot) <> '' AND btrim(last_name_snapshot) <> '' AND (email_normalized IS NOT NULL OR phone_normalized IS NOT NULL))
        OR
        (personal_data_erased_at IS NOT NULL AND first_name_snapshot IS NULL AND last_name_snapshot IS NULL AND email_snapshot IS NULL AND email_normalized IS NULL AND phone_snapshot IS NULL AND phone_normalized IS NULL AND management_token_digest IS NULL)
    ),
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
    CHECK (status = 'cancelled' OR cancelled_by_account_id IS NULL)
);

CREATE INDEX event_shift_assignments_requirement_active_idx ON event_shift_assignments (requirement_id, id) WHERE status = 'active';
CREATE INDEX event_shift_assignments_shift_active_idx ON event_shift_assignments (shift_id, id) WHERE status = 'active';
CREATE INDEX event_shift_assignments_person_active_idx ON event_shift_assignments (person_id, shift_id, id) WHERE status = 'active' AND person_id IS NOT NULL;
CREATE INDEX event_shift_assignments_email_idx ON event_shift_assignments (email_normalized, id) WHERE email_normalized IS NOT NULL;
CREATE INDEX event_shift_assignments_phone_idx ON event_shift_assignments (phone_normalized, id) WHERE phone_normalized IS NOT NULL;
CREATE UNIQUE INDEX event_shift_assignments_active_person_unique_idx ON event_shift_assignments (shift_id, person_id) WHERE status = 'active' AND person_id IS NOT NULL;
CREATE UNIQUE INDEX event_shift_assignments_active_email_unique_idx ON event_shift_assignments (shift_id, email_normalized) WHERE status = 'active' AND email_normalized IS NOT NULL;
CREATE UNIQUE INDEX event_shift_assignments_active_phone_unique_idx ON event_shift_assignments (shift_id, phone_normalized) WHERE status = 'active' AND phone_normalized IS NOT NULL;
CREATE UNIQUE INDEX event_shift_assignments_token_unique_idx ON event_shift_assignments (management_token_digest) WHERE management_token_digest IS NOT NULL;

CREATE TABLE event_files (
    id uuid PRIMARY KEY,
    event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    file_id uuid NOT NULL UNIQUE REFERENCES files(id) ON DELETE RESTRICT,
    description text,
    visibility text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'public')),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX event_files_event_visibility_idx ON event_files (event_id, visibility, created_at, id);

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM events LIMIT 1) THEN
        RAISE EXCEPTION 'cannot drop Event Management tables while Event data exists';
    END IF;
END $$;
-- +goose StatementEnd

DROP TABLE event_files;
DROP TABLE event_shift_assignments;
DROP TABLE event_shift_requirement_roles;
DROP TABLE event_shift_requirements;
DROP TABLE event_shifts;
DROP TABLE event_tasks;
DROP TABLE event_task_lists;
DROP TABLE event_sessions;
DROP TABLE events;
