-- +goose Up
ALTER TABLE event_files
    ADD COLUMN is_banner boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX event_files_one_banner_per_event_idx
    ON event_files (event_id)
    WHERE is_banner;

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM event_files WHERE is_banner LIMIT 1) THEN
        RAISE EXCEPTION 'cannot remove Event banner support while an Event banner is configured';
    END IF;
END $$;
-- +goose StatementEnd

DROP INDEX event_files_one_banner_per_event_idx;
ALTER TABLE event_files DROP COLUMN is_banner;
