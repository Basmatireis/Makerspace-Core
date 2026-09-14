-- +goose Up
CREATE TABLE open_day_periods (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 150),
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'staffing', 'published', 'archived')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (starts_on <= ends_on)
);

CREATE INDEX open_day_periods_dates_idx ON open_day_periods (starts_on DESC, ends_on DESC, id);

CREATE TABLE open_days (
    id uuid PRIMARY KEY,
    period_id uuid NOT NULL REFERENCES open_day_periods(id) ON DELETE CASCADE,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    internal_note text CHECK (internal_note IS NULL OR length(internal_note) <= 2000),
    status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (starts_at < ends_at)
);

CREATE INDEX open_days_period_time_idx ON open_days (period_id, starts_at, id);
CREATE UNIQUE INDEX open_days_exact_scheduled_slot_idx
    ON open_days (period_id, starts_at, ends_at)
    WHERE status = 'scheduled';

CREATE TABLE open_day_staff_requirements (
    id uuid PRIMARY KEY,
    open_day_id uuid NOT NULL REFERENCES open_days(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('supervisor', 'trainee')),
    required_count integer NOT NULL CHECK (required_count >= 0 AND required_count <= 100),
    UNIQUE (open_day_id, kind),
    UNIQUE (id, open_day_id)
);

CREATE TABLE open_day_staff_requirement_roles (
    requirement_id uuid NOT NULL REFERENCES open_day_staff_requirements(id) ON DELETE CASCADE,
    role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (requirement_id, role_id)
);

CREATE INDEX open_day_staff_requirement_roles_role_idx
    ON open_day_staff_requirement_roles (role_id, requirement_id);

CREATE TABLE open_day_assignments (
    id uuid PRIMARY KEY,
    open_day_id uuid NOT NULL REFERENCES open_days(id) ON DELETE CASCADE,
    requirement_id uuid NOT NULL,
    person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    created_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (requirement_id, open_day_id)
        REFERENCES open_day_staff_requirements(id, open_day_id) ON DELETE CASCADE,
    UNIQUE (open_day_id, person_id)
);

CREATE INDEX open_day_assignments_requirement_idx
    ON open_day_assignments (requirement_id, created_at, id);
CREATE INDEX open_day_assignments_person_idx
    ON open_day_assignments (person_id, open_day_id);

CREATE TABLE open_day_academic_breaks (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 150),
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (starts_on <= ends_on)
);

CREATE INDEX open_day_academic_breaks_dates_idx
    ON open_day_academic_breaks (starts_on, ends_on, id);

-- +goose Down
DROP TABLE open_day_academic_breaks;
DROP TABLE open_day_assignments;
DROP TABLE open_day_staff_requirement_roles;
DROP TABLE open_day_staff_requirements;
DROP TABLE open_days;
DROP TABLE open_day_periods;
