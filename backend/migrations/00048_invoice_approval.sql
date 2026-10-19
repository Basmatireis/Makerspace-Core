-- +goose Up
-- Invoice requests get an approval step: draft -> submitted (awaiting approval) -> issued.
-- The former "ready" state disappears; "submitted" used to mean "sent to wiRef" and now means
-- "awaiting approval", so those rows become "issued". An issued request settles the open
-- balance of its order with an `external` payment. That payment needs a new UUIDv7 (generated in
-- application code), so this migration cannot create it. It refuses to run while a request
-- would become issued on an order that still has an open balance.
-- +goose StatementBegin
DO $$
DECLARE offenders text;
BEGIN
 SELECT string_agg(r.reference, ', ' ORDER BY r.reference) INTO offenders
 FROM external_invoice_requests r JOIN orders o ON o.id=r.order_id
 WHERE r.state IN ('submitted','issued')
 AND o.total_amount
  - COALESCE((SELECT sum(x.amount) FROM order_adjustments x WHERE x.order_id=o.id),0)
  - COALESCE((SELECT sum(x.amount) FROM payment_allocations x WHERE x.order_id=o.id),0) > 0;
 IF offenders IS NOT NULL THEN
 RAISE EXCEPTION 'cannot migrate invoice requests with an open balance (an issued invoice now settles its order): %. Record the external payment or cancel the request first.', offenders;
 END IF;
END $$;
-- +goose StatementEnd

UPDATE external_invoice_requests
SET state=CASE state WHEN 'ready' THEN 'draft' WHEN 'submitted' THEN 'issued' END, version=version+1
WHERE state IN ('ready','submitted');

ALTER TABLE external_invoice_requests DROP CONSTRAINT external_invoice_requests_state_check;
ALTER TABLE external_invoice_requests ADD CONSTRAINT external_invoice_requests_state_check
 CHECK(state IN ('draft','submitted','issued','cancellation_requested','cancelled'));

-- Cash and card received when the request was prepared; follows the order's payments while the request is a draft.
ALTER TABLE external_invoice_request_details ADD COLUMN already_paid numeric(20,2) NOT NULL DEFAULT 0 CHECK(already_paid>=0);

-- Recipient and service details stay editable by approvers while the request awaits approval;
-- everything else of the snapshot (items, recipient kind, already paid) is frozen from submission on.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION invoice_details_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_state text;
BEGIN
 SELECT state INTO request_state FROM external_invoice_requests WHERE id=OLD.request_id;
 IF request_state='draft' THEN RETURN NEW; END IF;
 IF request_state='submitted' THEN
 IF (to_jsonb(NEW)-ARRAY['recipient_person_id','recipient_organization_id','contact_person_id','recipient_name','address_line1','address_line2','postal_code','locality','region','country_code','contact_name','contact_channel','service_starts_on','service_ends_on','service_description','purchase_order_reference','requirements_version','require_purchase_order_reference']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['recipient_person_id','recipient_organization_id','contact_person_id','recipient_name','address_line1','address_line2','postal_code','locality','region','country_code','contact_name','contact_channel','service_starts_on','service_ends_on','service_description','purchase_order_reference','requirements_version','require_purchase_order_reference']) THEN
 RAISE EXCEPTION 'invoice request snapshot is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['recipient_person_id','recipient_organization_id','contact_person_id']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['recipient_person_id','recipient_organization_id','contact_person_id']) THEN
 RAISE EXCEPTION 'invoice request snapshot is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION financial_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field text;
BEGIN
 FOREACH field IN ARRAY TG_ARGV LOOP
 IF TG_TABLE_NAME='orders' AND to_jsonb(OLD)->>'status'='draft' AND field IN ('customer_person_id','customer_organization_id') THEN CONTINUE; END IF;
 IF TG_TABLE_NAME='external_invoice_request_details' AND (SELECT state FROM external_invoice_requests WHERE id=(to_jsonb(OLD)->>'request_id')::uuid) IN ('draft','submitted') THEN CONTINUE; END IF;
 IF (to_jsonb(NEW)->field) IS DISTINCT FROM (to_jsonb(OLD)->field) AND (to_jsonb(NEW)->field)<>'null'::jsonb THEN
 RAISE EXCEPTION 'immutable references may only be detached' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
-- +goose StatementEnd

-- +goose Down
-- Requests awaiting approval go back to the former "ready" state.
UPDATE external_invoice_requests SET state='ready', version=version+1 WHERE state='submitted';
ALTER TABLE external_invoice_requests DROP CONSTRAINT external_invoice_requests_state_check;
ALTER TABLE external_invoice_requests ADD CONSTRAINT external_invoice_requests_state_check
 CHECK(state IN ('draft','ready','submitted','issued','cancellation_requested','cancelled'));
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION invoice_details_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (SELECT state FROM external_invoice_requests WHERE id=OLD.request_id)<>'draft' AND
 (to_jsonb(NEW)-ARRAY['recipient_person_id','recipient_organization_id','contact_person_id']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['recipient_person_id','recipient_organization_id','contact_person_id']) THEN
 RAISE EXCEPTION 'invoice request snapshot is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION financial_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field text;
BEGIN
 FOREACH field IN ARRAY TG_ARGV LOOP
 IF TG_TABLE_NAME='orders' AND to_jsonb(OLD)->>'status'='draft' AND field IN ('customer_person_id','customer_organization_id') THEN CONTINUE; END IF;
 IF TG_TABLE_NAME='external_invoice_request_details' AND (SELECT state FROM external_invoice_requests WHERE id=(to_jsonb(OLD)->>'request_id')::uuid)='draft' THEN CONTINUE; END IF;
 IF (to_jsonb(NEW)->field) IS DISTINCT FROM (to_jsonb(OLD)->field) AND (to_jsonb(NEW)->field)<>'null'::jsonb THEN
 RAISE EXCEPTION 'immutable references may only be detached' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
-- +goose StatementEnd
ALTER TABLE external_invoice_request_details DROP COLUMN already_paid;
