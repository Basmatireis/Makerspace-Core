-- +goose Up
-- A role's staffing level replaces the supervisor-dashboard flag: it says whether people holding the role staff open
-- days as supervisors or as trainees (a new supervisor in their first semester). NULL means the role does not staff.
ALTER TABLE roles
    ADD COLUMN staffing_level text CHECK (staffing_level IN ('supervisor', 'trainee'));
UPDATE roles SET staffing_level = 'supervisor' WHERE supervisor_dashboard;
ALTER TABLE roles DROP COLUMN supervisor_dashboard;

-- Requirements every person with a staffing level has to meet per semester (an open-day period), editable in the UI.
CREATE TABLE open_day_requirements (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    min_open_days_per_semester integer NOT NULL DEFAULT 2 CHECK (min_open_days_per_semester BETWEEN 0 AND 20),
    trainee_open_days_for_promotion integer NOT NULL DEFAULT 3 CHECK (trainee_open_days_for_promotion BETWEEN 1 AND 20),
    supervisor_role_id uuid REFERENCES roles(id) ON DELETE SET NULL,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO open_day_requirements (singleton) VALUES (true);

-- +goose Down
DROP TABLE open_day_requirements;
ALTER TABLE roles ADD COLUMN supervisor_dashboard boolean NOT NULL DEFAULT false;
UPDATE roles SET supervisor_dashboard = true WHERE staffing_level = 'supervisor';
ALTER TABLE roles DROP COLUMN staffing_level;
