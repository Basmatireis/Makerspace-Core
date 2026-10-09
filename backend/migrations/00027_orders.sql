-- +goose Up
CREATE SEQUENCE order_reference_sequence;
CREATE SEQUENCE payment_reference_sequence;
CREATE SEQUENCE order_adjustment_reference_sequence;
CREATE SEQUENCE external_invoice_request_reference_sequence;
CREATE TABLE orders (
 id uuid PRIMARY KEY, reference text NOT NULL UNIQUE CHECK(reference ~ '^O-[0-9]{4}-[0-9]{6,}$'),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','finalized','cancelled','reversed')),
 currency text NOT NULL DEFAULT 'EUR' CHECK(currency='EUR'),
 customer_kind text NOT NULL CHECK(customer_kind IN ('anonymous','person','organization')),
 customer_person_id uuid REFERENCES people ON DELETE SET NULL,
 customer_organization_id uuid REFERENCES organizations ON DELETE SET NULL,
 fulfillment_mode text NOT NULL CHECK(fulfillment_mode IN ('immediate','deferred')),
 total_amount numeric(20,2) NOT NULL DEFAULT 0 CHECK(total_amount>=0),
 replaces_order_id uuid REFERENCES orders ON DELETE SET NULL, replaces_order_reference text,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 created_by_account_id uuid REFERENCES accounts ON DELETE SET NULL,
 finalized_at timestamptz, cancelled_at timestamptz, reversed_at timestamptz,
 CHECK(customer_person_id IS NULL OR customer_organization_id IS NULL),
 CHECK(customer_kind<>'anonymous' OR (customer_person_id IS NULL AND customer_organization_id IS NULL)),
 CHECK(customer_person_id IS NULL OR customer_kind='person'),
 CHECK(customer_organization_id IS NULL OR customer_kind='organization')
);
CREATE INDEX orders_list_idx ON orders(created_at DESC,id DESC);
CREATE TABLE order_customer_snapshots (
 order_id uuid PRIMARY KEY REFERENCES orders ON DELETE CASCADE,
 display_name text NOT NULL, organization_kind text, captured_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE order_items (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders ON DELETE CASCADE,
 position integer NOT NULL CHECK(position>0), kind text NOT NULL CHECK(kind IN ('manual','machine_job')),
 description text NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 500),
 quantity numeric(20,6) NOT NULL CHECK(quantity>0), unit text NOT NULL CHECK(length(btrim(unit)) BETWEEN 1 AND 40),
 unit_price numeric(20,6) NOT NULL CHECK(unit_price>=0), amount numeric(20,2) NOT NULL CHECK(amount>=0),
 source_machine_job_id uuid REFERENCES machine_jobs ON DELETE SET NULL, source_job_version bigint,
 machine_job_snapshot jsonb, snapshot_schema_version integer NOT NULL DEFAULT 1 CHECK(snapshot_schema_version=1),
 created_at timestamptz NOT NULL DEFAULT now(), created_by_account_id uuid REFERENCES accounts ON DELETE SET NULL,
 removed_at timestamptz, removed_by_account_id uuid REFERENCES accounts ON DELETE SET NULL,
 UNIQUE(order_id,position),
 CHECK((kind='manual' AND machine_job_snapshot IS NULL AND source_job_version IS NULL) OR
       (kind='machine_job' AND jsonb_typeof(machine_job_snapshot)='object' AND source_job_version>0))
);
CREATE UNIQUE INDEX order_items_active_job_idx ON order_items(order_id,source_machine_job_id) WHERE removed_at IS NULL AND source_machine_job_id IS NOT NULL;
CREATE INDEX order_items_order_idx ON order_items(order_id,position);
CREATE TABLE order_job_claims (
 machine_job_id uuid PRIMARY KEY REFERENCES machine_jobs ON DELETE CASCADE,
 order_item_id uuid NOT NULL UNIQUE REFERENCES order_items ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE order_adjustments (
 id uuid PRIMARY KEY, reference text NOT NULL UNIQUE, order_id uuid REFERENCES orders ON DELETE SET NULL,
 order_reference text NOT NULL, kind text NOT NULL CHECK(kind='full_reversal'),
 currency text NOT NULL CHECK(currency='EUR'), amount numeric(20,2) NOT NULL CHECK(amount>=0),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 actor_account_id uuid REFERENCES accounts ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX order_full_reversal_idx ON order_adjustments(order_id) WHERE kind='full_reversal';
CREATE TABLE order_adjustment_items (
 id uuid PRIMARY KEY, adjustment_id uuid NOT NULL REFERENCES order_adjustments ON DELETE CASCADE,
 original_order_item_id uuid REFERENCES order_items ON DELETE SET NULL,
 original_item_position integer NOT NULL, amount numeric(20,2) NOT NULL CHECK(amount>=0)
);
CREATE TABLE external_invoice_requests (
 id uuid PRIMARY KEY, reference text NOT NULL UNIQUE, order_id uuid REFERENCES orders ON DELETE SET NULL,
 order_reference text NOT NULL, provider text NOT NULL DEFAULT 'wiref' CHECK(provider='wiref'),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','ready','submitted','issued','cancellation_requested','cancelled')),
 currency text NOT NULL CHECK(currency='EUR'), requested_amount numeric(20,2) NOT NULL CHECK(requested_amount>=0),
 supersedes_request_id uuid REFERENCES external_invoice_requests ON DELETE SET NULL,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX external_invoice_request_active_idx ON external_invoice_requests(order_id) WHERE state<>'cancelled';
CREATE TABLE organization_invoicing_requirements (
 organization_id uuid PRIMARY KEY REFERENCES organizations ON DELETE CASCADE,
 require_purchase_order_reference boolean NOT NULL DEFAULT false,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0), updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_account_id uuid REFERENCES accounts ON DELETE SET NULL
);
CREATE TABLE external_invoice_request_details (
 request_id uuid PRIMARY KEY REFERENCES external_invoice_requests ON DELETE CASCADE,
 recipient_kind text NOT NULL CHECK(recipient_kind IN ('person','organization')),
 recipient_name text NOT NULL DEFAULT '', recipient_person_id uuid REFERENCES people ON DELETE SET NULL,
 recipient_organization_id uuid REFERENCES organizations ON DELETE SET NULL,
 address_line1 text NOT NULL DEFAULT '', address_line2 text NOT NULL DEFAULT '', postal_code text NOT NULL DEFAULT '',
 locality text NOT NULL DEFAULT '', region text NOT NULL DEFAULT '', country_code text NOT NULL DEFAULT '',
 contact_person_id uuid REFERENCES people ON DELETE SET NULL,
 contact_name text NOT NULL DEFAULT '', contact_channel text NOT NULL DEFAULT '',
 service_starts_on date, service_ends_on date, service_description text NOT NULL DEFAULT '',
 purchase_order_reference text NOT NULL DEFAULT '', requirements_version bigint NOT NULL DEFAULT 0,
 require_purchase_order_reference boolean NOT NULL DEFAULT false,
 item_summary jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(item_summary)='array'),
 snapshot_schema_version integer NOT NULL DEFAULT 1 CHECK(snapshot_schema_version=1),
 CHECK(service_starts_on IS NULL OR service_ends_on IS NULL OR service_starts_on<=service_ends_on)
);
CREATE TABLE external_invoice_request_events (
 id uuid PRIMARY KEY, request_id uuid NOT NULL REFERENCES external_invoice_requests ON DELETE CASCADE,
 kind text NOT NULL, external_reference text NOT NULL DEFAULT '', reconciliation_kind text NOT NULL DEFAULT '',
 reason text NOT NULL DEFAULT '', effective_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
 actor_account_id uuid REFERENCES accounts ON DELETE SET NULL
);
CREATE TABLE payments (
 id uuid PRIMARY KEY, reference text NOT NULL UNIQUE CHECK(reference ~ '^P-[0-9]{4}-[0-9]{6,}$'),
 entry_kind text NOT NULL CHECK(entry_kind IN ('receipt','reversal')),
 method text NOT NULL CHECK(method IN ('cash','card','external')),
 amount numeric(20,2) NOT NULL CHECK(amount>0), currency text NOT NULL CHECK(currency='EUR'),
 occurred_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
 actor_account_id uuid REFERENCES accounts ON DELETE SET NULL,
 reverses_payment_id uuid REFERENCES payments ON DELETE SET NULL, reversed_payment_reference text,
 reversal_reason_kind text CHECK(reversal_reason_kind IN ('refund','recording_error','external_correction')),
 reason text NOT NULL DEFAULT '' CHECK(length(reason)<=500),
 external_source text NOT NULL DEFAULT '', external_reference text NOT NULL DEFAULT '',
 external_invoice_request_id uuid REFERENCES external_invoice_requests ON DELETE SET NULL,
 CHECK((entry_kind='receipt' AND reversed_payment_reference IS NULL AND reversal_reason_kind IS NULL) OR
       (entry_kind='reversal' AND reversed_payment_reference IS NOT NULL AND reversal_reason_kind IS NOT NULL AND btrim(reason)<>'')),
 CHECK(method<>'card' OR (btrim(external_source)<>'' AND btrim(external_reference)<>'')),
 CHECK(method<>'external' OR btrim(external_reference)<>'')
);
CREATE UNIQUE INDEX payment_full_reversal_idx ON payments(reverses_payment_id) WHERE entry_kind='reversal';
CREATE UNIQUE INDEX card_receipt_reference_idx ON payments(external_source,external_reference) WHERE method='card' AND entry_kind='receipt';
CREATE INDEX payments_time_idx ON payments(occurred_at DESC,id DESC);
CREATE TABLE payment_allocations (
 id uuid PRIMARY KEY, payment_id uuid REFERENCES payments ON DELETE SET NULL, payment_reference text NOT NULL,
 order_id uuid REFERENCES orders ON DELETE SET NULL, order_reference text NOT NULL,
 amount numeric(20,2) NOT NULL CHECK(amount<>0), currency text NOT NULL CHECK(currency='EUR'),
 operation_id uuid NOT NULL, reverses_allocation_id uuid REFERENCES payment_allocations ON DELETE SET NULL,
 actor_account_id uuid REFERENCES accounts ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_allocations_order_idx ON payment_allocations(order_id);
CREATE INDEX payment_allocations_payment_idx ON payment_allocations(payment_id);
CREATE TABLE order_operations (
 id uuid PRIMARY KEY, operation_key uuid NOT NULL UNIQUE, kind text NOT NULL,
 request_fingerprint bytea NOT NULL, actor_account_id uuid REFERENCES accounts ON DELETE SET NULL,
 order_id uuid REFERENCES orders ON DELETE SET NULL, payment_id uuid REFERENCES payments ON DELETE SET NULL,
 request_id uuid REFERENCES external_invoice_requests ON DELETE SET NULL, completed_at timestamptz NOT NULL DEFAULT now()
);
-- +goose StatementBegin
CREATE FUNCTION orders_guard_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status<>'draft' AND (to_jsonb(NEW)-ARRAY['status','version','updated_at','reversed_at','customer_person_id','customer_organization_id','created_by_account_id','replaces_order_id'])
 IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','version','updated_at','reversed_at','customer_person_id','customer_organization_id','created_by_account_id','replaces_order_id']) THEN
 RAISE EXCEPTION 'finalized order content is immutable' USING ERRCODE='23514'; END IF;
 IF (OLD.status='finalized' AND NEW.status NOT IN ('finalized','reversed')) OR
    (OLD.status IN ('cancelled','reversed') AND NEW.status<>OLD.status) THEN
 RAISE EXCEPTION 'invalid order transition' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION order_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
 IF (SELECT status FROM orders WHERE id=NEW.order_id)<>'draft' THEN RAISE EXCEPTION 'order is not draft' USING ERRCODE='23514'; END IF;
 ELSE
 IF (to_jsonb(NEW)-ARRAY['removed_at','removed_by_account_id','source_machine_job_id','created_by_account_id']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['removed_at','removed_by_account_id','source_machine_job_id','created_by_account_id']) THEN
 RAISE EXCEPTION 'order item content is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.removed_at IS DISTINCT FROM OLD.removed_at AND (SELECT status FROM orders WHERE id=OLD.order_id)<>'draft' THEN
 RAISE EXCEPTION 'order is not draft' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
END $$;
CREATE FUNCTION financial_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['actor_account_id','order_id','payment_id','reverses_payment_id','external_invoice_request_id','reverses_allocation_id','original_order_item_id']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['actor_account_id','order_id','payment_id','reverses_payment_id','external_invoice_request_id','reverses_allocation_id','original_order_item_id']) THEN
 RAISE EXCEPTION 'financial entry is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION invoice_details_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (SELECT state FROM external_invoice_requests WHERE id=OLD.request_id)<>'draft' AND
 (to_jsonb(NEW)-ARRAY['recipient_person_id','recipient_organization_id','contact_person_id']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['recipient_person_id','recipient_organization_id','contact_person_id']) THEN
 RAISE EXCEPTION 'invoice request snapshot is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
-- +goose StatementEnd
CREATE TRIGGER orders_frozen BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION orders_guard_frozen();
CREATE TRIGGER order_items_frozen BEFORE INSERT OR UPDATE ON order_items FOR EACH ROW EXECUTE FUNCTION order_items_guard();
CREATE TRIGGER payments_frozen BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION financial_entry_guard();
CREATE TRIGGER allocations_frozen BEFORE UPDATE ON payment_allocations FOR EACH ROW EXECUTE FUNCTION financial_entry_guard();
CREATE TRIGGER adjustments_frozen BEFORE UPDATE ON order_adjustments FOR EACH ROW EXECUTE FUNCTION financial_entry_guard();
CREATE TRIGGER adjustment_items_frozen BEFORE UPDATE ON order_adjustment_items FOR EACH ROW EXECUTE FUNCTION financial_entry_guard();
CREATE TRIGGER invoice_events_frozen BEFORE UPDATE ON external_invoice_request_events FOR EACH ROW EXECUTE FUNCTION financial_entry_guard();
CREATE TRIGGER invoice_details_frozen BEFORE UPDATE ON external_invoice_request_details FOR EACH ROW EXECUTE FUNCTION invoice_details_guard();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM orders) OR EXISTS(SELECT 1 FROM payments) OR EXISTS(SELECT 1 FROM external_invoice_requests) THEN
 RAISE EXCEPTION 'cannot downgrade while financial history exists'; END IF;
END $$;
-- +goose StatementEnd
DROP TABLE order_operations, payment_allocations, payments, external_invoice_request_events, external_invoice_request_details,
 organization_invoicing_requirements, external_invoice_requests, order_adjustment_items, order_adjustments,
 order_job_claims, order_items, order_customer_snapshots, orders;
DROP FUNCTION orders_guard_frozen(),order_items_guard(),financial_entry_guard(),invoice_details_guard();
DROP SEQUENCE order_reference_sequence,payment_reference_sequence,order_adjustment_reference_sequence,external_invoice_request_reference_sequence;
