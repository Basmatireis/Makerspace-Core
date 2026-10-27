-- +goose Up
-- file_upload: the kiosk's browser can pick a file, which needs no hardware. Enrollment offers a profile photo upload
-- only on devices with this capability.
ALTER TABLE managed_device_capabilities DROP CONSTRAINT managed_device_capabilities_capability_check;
ALTER TABLE managed_device_capabilities ADD CONSTRAINT managed_device_capabilities_capability_check
    CHECK (capability IN ('nfc', 'camera', 'qr', 'barcode', 'scale', 'label_printer', 'file_upload'));
ALTER TABLE managed_device_reported_capabilities DROP CONSTRAINT managed_device_reported_capabilities_capability_check;
ALTER TABLE managed_device_reported_capabilities ADD CONSTRAINT managed_device_reported_capabilities_capability_check
    CHECK (capability IN ('nfc', 'camera', 'qr', 'barcode', 'scale', 'label_printer', 'file_upload'));

-- +goose Down
DELETE FROM managed_device_capabilities WHERE capability = 'file_upload';
DELETE FROM managed_device_reported_capabilities WHERE capability = 'file_upload';
ALTER TABLE managed_device_capabilities DROP CONSTRAINT managed_device_capabilities_capability_check;
ALTER TABLE managed_device_capabilities ADD CONSTRAINT managed_device_capabilities_capability_check
    CHECK (capability IN ('nfc', 'camera', 'qr', 'barcode', 'scale', 'label_printer'));
ALTER TABLE managed_device_reported_capabilities DROP CONSTRAINT managed_device_reported_capabilities_capability_check;
ALTER TABLE managed_device_reported_capabilities ADD CONSTRAINT managed_device_reported_capabilities_capability_check
    CHECK (capability IN ('nfc', 'camera', 'qr', 'barcode', 'scale', 'label_printer'));
