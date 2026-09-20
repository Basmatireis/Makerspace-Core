-- +goose Up
ALTER TABLE people
    ADD COLUMN profile_image_file_id uuid REFERENCES files(id) ON DELETE RESTRICT,
    ADD COLUMN profile_image_source text
        CHECK (profile_image_source IS NULL OR profile_image_source IN ('terminal_capture', 'self_upload', 'admin_upload'));

ALTER TABLE people ADD CONSTRAINT people_profile_image_pair_check CHECK (
    (profile_image_file_id IS NULL AND profile_image_source IS NULL)
    OR (profile_image_file_id IS NOT NULL AND profile_image_source IS NOT NULL)
);

CREATE INDEX people_profile_image_file_idx ON people (profile_image_file_id)
    WHERE profile_image_file_id IS NOT NULL;

ALTER TABLE roles ADD COLUMN profile_image_required boolean NOT NULL DEFAULT false;

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM people WHERE profile_image_file_id IS NOT NULL) THEN
        RAISE EXCEPTION 'cannot downgrade while profile images are linked';
    END IF;
END $$;
-- +goose StatementEnd
ALTER TABLE roles DROP COLUMN profile_image_required;
DROP INDEX people_profile_image_file_idx;
ALTER TABLE people DROP CONSTRAINT people_profile_image_pair_check;
ALTER TABLE people DROP COLUMN profile_image_source;
ALTER TABLE people DROP COLUMN profile_image_file_id;
