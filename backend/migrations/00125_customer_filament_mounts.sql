-- +goose Up
-- A slot can hold filament the customer brought. It is the same open mount as a spool (one open assignment per slot,
-- the same history), but without an inventory spool: nothing is booked from stock. The optional material type and
-- colour name are only what staff say the filament is.
ALTER TABLE printer_spool_assignments
    ALTER COLUMN spool_id DROP NOT NULL,
    ADD COLUMN kind text NOT NULL DEFAULT 'spool' CHECK (kind IN ('spool', 'customer')),
    ADD COLUMN customer_material_type_id uuid REFERENCES material_types(id) ON DELETE SET NULL,
    ADD COLUMN customer_color_name text CHECK (
        customer_color_name IS NULL OR (customer_color_name = btrim(customer_color_name) AND customer_color_name <> ''
                                         AND length(customer_color_name) <= 80)),
    ADD CONSTRAINT printer_spool_assignments_mount_check CHECK (
        (kind = 'spool' AND spool_id IS NOT NULL AND customer_material_type_id IS NULL AND customer_color_name IS NULL)
        OR (kind = 'customer' AND spool_id IS NULL AND source = 'manual'));

-- A reported consumption line (or one segment of it) that was fed from customer filament points at the mount it
-- was resolved to, so the run books it as customer material instead of leaving it unresolved.
ALTER TABLE machine_run_reported_usage_items
    ADD COLUMN customer_assignment_id uuid REFERENCES printer_spool_assignments(id) ON DELETE SET NULL,
    ADD CONSTRAINT machine_run_reported_usage_items_customer_check CHECK (customer_assignment_id IS NULL OR spool_id IS NULL);
ALTER TABLE machine_run_reported_usage_segments
    ADD COLUMN customer_assignment_id uuid REFERENCES printer_spool_assignments(id) ON DELETE SET NULL,
    ADD CONSTRAINT machine_run_reported_usage_segments_customer_check CHECK (customer_assignment_id IS NULL OR spool_id IS NULL);

-- +goose Down
ALTER TABLE machine_run_reported_usage_segments
    DROP CONSTRAINT machine_run_reported_usage_segments_customer_check,
    DROP COLUMN customer_assignment_id;
ALTER TABLE machine_run_reported_usage_items
    DROP CONSTRAINT machine_run_reported_usage_items_customer_check,
    DROP COLUMN customer_assignment_id;
DELETE FROM printer_spool_assignments WHERE kind = 'customer';
ALTER TABLE printer_spool_assignments
    DROP CONSTRAINT printer_spool_assignments_mount_check,
    DROP COLUMN customer_color_name,
    DROP COLUMN customer_material_type_id,
    DROP COLUMN kind,
    ALTER COLUMN spool_id SET NOT NULL;
