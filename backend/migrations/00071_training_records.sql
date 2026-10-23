-- +goose Up
-- Competency categories are what may be shown publicly ("3D printing"); trainings are the internal course types that
-- feed them. A person's training record says whether they are trained or may train others; no record means not trained.
CREATE TABLE competency_categories (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 120),
    description text CHECK (description IS NULL OR length(description) <= 2000),
    active boolean NOT NULL DEFAULT true,
    sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN -10000 AND 10000),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX competency_categories_name_ci_idx ON competency_categories (lower(name));

CREATE TABLE trainings (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 150),
    description text CHECK (description IS NULL OR length(description) <= 2000),
    active boolean NOT NULL DEFAULT true,
    sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN -10000 AND 10000),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX trainings_name_ci_idx ON trainings (lower(name));

CREATE TABLE training_competencies (
    training_id uuid NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
    competency_id uuid NOT NULL REFERENCES competency_categories(id) ON DELETE RESTRICT,
    PRIMARY KEY (training_id, competency_id)
);

CREATE INDEX training_competencies_competency_idx ON training_competencies (competency_id, training_id);

CREATE TABLE training_machine_types (
    training_id uuid NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
    machine_type_id uuid NOT NULL REFERENCES machine_types(id) ON DELETE CASCADE,
    PRIMARY KEY (training_id, machine_type_id)
);

CREATE INDEX training_machine_types_machine_type_idx ON training_machine_types (machine_type_id, training_id);

CREATE TABLE training_records (
    person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    training_id uuid NOT NULL REFERENCES trainings(id) ON DELETE RESTRICT,
    status text NOT NULL CHECK (status IN ('trained', 'trainer')),
    completed_on date,
    notes text CHECK (notes IS NULL OR length(notes) <= 2000),
    recorded_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (person_id, training_id)
);

CREATE INDEX training_records_training_idx ON training_records (training_id, person_id);

-- +goose Down
DROP TABLE training_records;
DROP TABLE training_machine_types;
DROP TABLE training_competencies;
DROP TABLE trainings;
DROP TABLE competency_categories;
