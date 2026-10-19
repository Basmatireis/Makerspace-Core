-- +goose Up
-- Roles map to pricing groups. A person is priced by the mapped group of their highest-priority
-- role (larger number wins). This replaces the per-person pricing group assignment, which is dropped;
-- explicit groups on a job and organization groups stay.
CREATE TABLE role_pricing_groups (
 role_id uuid PRIMARY KEY REFERENCES roles(id) ON DELETE CASCADE,
 pricing_group_id uuid NOT NULL REFERENCES pricing_groups(id) ON DELETE RESTRICT,
 priority integer NOT NULL CHECK(priority>0),
 updated_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT role_pricing_groups_priority_key UNIQUE(priority)
);
CREATE INDEX role_pricing_groups_group_idx ON role_pricing_groups(pricing_group_id);
DROP TABLE person_pricing_group_assignments;

-- +goose Down
CREATE TABLE person_pricing_group_assignments (
    person_id uuid PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
    pricing_group_id uuid NOT NULL REFERENCES pricing_groups(id) ON DELETE RESTRICT,
    assigned_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX person_pricing_group_assignments_group_idx ON person_pricing_group_assignments (pricing_group_id, person_id);
DROP TABLE role_pricing_groups;
