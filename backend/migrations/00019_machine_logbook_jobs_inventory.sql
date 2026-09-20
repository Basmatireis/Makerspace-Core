-- +goose Up
CREATE SEQUENCE machine_job_display_sequence;

CREATE TABLE machine_jobs (
    id uuid PRIMARY KEY,
    display_id text NOT NULL UNIQUE CHECK (display_id ~ '^J-[0-9]{4}-[0-9]{6,}$'),
    machine_id uuid NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    source text NOT NULL CHECK (source IN ('manual', 'automatic')),
    external_id text CHECK (external_id IS NULL OR (external_id = btrim(external_id) AND external_id <> '' AND length(external_id) <= 200)),
    external_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(external_metadata) = 'object' AND octet_length(external_metadata::text) <= 16384),
    review_state text NOT NULL CHECK (review_state IN ('needs_review', 'confirmed')),
    customer_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
    customer_organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
    operator_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
    outcome text NOT NULL CHECK (outcome IN ('successful', 'partial_failure', 'failed', 'cancelled', 'unknown')),
    notes text CHECK (notes IS NULL OR length(notes) <= 2000),
    pricing_status text NOT NULL DEFAULT 'pending' CHECK (pricing_status IN ('pending', 'complete', 'incomplete')),
    calculated_price numeric(20, 2) CHECK (calculated_price IS NULL OR calculated_price >= 0),
    final_price numeric(20, 2) CHECK (final_price IS NULL OR final_price >= 0),
    price_override_reason text CHECK (price_override_reason IS NULL OR (price_override_reason = btrim(price_override_reason) AND price_override_reason <> '' AND length(price_override_reason) <= 500)),
    price_overridden_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    price_overridden_at timestamptz,
    billing_status text NOT NULL DEFAULT 'unbilled' CHECK (billing_status IN ('unbilled', 'billed', 'waived')),
    billing_reference text CHECK (billing_reference IS NULL OR (billing_reference = btrim(billing_reference) AND billing_reference <> '' AND length(billing_reference) <= 200)),
    active_pricing_snapshot_id uuid,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (starts_at < ends_at),
    CHECK ((customer_person_id IS NULL) OR (customer_organization_id IS NULL)),
    CHECK ((source = 'automatic' AND external_id IS NOT NULL) OR source = 'manual'),
    CHECK (
        (review_state = 'needs_review' AND source = 'automatic')
        OR review_state = 'confirmed'
    ),
    CHECK (
        (final_price IS NULL AND price_override_reason IS NULL AND price_overridden_at IS NULL)
        OR
        (final_price IS NOT NULL AND price_override_reason IS NOT NULL AND price_overridden_at IS NOT NULL)
    ),
    CHECK ((billing_status = 'billed' AND billing_reference IS NOT NULL) OR billing_status <> 'billed')
);

CREATE UNIQUE INDEX machine_jobs_automatic_external_idx
    ON machine_jobs (machine_id, external_id)
    WHERE source = 'automatic';
CREATE INDEX machine_jobs_time_idx ON machine_jobs (starts_at DESC, id DESC);
CREATE INDEX machine_jobs_review_idx ON machine_jobs (review_state, starts_at, id);
CREATE INDEX machine_jobs_machine_idx ON machine_jobs (machine_id, starts_at DESC, id);
CREATE INDEX machine_jobs_customer_person_idx ON machine_jobs (customer_person_id, starts_at DESC) WHERE customer_person_id IS NOT NULL;
CREATE INDEX machine_jobs_customer_organization_idx ON machine_jobs (customer_organization_id, starts_at DESC) WHERE customer_organization_id IS NOT NULL;
CREATE INDEX machine_jobs_operator_idx ON machine_jobs (operator_person_id, starts_at DESC) WHERE operator_person_id IS NOT NULL;
CREATE INDEX machine_jobs_billing_idx ON machine_jobs (billing_status, starts_at DESC, id);

CREATE TABLE machine_job_material_usages (
    id uuid PRIMARY KEY,
    machine_job_id uuid NOT NULL REFERENCES machine_jobs(id) ON DELETE CASCADE,
    material_id uuid NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,
    quantity numeric(20, 6) NOT NULL CHECK (quantity > 0),
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, machine_job_id)
);

CREATE INDEX machine_job_material_usages_material_idx ON machine_job_material_usages (material_id, machine_job_id);
CREATE UNIQUE INDEX machine_job_material_usages_active_material_idx
    ON machine_job_material_usages (machine_job_id, material_id)
    WHERE active;

