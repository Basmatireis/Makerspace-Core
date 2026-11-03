-- +goose Up
-- A job can be kept off signage as a whole; its runs are then hidden whatever their own flag says.
ALTER TABLE machine_jobs ADD COLUMN hidden_from_signage boolean NOT NULL DEFAULT false;

-- Material the recipient brought may name its material type and a short label instead of a free-text name; the
-- label lives in external_material_name. An external usage may also leave all three empty ("own material").
ALTER TABLE machine_run_usages ADD COLUMN material_type_id uuid REFERENCES material_types(id) ON DELETE SET NULL;
ALTER TABLE machine_run_usages DROP CONSTRAINT machine_job_usages_ownership_check;
ALTER TABLE machine_run_usages ADD CONSTRAINT machine_run_usages_ownership_check CHECK (
    (ownership = 'makerspace' AND material_id IS NOT NULL AND external_material_name IS NULL AND material_type_id IS NULL)
    OR (ownership = 'external' AND spool_id IS NULL
        AND (external_material_name IS NULL
             OR (external_material_name = btrim(external_material_name) AND external_material_name <> ''
                 AND length(external_material_name) <= 200)))
);

-- +goose Down
UPDATE machine_run_usages u
SET external_material_name = left(COALESCE(
        (SELECT m.name FROM materials m WHERE m.id = u.material_id),
        (SELECT t.name FROM material_types t WHERE t.id = u.material_type_id),
        'External'), 200)
WHERE u.ownership = 'external' AND u.external_material_name IS NULL;
ALTER TABLE machine_run_usages DROP CONSTRAINT machine_run_usages_ownership_check;
ALTER TABLE machine_run_usages ADD CONSTRAINT machine_job_usages_ownership_check CHECK (
    (ownership = 'makerspace' AND material_id IS NOT NULL AND external_material_name IS NULL)
    OR (ownership = 'external' AND spool_id IS NULL AND external_material_name IS NOT NULL
        AND external_material_name = btrim(external_material_name) AND external_material_name <> ''
        AND length(external_material_name) <= 200)
);
ALTER TABLE machine_run_usages DROP COLUMN material_type_id;
ALTER TABLE machine_jobs DROP COLUMN hidden_from_signage;
