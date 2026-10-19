-- +goose Up
-- Managed-device application mode for digital-signage players. A signage player is a headless
-- display credential: it can never hold a staff session or act as a visitor terminal, so the mode
-- must be the device's only mode.
ALTER TABLE managed_devices DROP CONSTRAINT managed_devices_allowed_app_modes_check;
ALTER TABLE managed_devices ADD CONSTRAINT managed_devices_allowed_app_modes_check CHECK (
    cardinality(allowed_app_modes) > 0
    AND cardinality(allowed_app_modes) <= 2
    AND allowed_app_modes <@ ARRAY['visitor_terminal', 'staff_ui', 'signage_player']::text[]
    AND (cardinality(allowed_app_modes) = 1 OR allowed_app_modes[1] <> allowed_app_modes[2])
    AND (NOT ('signage_player' = ANY(allowed_app_modes)) OR allowed_app_modes = ARRAY['signage_player']::text[])
);

-- +goose Down
DELETE FROM signage_displays WHERE managed_device_id IN (SELECT id FROM managed_devices WHERE 'signage_player' = ANY(allowed_app_modes));
DELETE FROM managed_devices WHERE 'signage_player' = ANY(allowed_app_modes);
ALTER TABLE managed_devices DROP CONSTRAINT managed_devices_allowed_app_modes_check;
ALTER TABLE managed_devices ADD CONSTRAINT managed_devices_allowed_app_modes_check CHECK (
    cardinality(allowed_app_modes) > 0
    AND cardinality(allowed_app_modes) <= 2
    AND allowed_app_modes <@ ARRAY['visitor_terminal', 'staff_ui']::text[]
    AND (cardinality(allowed_app_modes) = 1 OR allowed_app_modes[1] <> allowed_app_modes[2])
);
