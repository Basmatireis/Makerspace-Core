-- +goose Up
CREATE TABLE machine_types (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 120),
    active boolean NOT NULL DEFAULT true,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX machine_types_name_ci_idx ON machine_types (lower(name));

CREATE TABLE machines (
    id uuid PRIMARY KEY,
    machine_type_id uuid NOT NULL REFERENCES machine_types(id) ON DELETE RESTRICT,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 150),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'maintenance', 'retired')),
    external_identifier text CHECK (external_identifier IS NULL OR (external_identifier = btrim(external_identifier) AND external_identifier <> '' AND length(external_identifier) <= 200)),
    automatic_collection_enabled boolean NOT NULL DEFAULT false,
    last_ingested_at timestamptz,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (automatic_collection_enabled OR external_identifier IS NULL)
);

CREATE UNIQUE INDEX machines_name_ci_idx ON machines (lower(name));
CREATE UNIQUE INDEX machines_external_identifier_idx ON machines (external_identifier) WHERE external_identifier IS NOT NULL;
CREATE INDEX machines_type_status_idx ON machines (machine_type_id, status, id);

CREATE TABLE organizations (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 200),
    kind text NOT NULL CHECK (kind IN ('company', 'institute', 'association', 'other')),
    active boolean NOT NULL DEFAULT true,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX organizations_name_ci_idx ON organizations (lower(name));

CREATE TABLE pricing_groups (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 120),
    description text CHECK (description IS NULL OR length(description) <= 500),
    active boolean NOT NULL DEFAULT true,
    is_default boolean NOT NULL DEFAULT false,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX pricing_groups_name_ci_idx ON pricing_groups (lower(name));
CREATE UNIQUE INDEX pricing_groups_single_default_idx ON pricing_groups (is_default) WHERE is_default;

CREATE TABLE person_pricing_group_assignments (
    person_id uuid PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
    pricing_group_id uuid NOT NULL REFERENCES pricing_groups(id) ON DELETE RESTRICT,
    assigned_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX person_pricing_group_assignments_group_idx ON person_pricing_group_assignments (pricing_group_id, person_id);

CREATE TABLE organization_pricing_group_assignments (
    organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    pricing_group_id uuid NOT NULL REFERENCES pricing_groups(id) ON DELETE RESTRICT,
    assigned_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX organization_pricing_group_assignments_group_idx ON organization_pricing_group_assignments (pricing_group_id, organization_id);

CREATE TABLE pricing_rules (
    id uuid PRIMARY KEY,
    pricing_group_id uuid NOT NULL REFERENCES pricing_groups(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('machine_runtime', 'material')),
    machine_type_id uuid REFERENCES machine_types(id) ON DELETE RESTRICT,
    material_category text CHECK (material_category IS NULL OR (material_category = lower(btrim(material_category)) AND material_category <> '' AND length(material_category) <= 100)),
    material_unit text CHECK (material_unit IS NULL OR material_unit IN ('g', 'm', 'ml', 'm2', 'piece')),
    rate numeric(20, 6) NOT NULL CHECK (rate >= 0),
    active boolean NOT NULL DEFAULT true,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (kind = 'machine_runtime' AND machine_type_id IS NOT NULL AND material_category IS NULL AND material_unit IS NULL)
        OR
        (kind = 'material' AND machine_type_id IS NULL AND material_category IS NOT NULL AND material_unit IS NOT NULL)
    )
);

CREATE UNIQUE INDEX pricing_rules_active_runtime_idx
    ON pricing_rules (pricing_group_id, machine_type_id)
    WHERE active AND kind = 'machine_runtime';
CREATE UNIQUE INDEX pricing_rules_active_material_idx
    ON pricing_rules (pricing_group_id, material_category, material_unit)
    WHERE active AND kind = 'material';
CREATE INDEX pricing_rules_group_idx ON pricing_rules (pricing_group_id, active, kind, id);

CREATE TABLE materials (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 150),
    category text NOT NULL CHECK (category = lower(btrim(category)) AND category <> '' AND length(category) <= 100),
    color text CHECK (color IS NULL OR (color = btrim(color) AND color <> '' AND length(color) <= 80)),
    unit text NOT NULL CHECK (unit IN ('g', 'm', 'ml', 'm2', 'piece')),
    active boolean NOT NULL DEFAULT true,
    low_stock_threshold numeric(20, 6) CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX materials_name_ci_idx ON materials (lower(name));
CREATE INDEX materials_category_active_idx ON materials (category, active, id);

CREATE TABLE material_balances (
    material_id uuid PRIMARY KEY REFERENCES materials(id) ON DELETE CASCADE,
    quantity numeric(20, 6) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    inventory_value numeric(20, 6) NOT NULL DEFAULT 0 CHECK (inventory_value >= 0),
    average_unit_cost numeric(20, 6) NOT NULL DEFAULT 0 CHECK (average_unit_cost >= 0),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE material_balances;
DROP TABLE materials;
DROP TABLE pricing_rules;
DROP TABLE organization_pricing_group_assignments;
DROP TABLE person_pricing_group_assignments;
DROP TABLE pricing_groups;
DROP TABLE organizations;
DROP TABLE machines;
DROP TABLE machine_types;
