-- +goose Up
-- A Bambu spool carries two RFID chips with different chip UIDs but one shared tray_uuid, so the spool is
-- identified by that tray UUID instead of by one of its chip UIDs.
ALTER TABLE filament_spool_identifiers DROP CONSTRAINT filament_spool_identifiers_kind_check;
ALTER TABLE filament_spool_identifiers
    ADD CONSTRAINT filament_spool_identifiers_kind_check CHECK (kind IN ('barcode', 'qr', 'nfc', 'bambu_tray_uuid'));

-- +goose Down
DELETE FROM filament_spool_identifiers WHERE kind = 'bambu_tray_uuid';
ALTER TABLE filament_spool_identifiers DROP CONSTRAINT filament_spool_identifiers_kind_check;
ALTER TABLE filament_spool_identifiers
    ADD CONSTRAINT filament_spool_identifiers_kind_check CHECK (kind IN ('barcode', 'qr', 'nfc'));
