-- +goose Up
-- Deleting an archived spool clears the spool references of its ledger rows
-- and job usages. A transfer keeps its direction through the display ID
-- snapshots, and a usage of a deleted spool must not be mistaken for an
-- unassigned usage of the same material.
ALTER TABLE inventory_transactions
    DROP CONSTRAINT inventory_transactions_transfer_shape,
    ADD CONSTRAINT inventory_transactions_transfer_shape CHECK (
        (kind = 'spool_transfer'
            AND quantity_delta = 0
            AND inventory_value_delta = 0
            AND unit_acquisition_cost = 0
            AND total_purchase_price IS NULL
            AND spool_id IS NULL
            AND transfer_quantity IS NOT NULL
            AND transfer_quantity > 0
            AND (from_spool_display_id IS NOT NULL OR to_spool_display_id IS NOT NULL)
            AND from_spool_display_id IS DISTINCT FROM to_spool_display_id)
        OR
        (kind <> 'spool_transfer'
            AND from_spool_id IS NULL
            AND to_spool_id IS NULL
            AND transfer_quantity IS NULL)
    );

DROP INDEX machine_job_usages_active_unassigned_idx;
CREATE UNIQUE INDEX machine_job_usages_active_unassigned_idx
    ON machine_job_material_usages (machine_job_id, material_id)
    WHERE active AND ownership = 'makerspace' AND spool_id IS NULL AND spool_display_id IS NULL;

-- +goose Down
DROP INDEX machine_job_usages_active_unassigned_idx;
CREATE UNIQUE INDEX machine_job_usages_active_unassigned_idx
    ON machine_job_material_usages (machine_job_id, material_id)
    WHERE active AND ownership = 'makerspace' AND spool_id IS NULL;

-- Transfers of deleted spools no longer reference a spool; keep them valid.
ALTER TABLE inventory_transactions
    DROP CONSTRAINT inventory_transactions_transfer_shape,
    ADD CONSTRAINT inventory_transactions_transfer_shape CHECK (
        (kind = 'spool_transfer'
            AND quantity_delta = 0
            AND inventory_value_delta = 0
            AND unit_acquisition_cost = 0
            AND total_purchase_price IS NULL
            AND spool_id IS NULL
            AND transfer_quantity IS NOT NULL
            AND transfer_quantity > 0
            AND (from_spool_id IS NOT NULL OR to_spool_id IS NOT NULL)
            AND from_spool_id IS DISTINCT FROM to_spool_id)
        OR
        (kind <> 'spool_transfer'
            AND from_spool_id IS NULL
            AND to_spool_id IS NULL
            AND transfer_quantity IS NULL)
    ) NOT VALID;
