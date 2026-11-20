-- +goose Up
-- Projects of the working groups and the Projektantrag for the wiRef.
--
-- A project is a bigger plan of one group with a cost plan (items with offers). It is handed in, decided by finance
-- managers and, when the wiRef has to decide, mailed as a Projektantrag. Planned purchases belong to a project
-- (status 'planned', no figure counts them) and become 'approved' when the project starts running.
-- Person references are SET NULL; a deleted group takes its projects (the application deletes the stored files).
-- Money is numeric(20,2) euros.
-- The purchases' project reference is SET NULL, so the application must delete a project's planned purchases (and
-- their files) before it deletes the project; a deleted group takes its purchases with it.
CREATE TABLE working_group_projects (
    id uuid PRIMARY KEY,
    group_id uuid NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,
    title text NOT NULL CHECK (title = btrim(title) AND title <> '' AND length(title) <= 120),
    goal text NOT NULL DEFAULT '' CHECK (length(goal) <= 1000),
    benefit text NOT NULL DEFAULT '' CHECK (length(benefit) <= 1000),
    starts_on date,
    ends_on date,
    people integer NOT NULL DEFAULT 1 CHECK (people >= 1 AND people <= 100000),
    planned_income numeric(20,2) NOT NULL DEFAULT 0 CHECK (planned_income >= 0),
    alcohol boolean NOT NULL DEFAULT false,
    advance_requested boolean NOT NULL DEFAULT false,
    advance_amount numeric(20,2) CHECK (advance_amount IS NULL OR advance_amount >= 0),
    advance_status text CHECK (advance_status IS NULL OR advance_status IN ('asked', 'received')),
    paid_from text CHECK (paid_from IS NULL OR paid_from IN ('group', 'external')),
    wiref_number text CHECK (wiref_number IS NULL OR (wiref_number = btrim(wiref_number) AND wiref_number <> '' AND length(wiref_number) <= 40)),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'returned', 'declined', 'wiref', 'running', 'completed')),
    requester_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
    wiref_request_sent_at timestamptz,
    request_form jsonb,
    request_signature_file_id uuid UNIQUE REFERENCES files(id) ON DELETE SET NULL,
    request_pdf_file_id uuid UNIQUE REFERENCES files(id) ON DELETE SET NULL,
    -- Who signed the request: the signature image belongs to this person.
    request_signed_by uuid REFERENCES people(id) ON DELETE SET NULL,
    completion_report text CHECK (completion_report IS NULL OR length(completion_report) <= 2000),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on),
    CHECK (status NOT IN ('wiref', 'running', 'completed') OR paid_from IS NOT NULL)
);

CREATE INDEX working_group_projects_group_idx ON working_group_projects (group_id, created_at DESC, id DESC);
CREATE INDEX working_group_projects_status_idx ON working_group_projects (status, created_at DESC, id DESC);
CREATE INDEX working_group_projects_signed_by_idx ON working_group_projects (request_signed_by) WHERE request_signed_by IS NOT NULL;
CREATE INDEX working_group_projects_requester_idx ON working_group_projects (requester_person_id) WHERE requester_person_id IS NOT NULL;

