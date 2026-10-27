-- +goose Up
-- Merging duplicate People (people.merge) re-points every reference from the merged People and Accounts to the
-- surviving ones. Financial and other append-only history freezes those references, so their guards gain a
-- transaction-local merge mode: while makerspace.people_merge is 'on' (set_config(..., true) in the merge
-- transaction only) the original guard is skipped and people_merge_reference_guard allows nothing but changes of
-- the listed person/account reference columns.

-- +goose StatementBegin
CREATE FUNCTION people_merge_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'merging people never deletes history' USING ERRCODE = '23514';
    END IF;
    IF (to_jsonb(NEW) - TG_ARGV) IS DISTINCT FROM (to_jsonb(OLD) - TG_ARGV) THEN
        RAISE EXCEPTION 'merging people may only re-point person and account references' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd

DROP TRIGGER cash_movements_frozen ON cash_movements;
CREATE TRIGGER cash_movements_frozen BEFORE UPDATE ON cash_movements FOR EACH ROW
    WHEN (current_setting('makerspace.people_merge', true) IS DISTINCT FROM 'on')
    EXECUTE FUNCTION cash_movement_guard();
CREATE TRIGGER cash_movements_people_merge BEFORE UPDATE OR DELETE ON cash_movements FOR EACH ROW
    WHEN (current_setting('makerspace.people_merge', true) = 'on')
    EXECUTE FUNCTION people_merge_reference_guard('recorded_by_person_id');

DROP TRIGGER external_invoice_request_details_references_frozen ON external_invoice_request_details;
CREATE TRIGGER external_invoice_request_details_references_frozen BEFORE UPDATE ON external_invoice_request_details
    FOR EACH ROW WHEN (current_setting('makerspace.people_merge', true) IS DISTINCT FROM 'on')
    EXECUTE FUNCTION financial_reference_guard('recipient_person_id', 'recipient_organization_id', 'contact_person_id');
CREATE TRIGGER external_invoice_request_details_people_merge BEFORE UPDATE OR DELETE ON external_invoice_request_details
    FOR EACH ROW WHEN (current_setting('makerspace.people_merge', true) = 'on')
    EXECUTE FUNCTION people_merge_reference_guard('recipient_person_id', 'contact_person_id');

DROP TRIGGER external_invoice_request_events_references_frozen ON external_invoice_request_events;
CREATE TRIGGER external_invoice_request_events_references_frozen BEFORE UPDATE ON external_invoice_request_events
    FOR EACH ROW WHEN (current_setting('makerspace.people_merge', true) IS DISTINCT FROM 'on')
    EXECUTE FUNCTION financial_reference_guard('actor_account_id');
CREATE TRIGGER external_invoice_request_events_people_merge BEFORE UPDATE OR DELETE ON external_invoice_request_events
    FOR EACH ROW WHEN (current_setting('makerspace.people_merge', true) = 'on')
    EXECUTE FUNCTION people_merge_reference_guard('actor_account_id');

DROP TRIGGER inventory_transactions_immutable ON inventory_transactions;
CREATE TRIGGER inventory_transactions_immutable BEFORE DELETE OR UPDATE ON inventory_transactions FOR EACH ROW
    WHEN (current_setting('makerspace.people_merge', true) IS DISTINCT FROM 'on')
    EXECUTE FUNCTION guard_inventory_transaction_history();
CREATE TRIGGER inventory_transactions_people_merge BEFORE UPDATE OR DELETE ON inventory_transactions FOR EACH ROW
    WHEN (current_setting('makerspace.people_merge', true) = 'on')
    EXECUTE FUNCTION people_merge_reference_guard('actor_account_id');

DROP TRIGGER laborordnung_versions_immutable ON laborordnung_versions;
CREATE TRIGGER laborordnung_versions_immutable BEFORE DELETE OR UPDATE ON laborordnung_versions FOR EACH ROW
    WHEN (current_setting('makerspace.people_merge', true) IS DISTINCT FROM 'on')
    EXECUTE FUNCTION prevent_published_laborordnung_mutation();
