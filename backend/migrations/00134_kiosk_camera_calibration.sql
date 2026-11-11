-- +goose Up
-- How a kiosk tablet uses its front camera for profile photos and where its lens is. Tablets differ (the lens is
-- centred on one, at the side on another), so the square photo crop and an on-screen pointer to the lens are calibrated
-- per device on the tablet itself. A missing row or NULL group means the default: the centred largest square, and no
-- pointer. `calibration_expires_at` is the short window an administrator opens during which the tablet may save its own
-- calibration with its device credential; saving or cancelling clears it.
CREATE TABLE managed_device_camera_settings (
    managed_device_id uuid PRIMARY KEY REFERENCES managed_devices (id) ON DELETE CASCADE,
    crop_center_x double precision,
    crop_center_y double precision,
    crop_size double precision,
    indicator_edge text,
    indicator_offset double precision,
    calibration_expires_at timestamptz,
    updated_at timestamptz NOT NULL,
    CONSTRAINT managed_device_camera_settings_crop_check CHECK (
        (crop_center_x IS NULL AND crop_center_y IS NULL AND crop_size IS NULL)
        OR (crop_center_x BETWEEN 0 AND 1 AND crop_center_y BETWEEN 0 AND 1 AND crop_size BETWEEN 0.2 AND 1)),
    CONSTRAINT managed_device_camera_settings_indicator_check CHECK (
        (indicator_edge IS NULL AND indicator_offset IS NULL)
        OR (indicator_edge IN ('top', 'right', 'bottom', 'left') AND indicator_offset BETWEEN 0 AND 100))
);

-- +goose Down
DROP TABLE managed_device_camera_settings;
