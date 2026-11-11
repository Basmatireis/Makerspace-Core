-- +goose Up
-- Whether a kiosk mirrors its camera image horizontally, both in the live preview and in the captured photo. Many
-- front cameras deliver the unmirrored image, which feels wrong when people look at themselves.
ALTER TABLE managed_device_camera_settings ADD COLUMN mirror boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE managed_device_camera_settings DROP COLUMN mirror;
