-- +goose Up
-- The Android kiosk is gone; only the desktop shell reports hardware. Old Android reports are dropped, the devices stay.
DELETE FROM managed_device_hardware_reports WHERE platform = 'android';
ALTER TABLE managed_device_hardware_reports DROP CONSTRAINT managed_device_hardware_reports_platform_check;
ALTER TABLE managed_device_hardware_reports
    ADD CONSTRAINT managed_device_hardware_reports_platform_check CHECK (platform = 'desktop');

-- +goose Down
ALTER TABLE managed_device_hardware_reports DROP CONSTRAINT managed_device_hardware_reports_platform_check;
ALTER TABLE managed_device_hardware_reports
    ADD CONSTRAINT managed_device_hardware_reports_platform_check CHECK (platform IN ('desktop', 'android'));