CREATE TRIGGER laborordnung_versions_people_merge BEFORE UPDATE OR DELETE ON laborordnung_versions FOR EACH ROW
    WHEN (current_setting('makerspace.people_merge', true) = 'on')
    EXECUTE FUNCTION people_merge_reference_guard('created_by_account_id');

DROP TRIGGER order_adjustments_references_frozen ON order_adjustments;
CREATE TRIGGER order_adjustments_references_frozen BEFORE UPDATE ON order_adjustments FOR EACH ROW
    WHEN (current_setting('makerspace.people_merge', true) IS DISTINCT FROM 'on')
    EXECUTE FUNCTION financial_reference_guard('actor_account_id', 'order_id');
CREATE TRIGGER order_adjustments_people_merge BEFORE UPDATE OR DELETE ON order_adjustments FOR EACH ROW
    WHEN (current_setting('makerspace.people_merge', true) = 'on')
    EXECUTE FUNCTION people_merge_reference_guard('actor_account_id');

DROP TRIGGER order_items_references_frozen ON order_items;
CREATE TRIGGER order_items_references_frozen BEFORE UPDATE ON order_items FOR EACH ROW
    WHEN (current_setting('makerspace.people_merge', true) IS DISTINCT FROM 'on')
    EXECUTE FUNCTION financial_reference_guard('source_machine_job_id', 'source_material_id', 'created_by_account_id');
CREATE TRIGGER order_items_people_merge BEFORE UPDATE OR DELETE ON order_items FOR EACH ROW
    WHEN (current_setting('makerspace.people_merge', true) = 'on')
    EXECUTE FUNCTION people_merge_reference_guard('created_by_account_id', 'removed_by_account_id');

DROP TRIGGER orders_references_frozen ON orders;
CREATE TRIGGER orders_references_frozen BEFORE UPDATE ON orders FOR EACH ROW
    WHEN (current_setting('makerspace.people_merge', true) IS DISTINCT FROM 'on')
    EXECUTE FUNCTION financial_reference_guard('customer_person_id', 'customer_organization_id', 'created_by_account_id', 'replaces_order_id');
CREATE TRIGGER orders_people_merge BEFORE UPDATE OR DELETE ON orders FOR EACH ROW
    WHEN (current_setting('makerspace.people_merge', true) = 'on')
    EXECUTE FUNCTION people_merge_reference_guard('customer_person_id', 'created_by_account_id');

DROP TRIGGER payment_allocations_references_frozen ON payment_allocations;
CREATE TRIGGER payment_allocations_references_frozen BEFORE UPDATE ON payment_allocations FOR EACH ROW
    WHEN (current_setting('makerspace.people_merge', true) IS DISTINCT FROM 'on')
    EXECUTE FUNCTION financial_reference_guard('actor_account_id', 'order_id', 'payment_id', 'reverses_allocation_id');
CREATE TRIGGER payment_allocations_people_merge BEFORE UPDATE OR DELETE ON payment_allocations FOR EACH ROW
    WHEN (current_setting('makerspace.people_merge', true) = 'on')
    EXECUTE FUNCTION people_merge_reference_guard('actor_account_id');

DROP TRIGGER payments_references_frozen ON payments;
CREATE TRIGGER payments_references_frozen BEFORE UPDATE ON payments FOR EACH ROW
    WHEN (current_setting('makerspace.people_merge', true) IS DISTINCT FROM 'on')
    EXECUTE FUNCTION financial_reference_guard('actor_account_id', 'reverses_payment_id', 'external_invoice_request_id');
CREATE TRIGGER payments_people_merge BEFORE UPDATE OR DELETE ON payments FOR EACH ROW
    WHEN (current_setting('makerspace.people_merge', true) = 'on')
    EXECUTE FUNCTION people_merge_reference_guard('actor_account_id');

-- Masters must sign in again within ten minutes before merging people, like the other destructive identity
-- operations. Operators can change the window through the master reauthentication policy.
INSERT INTO master_reauthentication_permissions (permission_id, within_minutes) VALUES ('people.merge', 10)
ON CONFLICT (permission_id) DO NOTHING;

