-- +goose Up
-- A reported consumption line fed by two or more spools during one print (an AMS refill, a reloaded tray, a new
-- RFID tag) carries one segment per spool with its own slot, start time and share of the line's quantity. The line
-- row keeps the line's totals and no spool; Core books each segment on the spool it resolves to at the segment's
-- start. Segments belong to one report revision through their line, so a newer revision replaces them with it.
CREATE TABLE machine_run_reported_usage_segments (
    id uuid PRIMARY KEY,
    item_id uuid NOT NULL REFERENCES machine_run_reported_usage_items(id) ON DELETE CASCADE,
    segment_index integer NOT NULL CHECK (segment_index >= 0),
    input_unit_external_id text CHECK (input_unit_external_id IS NULL OR length(input_unit_external_id) <= 200),
    slot_external_id text CHECK (slot_external_id IS NULL OR length(slot_external_id) <= 200),
    started_at timestamptz NOT NULL,
    start_layer integer CHECK (start_layer IS NULL OR start_layer >= 0),
    estimated_quantity_g numeric(20, 6) CHECK (estimated_quantity_g IS NULL OR estimated_quantity_g >= 0),
    split text CHECK (split IS NULL OR (split IN ('gcode_layer', 'progress') AND estimated_quantity_g IS NOT NULL)),
    spool_id uuid REFERENCES filament_spools(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (item_id, segment_index)
);
-- The spool read model looks up the segments a spool fed to flag one that ran out during a print.
CREATE INDEX machine_run_reported_usage_segments_spool_idx ON machine_run_reported_usage_segments (spool_id)
    WHERE spool_id IS NOT NULL;

-- +goose Down
DROP TABLE machine_run_reported_usage_segments;
