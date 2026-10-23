-- +goose Up
-- A role with a staffing level can lower or raise the open-day minimum of the people holding it. NULL means the role
-- uses the general minimum of the open-day requirements.
ALTER TABLE roles
    ADD COLUMN min_open_days_per_semester integer
        CONSTRAINT roles_min_open_days_per_semester_range CHECK (min_open_days_per_semester BETWEEN 0 AND 20),
    ADD CONSTRAINT roles_min_open_days_requires_staffing_level
        CHECK (min_open_days_per_semester IS NULL OR staffing_level IS NOT NULL);

-- +goose Down
ALTER TABLE roles
    DROP CONSTRAINT roles_min_open_days_requires_staffing_level,
    DROP COLUMN min_open_days_per_semester;
