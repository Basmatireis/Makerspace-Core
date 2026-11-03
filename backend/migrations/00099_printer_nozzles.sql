-- +goose Up
-- How many nozzles a printer has, and which nozzle (1-based) each spool input unit and slot feeds. Core only stores
-- them; the index never exceeds the printer's count (checked by the service, which sees both rows).
ALTER TABLE printer_profiles ADD COLUMN nozzle_count integer NOT NULL DEFAULT 1 CHECK (nozzle_count BETWEEN 1 AND 8);
ALTER TABLE printer_input_units ADD COLUMN nozzle_index integer NOT NULL DEFAULT 1 CHECK (nozzle_index BETWEEN 1 AND 8);
ALTER TABLE printer_slots ADD COLUMN nozzle_index integer NOT NULL DEFAULT 1 CHECK (nozzle_index BETWEEN 1 AND 8);
-- A unit that named the right nozzle feeds nozzle 2 of a dual-nozzle printer.
UPDATE printer_input_units SET nozzle_index = 2 WHERE nozzle = 'right';
UPDATE printer_slots s SET nozzle_index = u.nozzle_index
FROM printer_input_units u WHERE u.id = s.input_unit_id AND u.nozzle_index <> 1;
UPDATE printer_profiles p SET nozzle_count = 2
WHERE p.model = 'bambu_h2d'
   OR EXISTS (SELECT 1 FROM printer_input_units u WHERE u.machine_id = p.machine_id AND u.nozzle IS NOT NULL);

-- +goose Down
ALTER TABLE printer_slots DROP COLUMN nozzle_index;
ALTER TABLE printer_input_units DROP COLUMN nozzle_index;
ALTER TABLE printer_profiles DROP COLUMN nozzle_count;
