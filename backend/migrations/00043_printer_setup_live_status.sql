-- +goose Up
-- Machine types flag whether their machines get a printer setup. Types that
-- already have a machine with a printer profile are flagged so existing
-- installations keep showing the printer setup for those machines.
ALTER TABLE machine_types ADD COLUMN printer boolean NOT NULL DEFAULT false;

UPDATE machine_types t SET printer = true
WHERE EXISTS (
    SELECT 1 FROM machines m JOIN printer_profiles p ON p.machine_id = m.id
    WHERE m.machine_type_id = t.id
);

-- The model selects the frontend's spool-input template; Core only stores it.
ALTER TABLE printer_profiles
    ADD COLUMN model text,
    ADD CONSTRAINT printer_profiles_model_check CHECK (model IS NULL OR model IN ('bambu_h2d', 'bambu_x1c', 'prusa_core_one', 'generic'));

-- The nozzle (extruder side) a spool input unit feeds. NULL when not known.
ALTER TABLE printer_input_units
    ADD COLUMN nozzle text,
    ADD CONSTRAINT printer_input_units_nozzle_check CHECK (nozzle IS NULL OR nozzle IN ('left', 'right'));

-- Live printer status is telemetry, not history: the connector reports the
-- latest normalized snapshot and Core keeps exactly one row per assignment.
CREATE TABLE printer_live_statuses (
    assignment_id uuid PRIMARY KEY REFERENCES printer_connector_assignments(id) ON DELETE CASCADE,
    machine_id uuid NOT NULL REFERENCES printer_profiles(machine_id) ON DELETE CASCADE,
    observed_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    configuration_version bigint NOT NULL CHECK (configuration_version > 0),
    snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND octet_length(snapshot::text) <= 65536)
);

CREATE INDEX printer_live_statuses_machine_idx ON printer_live_statuses (machine_id, received_at DESC);

-- +goose Down
DROP TABLE printer_live_statuses;
ALTER TABLE printer_input_units
    DROP CONSTRAINT printer_input_units_nozzle_check,
    DROP COLUMN nozzle;
ALTER TABLE printer_profiles
    DROP CONSTRAINT printer_profiles_model_check,
    DROP COLUMN model;
ALTER TABLE machine_types DROP COLUMN printer;
