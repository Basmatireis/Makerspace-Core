-- +goose Up
ALTER TABLE visitor_enrollment_contexts
    ADD COLUMN lab_rules_version_id uuid REFERENCES laborordnung_versions(id) ON DELETE RESTRICT;

-- Existing unfinished contexts cannot prove which version was presented.
-- Invalidate those short-lived tokens so the terminal must start a fresh flow.
UPDATE visitor_enrollment_contexts SET used_at=now() WHERE used_at IS NULL;

-- +goose Down
-- An older application cannot honor an in-progress context's pinned version.
UPDATE visitor_enrollment_contexts SET used_at=now() WHERE used_at IS NULL;
ALTER TABLE visitor_enrollment_contexts DROP COLUMN lab_rules_version_id;
