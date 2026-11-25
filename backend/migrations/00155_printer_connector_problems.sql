-- +goose Up
-- What the printer_connector_problem notification last saw for an assignment: the kind of problem (offline, storage,
-- connection, other), its diagnostic code, since when it lasts and when it was notified. The scheduler job
-- printerconnectors.problems fills these from the heartbeat facts; they are operational state, not audited.
ALTER TABLE printer_connector_assignments
    ADD COLUMN problem_kind text,
    ADD COLUMN problem_code text,
    ADD COLUMN problem_since timestamptz,
    ADD COLUMN problem_notified_at timestamptz,
    ADD CONSTRAINT printer_connector_assignments_problem_kind
        CHECK (problem_kind IS NULL OR problem_kind IN ('offline', 'storage', 'connection', 'other')),
    ADD CONSTRAINT printer_connector_assignments_problem_code_length
        CHECK (problem_code IS NULL OR length(problem_code) <= 80),
    ADD CONSTRAINT printer_connector_assignments_problem_since
        CHECK ((problem_kind IS NULL) = (problem_since IS NULL));

-- +goose Down
ALTER TABLE printer_connector_assignments
    DROP CONSTRAINT printer_connector_assignments_problem_since,
    DROP CONSTRAINT printer_connector_assignments_problem_code_length,
    DROP CONSTRAINT printer_connector_assignments_problem_kind,
    DROP COLUMN problem_notified_at,
    DROP COLUMN problem_since,
    DROP COLUMN problem_code,
    DROP COLUMN problem_kind;
