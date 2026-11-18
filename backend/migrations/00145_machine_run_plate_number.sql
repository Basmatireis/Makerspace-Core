-- +goose Up
-- The plate of a multi-plate 3MF the printer reported for a run (Bambu: /data/Metadata/plate_N.gcode). The run and job
-- pages show that plate's preview; runs recorded before this column keep their artifact's primary preview.
ALTER TABLE machine_runs
    ADD COLUMN plate_number integer CONSTRAINT machine_runs_plate_number_check CHECK (plate_number BETWEEN 1 AND 1000);

-- +goose Down
ALTER TABLE machine_runs DROP COLUMN plate_number;
