-- +goose Up
-- Budget and purchases of the working groups.
--
-- A budget period has a total from HTU, a share per group and, once closed, is read-only. A purchase belongs to a
-- group and to the period that was open when it was requested; "self" purchases are bought by the requester who gets
-- the money back against a receipt, "central" purchases go into a collective order. Money is numeric(20,2) euros.
-- Person references are SET NULL; periods are never deleted (RESTRICT); a deleted group takes its purchases,
-- bookings and shares with it (the application deletes the stored files).
--
-- working_group_finances.manage is registered in application code and granted to nobody here: master holds it and
-- other roles get it through the roles UI.
CREATE TABLE working_group_budget_periods (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 80),
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    total_amount numeric(20,2) NOT NULL CHECK (total_amount >= 0),
    closed_at timestamptz,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_on >= starts_on)
);

CREATE INDEX working_group_budget_periods_open_idx ON working_group_budget_periods (starts_on DESC, id) WHERE closed_at IS NULL;

CREATE TABLE working_group_budget_shares (
    period_id uuid NOT NULL REFERENCES working_group_budget_periods(id) ON DELETE RESTRICT,
    group_id uuid NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,
    amount numeric(20,2) NOT NULL CHECK (amount >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (period_id, group_id)
);

CREATE INDEX working_group_budget_shares_group_idx ON working_group_budget_shares (group_id);

-- Standing project requests ("Projektantrag") that a collective order above the project threshold may refer to.
CREATE TABLE working_group_project_requests (
    id uuid PRIMARY KEY,
    number text NOT NULL CHECK (number = btrim(number) AND number <> '' AND length(number) <= 40),
    label text NOT NULL CHECK (label = btrim(label) AND label <> '' AND length(label) <= 120),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX working_group_project_requests_number_idx ON working_group_project_requests (lower(number));

-- The single row of finance rules.
CREATE TABLE working_group_finance_rules (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    project_threshold numeric(20,2) NOT NULL DEFAULT 100.00 CHECK (project_threshold >= 0),
    offers_threshold numeric(20,2) NOT NULL DEFAULT 500.00 CHECK (offers_threshold >= 0),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO working_group_finance_rules (singleton) VALUES (true);

CREATE TABLE working_group_purchase_orders (
    id uuid PRIMARY KEY,
    period_id uuid NOT NULL REFERENCES working_group_budget_periods(id) ON DELETE RESTRICT,
    shop text NOT NULL CHECK (shop = btrim(shop) AND shop <> '' AND length(shop) <= 120),
    total_amount numeric(20,2) NOT NULL CHECK (total_amount >= 0),
    status text NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered', 'arrived')),
    project_request_id uuid REFERENCES working_group_project_requests(id) ON DELETE SET NULL,
    project_number text CHECK (project_number IS NULL OR (project_number <> '' AND length(project_number) <= 40)),
    invoice_file_id uuid UNIQUE REFERENCES files(id) ON DELETE SET NULL,
    arrived_at timestamptz,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((status = 'arrived') = (arrived_at IS NOT NULL))
);

CREATE INDEX working_group_purchase_orders_created_idx ON working_group_purchase_orders (created_at DESC, id DESC);
CREATE INDEX working_group_purchase_orders_period_idx ON working_group_purchase_orders (period_id);
CREATE INDEX working_group_purchase_orders_project_idx ON working_group_purchase_orders (project_request_id) WHERE project_request_id IS NOT NULL;

CREATE TABLE working_group_purchases (
    id uuid PRIMARY KEY,
    group_id uuid NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,
    period_id uuid NOT NULL REFERENCES working_group_budget_periods(id) ON DELETE RESTRICT,
    item text NOT NULL CHECK (item = btrim(item) AND item <> '' AND length(item) <= 160),
    link text CHECK (link IS NULL OR (link = btrim(link) AND link LIKE 'https://%' AND length(link) <= 300)),
    quantity integer NOT NULL CHECK (quantity >= 1),
    unit_price numeric(20,2) NOT NULL CHECK (unit_price >= 0),
    how text NOT NULL CHECK (how IN ('self', 'central')),
    requester_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'wanted' CHECK (status IN ('wanted', 'approved', 'declined', 'ordered', 'received', 'bought', 'refunded')),
    decline_reason text CHECK (decline_reason IS NULL OR (decline_reason = btrim(decline_reason) AND decline_reason <> '' AND length(decline_reason) <= 200)),
    attachment_file_id uuid UNIQUE REFERENCES files(id) ON DELETE SET NULL,
    receipt_file_id uuid UNIQUE REFERENCES files(id) ON DELETE SET NULL,
    receipt_amount numeric(20,2) CHECK (receipt_amount IS NULL OR receipt_amount >= 0),
    order_id uuid REFERENCES working_group_purchase_orders(id) ON DELETE RESTRICT,
    approved_at timestamptz,
    declined_at timestamptz,
    ordered_at timestamptz,
    received_at timestamptz,
    bought_at timestamptz,
    refunded_at timestamptz,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    -- Which states a way of buying passes through.
    CHECK ((how = 'self' AND status IN ('wanted', 'approved', 'declined', 'bought', 'refunded'))
        OR (how = 'central' AND status IN ('wanted', 'approved', 'declined', 'ordered', 'received'))),
    -- The receipt exists from bought on (the file may be gone after anonymization), the order from ordered on.
    CHECK ((status IN ('bought', 'refunded')) = (receipt_amount IS NOT NULL)),
    CHECK (receipt_file_id IS NULL OR status IN ('bought', 'refunded')),
    CHECK ((status IN ('ordered', 'received')) = (order_id IS NOT NULL)),
    CHECK (decline_reason IS NULL OR status = 'declined')
);

CREATE INDEX working_group_purchases_group_idx ON working_group_purchases (group_id, period_id, created_at DESC, id DESC);
CREATE INDEX working_group_purchases_period_status_idx ON working_group_purchases (period_id, status);
CREATE INDEX working_group_purchases_created_idx ON working_group_purchases (created_at DESC, id DESC);
CREATE INDEX working_group_purchases_requester_idx ON working_group_purchases (requester_person_id) WHERE requester_person_id IS NOT NULL;
CREATE INDEX working_group_purchases_order_idx ON working_group_purchases (order_id) WHERE order_id IS NOT NULL;

CREATE TABLE working_group_bookings (
    id uuid PRIMARY KEY,
    group_id uuid NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,
    period_id uuid NOT NULL REFERENCES working_group_budget_periods(id) ON DELETE RESTRICT,
    text text NOT NULL CHECK (text = btrim(text) AND text <> '' AND length(text) <= 160),
    amount numeric(20,2) NOT NULL CHECK (amount >= 0),
    booked_on date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX working_group_bookings_group_idx ON working_group_bookings (group_id, period_id, created_at DESC, id DESC);
CREATE INDEX working_group_bookings_period_idx ON working_group_bookings (period_id);

-- +goose Down
-- Destructive: every budget period, share, purchase (with the links to its files), collective order, direct
-- booking, standing project request and the finance rules are deleted. The files themselves stay in file storage.
DROP TABLE working_group_bookings;
DROP TABLE working_group_purchases;
DROP TABLE working_group_purchase_orders;
DROP TABLE working_group_finance_rules;
DROP TABLE working_group_project_requests;
DROP TABLE working_group_budget_shares;
DROP TABLE working_group_budget_periods;
