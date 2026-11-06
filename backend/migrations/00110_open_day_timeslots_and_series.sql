-- +goose Up
-- An open day consists of one or more timeslots; staffing places and assignments belong to a timeslot. One person may
-- hold several timeslots of a day but only one place per timeslot. The day's own start and end stay as the overall
-- range of its timeslots. Weekly series describe how a period's days were generated; a day edited on its own leaves
-- its series and remembers which one it came from.

CREATE TABLE open_day_series (
    id uuid PRIMARY KEY,
    period_id uuid NOT NULL REFERENCES open_day_periods(id) ON DELETE CASCADE,
    weekday integer NOT NULL CHECK (weekday BETWEEN 1 AND 7),
    from_date date NOT NULL,
    until_date date NOT NULL,
    supervisor_places integer NOT NULL CHECK (supervisor_places BETWEEN 0 AND 100),
    trainee_places integer NOT NULL CHECK (trainee_places BETWEEN 0 AND 100),
    -- Holiday and break dates that get an open day on purpose.
    forced_dates date[] NOT NULL DEFAULT '{}' CHECK (cardinality(forced_dates) <= 100),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (from_date <= until_date),
    UNIQUE (id, period_id)
);

CREATE INDEX open_day_series_period_idx ON open_day_series (period_id, weekday, from_date, id);

-- The timeslot template of a series in makerspace wall-clock time.
CREATE TABLE open_day_series_timeslots (
    series_id uuid NOT NULL REFERENCES open_day_series(id) ON DELETE CASCADE,
    position integer NOT NULL CHECK (position BETWEEN 0 AND 23),
    start_time time NOT NULL,
    end_time time NOT NULL,
    PRIMARY KEY (series_id, position),
    CHECK (start_time < end_time)
);

-- Extra roles a series' places ask for; any one of them suffices.
CREATE TABLE open_day_series_roles (
    series_id uuid NOT NULL REFERENCES open_day_series(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('supervisor', 'trainee')),
    role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (series_id, kind, role_id)
);

CREATE INDEX open_day_series_roles_role_idx ON open_day_series_roles (role_id, series_id);

ALTER TABLE open_days
    ADD COLUMN series_id uuid,
    ADD COLUMN detached_from_series_id uuid,
    ADD CONSTRAINT open_days_series_fk FOREIGN KEY (series_id, period_id)
        REFERENCES open_day_series(id, period_id) ON DELETE SET NULL (series_id),
    ADD CONSTRAINT open_days_detached_series_fk FOREIGN KEY (detached_from_series_id, period_id)
        REFERENCES open_day_series(id, period_id) ON DELETE SET NULL (detached_from_series_id),
    ADD CONSTRAINT open_days_series_or_detached CHECK (series_id IS NULL OR detached_from_series_id IS NULL);

CREATE INDEX open_days_series_idx ON open_days (series_id, starts_at) WHERE series_id IS NOT NULL;
CREATE INDEX open_days_detached_series_idx ON open_days (detached_from_series_id)
    WHERE detached_from_series_id IS NOT NULL;

-- Overlapping scheduled days are rejected by the schedule service under the period lock; an exact duplicate is just
-- one case of that.
DROP INDEX open_days_exact_scheduled_slot_idx;

CREATE TABLE open_day_timeslots (
    id uuid PRIMARY KEY,
    open_day_id uuid NOT NULL REFERENCES open_days(id) ON DELETE CASCADE,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    position integer NOT NULL CHECK (position BETWEEN 0 AND 23),
    CHECK (starts_at < ends_at),
    CONSTRAINT open_day_timeslots_position_key UNIQUE (open_day_id, position) DEFERRABLE INITIALLY DEFERRED,
    UNIQUE (id, open_day_id)
);

CREATE INDEX open_day_timeslots_time_idx ON open_day_timeslots (starts_at, ends_at, id);

INSERT INTO open_day_timeslots (id, open_day_id, starts_at, ends_at, position)
SELECT uuidv7(), id, starts_at, ends_at, 0 FROM open_days;

ALTER TABLE open_day_staff_requirements ADD COLUMN timeslot_id uuid;
UPDATE open_day_staff_requirements r SET timeslot_id = t.id
FROM open_day_timeslots t WHERE t.open_day_id = r.open_day_id;
ALTER TABLE open_day_staff_requirements
    ALTER COLUMN timeslot_id SET NOT NULL,
    DROP CONSTRAINT open_day_staff_requirements_open_day_id_kind_key,
    ADD CONSTRAINT open_day_staff_requirements_timeslot_kind_key UNIQUE (timeslot_id, kind),
    ADD CONSTRAINT open_day_staff_requirements_id_timeslot_key UNIQUE (id, timeslot_id),
    ADD CONSTRAINT open_day_staff_requirements_timeslot_fk FOREIGN KEY (timeslot_id, open_day_id)
        REFERENCES open_day_timeslots(id, open_day_id) ON DELETE CASCADE;