CREATE TABLE machine_job_pricing_snapshots (
    id uuid PRIMARY KEY,
    machine_job_id uuid NOT NULL REFERENCES machine_jobs(id) ON DELETE CASCADE,
    revision integer NOT NULL CHECK (revision > 0),
    pricing_group_id uuid REFERENCES pricing_groups(id) ON DELETE SET NULL,
    pricing_group_name text NOT NULL CHECK (pricing_group_name <> '' AND length(pricing_group_name) <= 120),
    currency text NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
    reason text NOT NULL CHECK (reason IN ('initial', 'customer_changed', 'machine_changed', 'manual_reprice')),
    complete boolean NOT NULL,
    calculated_amount numeric(20, 2) CHECK (calculated_amount IS NULL OR calculated_amount >= 0),
    captured_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    captured_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (machine_job_id, revision),
    UNIQUE (id, machine_job_id),
    CHECK (complete = (calculated_amount IS NOT NULL))
);

CREATE TABLE machine_job_pricing_snapshot_rules (
    id uuid PRIMARY KEY,
    snapshot_id uuid NOT NULL REFERENCES machine_job_pricing_snapshots(id) ON DELETE CASCADE,
    source_rule_id uuid REFERENCES pricing_rules(id) ON DELETE SET NULL,
    kind text NOT NULL CHECK (kind IN ('machine_runtime', 'material')),
    label text NOT NULL CHECK (label <> '' AND length(label) <= 200),
    selector text NOT NULL CHECK (selector <> '' AND length(selector) <= 200),
    unit text NOT NULL CHECK (unit IN ('hour', 'g', 'm', 'ml', 'm2', 'piece')),
    rate numeric(20, 6) CHECK (rate IS NULL OR rate >= 0),
    missing boolean NOT NULL,
    CHECK ((missing AND rate IS NULL) OR (NOT missing AND rate IS NOT NULL))
);

CREATE INDEX machine_job_pricing_snapshot_rules_snapshot_idx ON machine_job_pricing_snapshot_rules (snapshot_id, kind, id);

ALTER TABLE machine_jobs
    ADD CONSTRAINT machine_jobs_active_pricing_snapshot_fk
    FOREIGN KEY (active_pricing_snapshot_id, id)
    REFERENCES machine_job_pricing_snapshots(id, machine_job_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE inventory_transactions (
    id uuid PRIMARY KEY,
    material_id uuid NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,
    kind text NOT NULL CHECK (kind IN ('purchase', 'machine_job_consumption', 'manual_consumption', 'adjustment', 'disposal')),
    quantity_delta numeric(20, 6) NOT NULL CHECK (quantity_delta <> 0),
    unit_acquisition_cost numeric(20, 6) NOT NULL CHECK (unit_acquisition_cost >= 0),
    inventory_value_delta numeric(20, 6) NOT NULL,
    total_purchase_price numeric(20, 2) CHECK (total_purchase_price IS NULL OR total_purchase_price >= 0),
    occurred_at timestamptz NOT NULL,
    supplier text CHECK (supplier IS NULL OR length(supplier) <= 200),
    note text CHECK (note IS NULL OR length(note) <= 1000),
    adjustment_reason text CHECK (adjustment_reason IS NULL OR adjustment_reason IN ('inventory_count', 'unrecorded_consumption', 'damaged', 'disposed', 'mark_empty', 'job_corrected', 'other')),
    machine_job_usage_id uuid REFERENCES machine_job_material_usages(id) ON DELETE SET NULL,
    actor_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((kind = 'purchase' AND quantity_delta > 0 AND total_purchase_price IS NOT NULL) OR kind <> 'purchase'),
    CHECK ((kind IN ('machine_job_consumption', 'manual_consumption', 'disposal') AND quantity_delta < 0) OR kind NOT IN ('machine_job_consumption', 'manual_consumption', 'disposal')),
    CHECK ((kind = 'machine_job_consumption' AND machine_job_usage_id IS NOT NULL) OR kind <> 'machine_job_consumption'),
    CHECK ((kind IN ('adjustment', 'disposal') AND adjustment_reason IS NOT NULL) OR kind NOT IN ('adjustment', 'disposal'))
);

CREATE INDEX inventory_transactions_material_time_idx ON inventory_transactions (material_id, occurred_at DESC, id DESC);
CREATE INDEX inventory_transactions_job_usage_idx ON inventory_transactions (machine_job_usage_id, occurred_at, id) WHERE machine_job_usage_id IS NOT NULL;
CREATE INDEX inventory_transactions_kind_time_idx ON inventory_transactions (kind, occurred_at DESC, id DESC);

-- +goose Down
DROP TABLE inventory_transactions;
ALTER TABLE machine_jobs DROP CONSTRAINT machine_jobs_active_pricing_snapshot_fk;
DROP TABLE machine_job_pricing_snapshot_rules;
DROP TABLE machine_job_pricing_snapshots;
DROP TABLE machine_job_material_usages;
DROP TABLE machine_jobs;
DROP SEQUENCE machine_job_display_sequence;