-- +goose Down
DELETE FROM master_reauthentication_permissions WHERE permission_id = 'people.merge';
DELETE FROM role_permission_grants WHERE permission_id = 'people.merge';

DROP TRIGGER payments_people_merge ON payments;
DROP TRIGGER payments_references_frozen ON payments;
CREATE TRIGGER payments_references_frozen BEFORE UPDATE ON payments FOR EACH ROW
    EXECUTE FUNCTION financial_reference_guard('actor_account_id', 'reverses_payment_id', 'external_invoice_request_id');

DROP TRIGGER payment_allocations_people_merge ON payment_allocations;
DROP TRIGGER payment_allocations_references_frozen ON payment_allocations;
CREATE TRIGGER payment_allocations_references_frozen BEFORE UPDATE ON payment_allocations FOR EACH ROW
    EXECUTE FUNCTION financial_reference_guard('actor_account_id', 'order_id', 'payment_id', 'reverses_allocation_id');

DROP TRIGGER orders_people_merge ON orders;
DROP TRIGGER orders_references_frozen ON orders;
CREATE TRIGGER orders_references_frozen BEFORE UPDATE ON orders FOR EACH ROW
    EXECUTE FUNCTION financial_reference_guard('customer_person_id', 'customer_organization_id', 'created_by_account_id', 'replaces_order_id');

DROP TRIGGER order_items_people_merge ON order_items;
DROP TRIGGER order_items_references_frozen ON order_items;
CREATE TRIGGER order_items_references_frozen BEFORE UPDATE ON order_items FOR EACH ROW
    EXECUTE FUNCTION financial_reference_guard('source_machine_job_id', 'source_material_id', 'created_by_account_id');

DROP TRIGGER order_adjustments_people_merge ON order_adjustments;
DROP TRIGGER order_adjustments_references_frozen ON order_adjustments;
CREATE TRIGGER order_adjustments_references_frozen BEFORE UPDATE ON order_adjustments FOR EACH ROW
    EXECUTE FUNCTION financial_reference_guard('actor_account_id', 'order_id');

DROP TRIGGER laborordnung_versions_people_merge ON laborordnung_versions;
DROP TRIGGER laborordnung_versions_immutable ON laborordnung_versions;
CREATE TRIGGER laborordnung_versions_immutable BEFORE DELETE OR UPDATE ON laborordnung_versions FOR EACH ROW
    EXECUTE FUNCTION prevent_published_laborordnung_mutation();

DROP TRIGGER inventory_transactions_people_merge ON inventory_transactions;
DROP TRIGGER inventory_transactions_immutable ON inventory_transactions;
CREATE TRIGGER inventory_transactions_immutable BEFORE DELETE OR UPDATE ON inventory_transactions FOR EACH ROW
    EXECUTE FUNCTION guard_inventory_transaction_history();

DROP TRIGGER external_invoice_request_events_people_merge ON external_invoice_request_events;
DROP TRIGGER external_invoice_request_events_references_frozen ON external_invoice_request_events;
CREATE TRIGGER external_invoice_request_events_references_frozen BEFORE UPDATE ON external_invoice_request_events
    FOR EACH ROW EXECUTE FUNCTION financial_reference_guard('actor_account_id');

DROP TRIGGER external_invoice_request_details_people_merge ON external_invoice_request_details;
DROP TRIGGER external_invoice_request_details_references_frozen ON external_invoice_request_details;
CREATE TRIGGER external_invoice_request_details_references_frozen BEFORE UPDATE ON external_invoice_request_details
    FOR EACH ROW EXECUTE FUNCTION financial_reference_guard('recipient_person_id', 'recipient_organization_id', 'contact_person_id');

DROP TRIGGER cash_movements_people_merge ON cash_movements;
DROP TRIGGER cash_movements_frozen ON cash_movements;
CREATE TRIGGER cash_movements_frozen BEFORE UPDATE ON cash_movements FOR EACH ROW
    EXECUTE FUNCTION cash_movement_guard();

DROP FUNCTION people_merge_reference_guard();
