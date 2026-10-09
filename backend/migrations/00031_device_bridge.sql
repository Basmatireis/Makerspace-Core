-- +goose Up
ALTER TABLE managed_devices
    ADD COLUMN allowed_app_modes text[] NOT NULL DEFAULT ARRAY['staff_ui']::text[],
    ADD CONSTRAINT managed_devices_allowed_app_modes_check CHECK (
        cardinality(allowed_app_modes) > 0
        AND cardinality(allowed_app_modes) <= 2
        AND allowed_app_modes <@ ARRAY['visitor_terminal', 'staff_ui']::text[]
        AND (cardinality(allowed_app_modes) = 1 OR allowed_app_modes[1] <> allowed_app_modes[2])
    );

UPDATE managed_devices
SET allowed_app_modes = ARRAY['visitor_terminal', 'staff_ui']::text[]
WHERE terminal_enabled;

ALTER TABLE managed_devices
    ADD CONSTRAINT managed_devices_terminal_mode_check CHECK (
        NOT terminal_enabled OR 'visitor_terminal' = ANY(allowed_app_modes)
    );

CREATE TABLE managed_device_hardware_reports (
    managed_device_id uuid PRIMARY KEY REFERENCES managed_devices(id) ON DELETE CASCADE,
    platform text NOT NULL CHECK (platform IN ('desktop', 'android')),
    bridge_version text NOT NULL CHECK (
        bridge_version = btrim(bridge_version)
        AND bridge_version <> ''
        AND length(bridge_version) <= 40
    ),
    reported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE managed_device_reported_capabilities (
    managed_device_id uuid NOT NULL REFERENCES managed_device_hardware_reports(managed_device_id) ON DELETE CASCADE,
    capability text NOT NULL CHECK (capability IN ('nfc', 'camera', 'qr', 'barcode', 'scale', 'label_printer')),
    PRIMARY KEY (managed_device_id, capability)
);

-- +goose Down
DROP TABLE managed_device_reported_capabilities;
DROP TABLE managed_device_hardware_reports;
ALTER TABLE managed_devices DROP CONSTRAINT managed_devices_terminal_mode_check;
ALTER TABLE managed_devices DROP CONSTRAINT managed_devices_allowed_app_modes_check;
ALTER TABLE managed_devices DROP COLUMN allowed_app_modes;