ALTER TABLE open_day_assignments ADD COLUMN timeslot_id uuid;
UPDATE open_day_assignments a SET timeslot_id = r.timeslot_id
FROM open_day_staff_requirements r WHERE r.id = a.requirement_id;
ALTER TABLE open_day_assignments
    ALTER COLUMN timeslot_id SET NOT NULL,
    DROP CONSTRAINT open_day_assignments_open_day_id_person_id_key,
    ADD CONSTRAINT open_day_assignments_timeslot_person_key UNIQUE (timeslot_id, person_id),
    ADD CONSTRAINT open_day_assignments_requirement_timeslot_fk FOREIGN KEY (requirement_id, timeslot_id)
        REFERENCES open_day_staff_requirements(id, timeslot_id) ON DELETE CASCADE;

DROP INDEX open_day_assignments_person_idx;
CREATE INDEX open_day_assignments_person_idx ON open_day_assignments (person_id, open_day_id, timeslot_id);

-- Membership decides the kind of place; a restriction can only name extra roles.
DELETE FROM open_day_staff_requirement_roles rr USING roles r
WHERE r.id = rr.role_id AND r.system_key IS NOT NULL;

-- +goose StatementBegin
CREATE FUNCTION prevent_system_role_open_day_restriction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM roles WHERE id = NEW.role_id AND system_key IS NOT NULL) THEN
        RAISE EXCEPTION 'open-day places can only be restricted to extra roles' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER open_day_staff_requirement_roles_reject_system_role
BEFORE INSERT OR UPDATE ON open_day_staff_requirement_roles
FOR EACH ROW EXECUTE FUNCTION prevent_system_role_open_day_restriction();

CREATE TRIGGER open_day_series_roles_reject_system_role
BEFORE INSERT OR UPDATE ON open_day_series_roles
FOR EACH ROW EXECUTE FUNCTION prevent_system_role_open_day_restriction();

-- +goose Down
DROP TRIGGER open_day_series_roles_reject_system_role ON open_day_series_roles;
DROP TRIGGER open_day_staff_requirement_roles_reject_system_role ON open_day_staff_requirement_roles;
DROP FUNCTION prevent_system_role_open_day_restriction();

-- The old model has one range per day: each day keeps its first timeslot with its places and assignments.
DELETE FROM open_day_timeslots t
WHERE EXISTS (SELECT 1 FROM open_day_timeslots f WHERE f.open_day_id = t.open_day_id AND f.position < t.position);
UPDATE open_days d SET starts_at = t.starts_at, ends_at = t.ends_at
FROM open_day_timeslots t WHERE t.open_day_id = d.id;

DROP INDEX open_day_assignments_person_idx;
ALTER TABLE open_day_assignments
    DROP CONSTRAINT open_day_assignments_requirement_timeslot_fk,
    DROP CONSTRAINT open_day_assignments_timeslot_person_key,
    ADD CONSTRAINT open_day_assignments_open_day_id_person_id_key UNIQUE (open_day_id, person_id),
    DROP COLUMN timeslot_id;
CREATE INDEX open_day_assignments_person_idx ON open_day_assignments (person_id, open_day_id);

ALTER TABLE open_day_staff_requirements
    DROP CONSTRAINT open_day_staff_requirements_timeslot_fk,
    DROP CONSTRAINT open_day_staff_requirements_id_timeslot_key,
    DROP CONSTRAINT open_day_staff_requirements_timeslot_kind_key,
    ADD CONSTRAINT open_day_staff_requirements_open_day_id_kind_key UNIQUE (open_day_id, kind),
    DROP COLUMN timeslot_id;

DROP TABLE open_day_timeslots;

CREATE UNIQUE INDEX open_days_exact_scheduled_slot_idx
    ON open_days (period_id, starts_at, ends_at)
    WHERE status = 'scheduled';

DROP INDEX open_days_detached_series_idx;
DROP INDEX open_days_series_idx;
ALTER TABLE open_days
    DROP CONSTRAINT open_days_series_or_detached,
    DROP CONSTRAINT open_days_detached_series_fk,
    DROP CONSTRAINT open_days_series_fk,
    DROP COLUMN detached_from_series_id,
    DROP COLUMN series_id;

DROP TABLE open_day_series_roles;
DROP TABLE open_day_series_timeslots;
DROP TABLE open_day_series;