CREATE TABLE working_group_project_items (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES working_group_projects(id) ON DELETE CASCADE,
    position integer NOT NULL CHECK (position >= 0),
    text text NOT NULL CHECK (text = btrim(text) AND text <> '' AND length(text) <= 160),
    planned_amount numeric(20,2) NOT NULL CHECK (planned_amount >= 0),
    link text CHECK (link IS NULL OR (link LIKE 'https://%' AND length(link) <= 300)),
    note text CHECK (note IS NULL OR length(note) <= 500),
    chosen_offer_id uuid,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX working_group_project_items_project_idx ON working_group_project_items (project_id, position, id);
CREATE INDEX working_group_project_items_chosen_offer_idx ON working_group_project_items (chosen_offer_id) WHERE chosen_offer_id IS NOT NULL;

CREATE TABLE working_group_project_offers (
    id uuid PRIMARY KEY,
    item_id uuid NOT NULL REFERENCES working_group_project_items(id) ON DELETE CASCADE,
    shop text NOT NULL CHECK (shop = btrim(shop) AND shop <> '' AND length(shop) <= 80),
    price numeric(20,2) NOT NULL CHECK (price >= 0),
    file_id uuid UNIQUE REFERENCES files(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX working_group_project_offers_item_idx ON working_group_project_offers (item_id, created_at, id);

ALTER TABLE working_group_project_items
    ADD CONSTRAINT working_group_project_items_chosen_offer_fk
    FOREIGN KEY (chosen_offer_id) REFERENCES working_group_project_offers(id) ON DELETE SET NULL;

CREATE TABLE working_group_project_history (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES working_group_projects(id) ON DELETE CASCADE,
    status text NOT NULL,
    actor_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
    reason text CHECK (reason IS NULL OR length(reason) <= 500),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX working_group_project_history_project_idx ON working_group_project_history (project_id, created_at, id);
CREATE INDEX working_group_project_history_actor_idx ON working_group_project_history (actor_person_id) WHERE actor_person_id IS NOT NULL;

-- A finance manager's saved signature image, reused for the Projektantrag. Visible to its owner only.
CREATE TABLE working_group_finance_signatures (
    person_id uuid PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
    file_id uuid NOT NULL UNIQUE REFERENCES files(id) ON DELETE CASCADE,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Defaults of the Projektantrag.
ALTER TABLE working_group_finance_rules
    ADD COLUMN request_unit_kind text NOT NULL DEFAULT 'referat' CHECK (request_unit_kind IN ('stv', 'uv', 'referat')),
    ADD COLUMN request_unit_name text NOT NULL DEFAULT '' CHECK (length(request_unit_name) <= 120),
    ADD COLUMN request_add_group_name boolean NOT NULL DEFAULT true,
    ADD COLUMN request_responsible_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
    ADD COLUMN request_place text NOT NULL DEFAULT '' CHECK (length(request_place) <= 80);

-- Planned purchases: a purchase may belong to a project (and one of its items) and be 'planned'.
ALTER TABLE working_group_purchases
    ADD COLUMN project_id uuid REFERENCES working_group_projects(id) ON DELETE SET NULL,
    ADD COLUMN project_item_id uuid REFERENCES working_group_project_items(id) ON DELETE SET NULL;

CREATE INDEX working_group_purchases_project_idx ON working_group_purchases (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX working_group_purchases_project_item_idx ON working_group_purchases (project_item_id) WHERE project_item_id IS NOT NULL;

-- The check constraints that mention the status are replaced with versions that know 'planned'.
-- +goose StatementBegin
DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint
             WHERE conrelid = 'working_group_purchases'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status%'
    LOOP
        EXECUTE format('ALTER TABLE working_group_purchases DROP CONSTRAINT %I', c.conname);
    END LOOP;
END $$;
-- +goose StatementEnd

ALTER TABLE working_group_purchases
    ADD CONSTRAINT working_group_purchases_status_check
        CHECK (status IN ('planned', 'wanted', 'approved', 'declined', 'ordered', 'received', 'bought', 'refunded')),
    ADD CONSTRAINT working_group_purchases_how_status_check
        CHECK ((how = 'self' AND status IN ('planned', 'wanted', 'approved', 'declined', 'bought', 'refunded'))
            OR (how = 'central' AND status IN ('planned', 'wanted', 'approved', 'declined', 'ordered', 'received'))),
    ADD CONSTRAINT working_group_purchases_receipt_status_check
        CHECK ((status IN ('bought', 'refunded')) = (receipt_amount IS NOT NULL)),
    ADD CONSTRAINT working_group_purchases_receipt_file_status_check
        CHECK (receipt_file_id IS NULL OR status IN ('bought', 'refunded')),
    ADD CONSTRAINT working_group_purchases_order_status_check
        CHECK ((status IN ('ordered', 'received')) = (order_id IS NOT NULL)),
    ADD CONSTRAINT working_group_purchases_decline_status_check
        CHECK (decline_reason IS NULL OR status = 'declined'),
    ADD CONSTRAINT working_group_purchases_planned_project_check
        CHECK (status <> 'planned' OR project_id IS NOT NULL);

-- +goose Down
-- Destructive: every project with its items, offers and history, the saved signatures, the request defaults and
-- the planned purchases are deleted. The files themselves stay in file storage.
DELETE FROM working_group_purchases WHERE status = 'planned';
ALTER TABLE working_group_purchases
    DROP CONSTRAINT working_group_purchases_status_check,
    DROP CONSTRAINT working_group_purchases_how_status_check,
    DROP CONSTRAINT working_group_purchases_receipt_status_check,
    DROP CONSTRAINT working_group_purchases_receipt_file_status_check,
    DROP CONSTRAINT working_group_purchases_order_status_check,
    DROP CONSTRAINT working_group_purchases_decline_status_check,
    DROP CONSTRAINT working_group_purchases_planned_project_check,
    DROP COLUMN project_item_id,
    DROP COLUMN project_id;
ALTER TABLE working_group_purchases
    ADD CONSTRAINT working_group_purchases_status_check
        CHECK (status IN ('wanted', 'approved', 'declined', 'ordered', 'received', 'bought', 'refunded')),
    ADD CONSTRAINT working_group_purchases_check
        CHECK ((how = 'self' AND status IN ('wanted', 'approved', 'declined', 'bought', 'refunded'))
            OR (how = 'central' AND status IN ('wanted', 'approved', 'declined', 'ordered', 'received'))),
    ADD CONSTRAINT working_group_purchases_check1 CHECK ((status IN ('bought', 'refunded')) = (receipt_amount IS NOT NULL)),
    ADD CONSTRAINT working_group_purchases_check2 CHECK (receipt_file_id IS NULL OR status IN ('bought', 'refunded')),
    ADD CONSTRAINT working_group_purchases_check3 CHECK ((status IN ('ordered', 'received')) = (order_id IS NOT NULL)),
    ADD CONSTRAINT working_group_purchases_check4 CHECK (decline_reason IS NULL OR status = 'declined');
ALTER TABLE working_group_finance_rules
    DROP COLUMN request_unit_kind, DROP COLUMN request_unit_name, DROP COLUMN request_add_group_name,
    DROP COLUMN request_responsible_person_id, DROP COLUMN request_place;
DROP TABLE working_group_finance_signatures;
DROP TABLE working_group_project_history;
ALTER TABLE working_group_project_items DROP CONSTRAINT working_group_project_items_chosen_offer_fk;
DROP TABLE working_group_project_offers;
DROP TABLE working_group_project_items;
DROP TABLE working_group_projects;
