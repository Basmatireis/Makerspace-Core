-- +goose Up
-- Membership system roles: every person holds exactly one of Supervisor, Trainee or Visitor (master stays an
-- additional system role). Membership replaces the staffing level of roles; the open-day requirements settings
-- become the staffing rules with per-role exceptions and per-period excusals.

ALTER TABLE roles DROP CONSTRAINT roles_system_key_check;
ALTER TABLE roles DROP CONSTRAINT roles_check;

-- Staffing rules replace the open-day requirements settings.
CREATE TABLE staffing_rules (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    supervisor_minimum integer NOT NULL DEFAULT 2 CHECK (supervisor_minimum BETWEEN 0 AND 20),
    trainee_minimum integer NOT NULL DEFAULT 2 CHECK (trainee_minimum BETWEEN 0 AND 20),
    trainee_ready_after integer NOT NULL DEFAULT 3 CHECK (trainee_ready_after BETWEEN 1 AND 20),
    warning_window_days integer NOT NULL DEFAULT 14 CHECK (warning_window_days BETWEEN 1 AND 60),
    count_by text NOT NULL DEFAULT 'timeslot' CHECK (count_by IN ('timeslot', 'open_day')),
    default_deadline text NOT NULL DEFAULT 'period_end'
        CHECK (default_deadline IN ('period_end', 'two_weeks_before_end')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- The data mapping below sets system keys on existing roles, which the protection trigger rejects.
ALTER TABLE roles DISABLE TRIGGER roles_protect_system_role;

-- +goose StatementBegin
DO $$
DECLARE
    supervisor_role uuid;
    trainee_role uuid;
    visitor_role uuid;
    candidate uuid;
    found integer;
    fixed record;
    suffix integer;
    replacement text;
BEGIN
    -- Supervisor: the role promotions assigned when it still has the supervisor level, else the only
    -- supervisor-level role, else a new role.
    SELECT r.id INTO supervisor_role
    FROM open_day_requirements o
    JOIN roles r ON r.id = o.supervisor_role_id AND r.staffing_level = 'supervisor' AND r.system_key IS NULL;
    IF supervisor_role IS NULL THEN
        SELECT count(*) INTO found FROM roles WHERE staffing_level = 'supervisor' AND system_key IS NULL;
        IF found = 1 THEN
            SELECT id INTO supervisor_role FROM roles WHERE staffing_level = 'supervisor' AND system_key IS NULL;
        END IF;
    END IF;
    -- Trainee: the only trainee-level role, else a new role.
    SELECT count(*) INTO found FROM roles WHERE staffing_level = 'trainee' AND system_key IS NULL;
    IF found = 1 THEN
        SELECT id INTO trainee_role FROM roles WHERE staffing_level = 'trainee' AND system_key IS NULL;
    END IF;
    -- Visitor: the role visitor enrollment granted when it does not staff, else a new role.
    SELECT c.initial_role_id INTO candidate
    FROM visitor_enrollment_configuration c
    JOIN roles r ON r.id = c.initial_role_id AND r.system_key IS NULL AND r.staffing_level IS NULL;
    IF candidate IS NOT NULL AND candidate IS DISTINCT FROM supervisor_role AND candidate IS DISTINCT FROM trainee_role THEN
        visitor_role := candidate;
    END IF;

    -- Without a clear choice, an existing role that already carries the fixed name (and fits the level) becomes
    -- that membership role instead of being renamed to "<name> (custom)".
    IF supervisor_role IS NULL THEN
        SELECT id INTO supervisor_role FROM roles
        WHERE lower(name) = 'supervisor' AND system_key IS NULL AND staffing_level IS DISTINCT FROM 'trainee';
    END IF;
    IF trainee_role IS NULL THEN
        SELECT id INTO trainee_role FROM roles
        WHERE lower(name) = 'trainee' AND system_key IS NULL AND staffing_level IS DISTINCT FROM 'supervisor'
          AND id IS DISTINCT FROM supervisor_role;
    END IF;
    IF visitor_role IS NULL THEN
        SELECT id INTO visitor_role FROM roles
        WHERE lower(name) = 'visitor' AND system_key IS NULL AND staffing_level IS NULL
          AND id IS DISTINCT FROM supervisor_role AND id IS DISTINCT FROM trainee_role;
    END IF;

    IF supervisor_role IS NULL THEN
        supervisor_role := uuidv7();
        INSERT INTO roles (id, name) VALUES (supervisor_role, 'Supervisor (membership)');
    END IF;
    IF trainee_role IS NULL THEN
        trainee_role := uuidv7();
        INSERT INTO roles (id, name) VALUES (trainee_role, 'Trainee (membership)');
    END IF;
    IF visitor_role IS NULL THEN
        visitor_role := uuidv7();
        INSERT INTO roles (id, name) VALUES (visitor_role, 'Visitor (membership)');
    END IF;

    -- The chosen roles take the fixed names; another role already using a fixed name becomes "<name> (custom)".
    FOR fixed IN
        SELECT * FROM (VALUES (supervisor_role, 'Supervisor', 'supervisor'), (trainee_role, 'Trainee', 'trainee'),
            (visitor_role, 'Visitor', 'visitor')) AS v(role_id, role_name, role_key)
    LOOP
        IF EXISTS (SELECT 1 FROM roles WHERE lower(name) = lower(fixed.role_name) AND id <> fixed.role_id) THEN
            suffix := 1;
            replacement := fixed.role_name || ' (custom)';
            WHILE EXISTS (SELECT 1 FROM roles WHERE lower(name) = lower(replacement)) LOOP
                suffix := suffix + 1;
                replacement := fixed.role_name || ' (custom ' || suffix || ')';
            END LOOP;
            UPDATE roles SET name = replacement, version = version + 1, updated_at = now()
            WHERE lower(name) = lower(fixed.role_name) AND id <> fixed.role_id;
        END IF;
        UPDATE roles SET name = fixed.role_name, system_key = fixed.role_key, version = version + 1, updated_at = now()
        WHERE id = fixed.role_id;
    END LOOP;

    -- The new rules keep the minimum a chosen role overrode for its holders as the minimum of its membership.
    INSERT INTO staffing_rules (
        singleton, supervisor_minimum, trainee_minimum, trainee_ready_after, version, updated_by_account_id, updated_at
    )
    SELECT true,
        COALESCE((SELECT min_open_days_per_semester FROM roles WHERE id = supervisor_role), o.min_open_days_per_semester),
        COALESCE((SELECT min_open_days_per_semester FROM roles WHERE id = trainee_role), o.min_open_days_per_semester),
        o.trainee_open_days_for_promotion, o.version, o.updated_by_account_id, o.updated_at
    FROM open_day_requirements o;
    INSERT INTO staffing_rules (singleton) SELECT true WHERE NOT EXISTS (SELECT 1 FROM staffing_rules);

    -- Each person's membership: supervisor when any role had the supervisor level, else trainee when any had the
    -- trainee level, else visitor.
    CREATE TEMP TABLE computed_membership ON COMMIT DROP AS
    SELECT p.id AS person_id,
        CASE
            WHEN EXISTS (
                SELECT 1 FROM person_roles pr JOIN roles r ON r.id = pr.role_id
                WHERE pr.person_id = p.id AND (r.staffing_level = 'supervisor' OR r.id = supervisor_role)
            ) THEN supervisor_role
            WHEN EXISTS (
                SELECT 1 FROM person_roles pr JOIN roles r ON r.id = pr.role_id
                WHERE pr.person_id = p.id AND (r.staffing_level = 'trainee' OR r.id = trainee_role)
            ) THEN trainee_role
            ELSE visitor_role
        END AS role_id
    FROM people p;

    DELETE FROM person_roles pr
    WHERE pr.role_id IN (supervisor_role, trainee_role, visitor_role)
      AND NOT EXISTS (
          SELECT 1 FROM computed_membership c WHERE c.person_id = pr.person_id AND c.role_id = pr.role_id
      );
    INSERT INTO person_roles (person_id, role_id)
    SELECT person_id, role_id FROM computed_membership
    ON CONFLICT (person_id, role_id) DO NOTHING;

    -- Membership decides eligibility from now on; role lists keep only extra roles as a restriction.
    DELETE FROM open_day_staff_requirement_roles
    WHERE role_id IN (supervisor_role, trainee_role, visitor_role);

    DROP TABLE computed_membership;
END $$;
-- +goose StatementEnd

ALTER TABLE roles
    ADD CONSTRAINT roles_system_key_check
        CHECK (system_key IS NULL OR system_key IN ('master', 'supervisor', 'trainee', 'visitor')),
    ADD CONSTRAINT roles_system_name_check CHECK (
        system_key IS NULL
        OR (system_key = 'master' AND name = 'master')
        OR (system_key = 'supervisor' AND name = 'Supervisor')
        OR (system_key = 'trainee' AND name = 'Trainee')
        OR (system_key = 'visitor' AND name = 'Visitor')
    );

-- Master stays immutable. Membership roles keep their key and name and cannot be deleted; their description,
-- behaviours and permissions stay editable.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION prevent_system_role_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.system_key IS NOT NULL THEN
            RAISE EXCEPTION 'system roles cannot be created' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD.system_key IS DISTINCT FROM NEW.system_key THEN
            RAISE EXCEPTION 'system role keys are immutable' USING ERRCODE = '23514';
        END IF;
        IF OLD.system_key = 'master' THEN
            RAISE EXCEPTION 'system roles are immutable' USING ERRCODE = '23514';
        END IF;
        IF OLD.system_key IS NOT NULL AND NEW.name IS DISTINCT FROM OLD.name THEN
            RAISE EXCEPTION 'membership roles cannot be renamed' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.system_key IS NOT NULL THEN
        RAISE EXCEPTION 'system roles cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END;
$$;
-- +goose StatementEnd

ALTER TABLE roles ENABLE TRIGGER roles_protect_system_role;

-- Every new person starts as a visitor, whichever path creates them.
-- +goose StatementBegin
CREATE FUNCTION assign_visitor_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO person_roles (person_id, role_id)
    SELECT NEW.id, r.id FROM roles r WHERE r.system_key = 'visitor';
    RETURN NULL;
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER people_assign_visitor_membership
AFTER INSERT ON people
FOR EACH ROW EXECUTE FUNCTION assign_visitor_membership();

-- Exactly one membership role per existing person, checked at commit so a switch may remove and add in any order.
-- +goose StatementBegin
CREATE FUNCTION check_person_membership(subject uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    memberships integer;
BEGIN
    IF subject IS NULL OR NOT EXISTS (SELECT 1 FROM people WHERE id = subject) THEN
        RETURN;
    END IF;
    SELECT count(*) INTO memberships
    FROM person_roles pr
    JOIN roles r ON r.id = pr.role_id
    WHERE pr.person_id = subject AND r.system_key IN ('supervisor', 'trainee', 'visitor');
    IF memberships <> 1 THEN
        RAISE EXCEPTION 'every person holds exactly one membership role'
            USING ERRCODE = '23514', CONSTRAINT = 'person_roles_one_membership';
    END IF;
END;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION enforce_person_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'people' THEN
        PERFORM check_person_membership(NEW.id);
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM check_person_membership(OLD.person_id);
    ELSIF TG_OP = 'UPDATE' THEN
        PERFORM check_person_membership(OLD.person_id);
        IF NEW.person_id IS DISTINCT FROM OLD.person_id THEN
            PERFORM check_person_membership(NEW.person_id);
        END IF;
    ELSE
        PERFORM check_person_membership(NEW.person_id);
    END IF;
    RETURN NULL;
END;
$$;
-- +goose StatementEnd

CREATE CONSTRAINT TRIGGER person_roles_one_membership
AFTER INSERT OR UPDATE OR DELETE ON person_roles
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_person_membership();

CREATE CONSTRAINT TRIGGER people_one_membership
AFTER INSERT ON people
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_person_membership();

-- People merge and SCIM reconciliation unite role sets; the highest membership (supervisor > trainee > visitor)
-- stays and the others are removed.
-- +goose StatementBegin
CREATE FUNCTION normalize_person_membership(subject uuid) RETURNS void
LANGUAGE sql AS $$
    DELETE FROM person_roles pr
    USING roles r
    WHERE pr.person_id = subject AND r.id = pr.role_id AND r.system_key IN ('supervisor', 'trainee', 'visitor')
      AND r.system_key <> (
          SELECT best.system_key
          FROM person_roles bp
          JOIN roles best ON best.id = bp.role_id
          WHERE bp.person_id = subject AND best.system_key IN ('supervisor', 'trainee', 'visitor')
          ORDER BY CASE best.system_key WHEN 'supervisor' THEN 0 WHEN 'trainee' THEN 1 ELSE 2 END
          LIMIT 1
      );
$$;
-- +goose StatementEnd

-- An extra role may lower the minimum of the people holding it; system roles never have an exception.
CREATE TABLE staffing_rule_exceptions (
    role_id uuid PRIMARY KEY REFERENCES roles(id) ON DELETE CASCADE,
    minimum integer NOT NULL CHECK (minimum BETWEEN 0 AND 20)
);

-- +goose StatementBegin
CREATE FUNCTION prevent_system_role_staffing_exception() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM roles WHERE id = NEW.role_id AND system_key IS NOT NULL) THEN
        RAISE EXCEPTION 'system roles cannot have a staffing exception' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER staffing_rule_exceptions_reject_system_role
BEFORE INSERT OR UPDATE ON staffing_rule_exceptions
FOR EACH ROW EXECUTE FUNCTION prevent_system_role_staffing_exception();

INSERT INTO staffing_rule_exceptions (role_id, minimum)
SELECT id, min_open_days_per_semester FROM roles
WHERE min_open_days_per_semester IS NOT NULL AND system_key IS NULL;

-- A person excused for a period has no minimum in it.
CREATE TABLE staffing_excusals (
    period_id uuid NOT NULL REFERENCES open_day_periods(id) ON DELETE CASCADE,
    person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    reason text NOT NULL CHECK (reason = btrim(reason) AND length(reason) <= 500),
    created_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (period_id, person_id)
);

CREATE INDEX staffing_excusals_person_idx ON staffing_excusals (person_id, period_id);

DROP TABLE open_day_requirements;
ALTER TABLE roles DROP COLUMN min_open_days_per_semester;
ALTER TABLE roles DROP COLUMN staffing_level;

-- Visitor enrollment relies on the Visitor membership every new person gets.
ALTER TABLE visitor_enrollment_configuration DROP CONSTRAINT visitor_enrollment_configuration_check;
ALTER TABLE visitor_enrollment_configuration DROP COLUMN initial_role_id;
ALTER TABLE visitor_enrollment_configuration
    ADD CONSTRAINT visitor_enrollment_configuration_check CHECK (NOT enabled OR cardinality(allowed_methods) > 0);

-- +goose Down
ALTER TABLE visitor_enrollment_configuration DROP CONSTRAINT visitor_enrollment_configuration_check;
ALTER TABLE visitor_enrollment_configuration
    ADD COLUMN initial_role_id uuid REFERENCES roles(id) ON DELETE RESTRICT;

ALTER TABLE roles
    ADD COLUMN staffing_level text CHECK (staffing_level IN ('supervisor', 'trainee')),
    ADD COLUMN min_open_days_per_semester integer
        CONSTRAINT roles_min_open_days_per_semester_range CHECK (min_open_days_per_semester BETWEEN 0 AND 20),
    ADD CONSTRAINT roles_min_open_days_requires_staffing_level
        CHECK (min_open_days_per_semester IS NULL OR staffing_level IS NOT NULL);

CREATE TABLE open_day_requirements (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    min_open_days_per_semester integer NOT NULL DEFAULT 2 CHECK (min_open_days_per_semester BETWEEN 0 AND 20),
    trainee_open_days_for_promotion integer NOT NULL DEFAULT 3 CHECK (trainee_open_days_for_promotion BETWEEN 1 AND 20),
    supervisor_role_id uuid REFERENCES roles(id) ON DELETE SET NULL,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER people_one_membership ON people;
DROP TRIGGER person_roles_one_membership ON person_roles;
DROP TRIGGER people_assign_visitor_membership ON people;
DROP FUNCTION enforce_person_membership();
DROP FUNCTION check_person_membership(uuid);
DROP FUNCTION assign_visitor_membership();
DROP FUNCTION normalize_person_membership(uuid);

ALTER TABLE roles DISABLE TRIGGER roles_protect_system_role;

-- Exceptions of roles without a staffing level have no place in the old model and are dropped.
UPDATE roles SET staffing_level = system_key WHERE system_key IN ('supervisor', 'trainee');
UPDATE roles r SET min_open_days_per_semester = s.supervisor_minimum
FROM staffing_rules s WHERE r.system_key = 'supervisor' AND s.supervisor_minimum <> s.trainee_minimum;
UPDATE roles r SET min_open_days_per_semester = s.trainee_minimum
FROM staffing_rules s WHERE r.system_key = 'trainee' AND s.supervisor_minimum <> s.trainee_minimum;

INSERT INTO open_day_requirements (
    singleton, min_open_days_per_semester, trainee_open_days_for_promotion, supervisor_role_id, version,
    updated_by_account_id, updated_at
)
SELECT true, s.supervisor_minimum, s.trainee_ready_after, (SELECT id FROM roles WHERE system_key = 'supervisor'),
    s.version, s.updated_by_account_id, s.updated_at
FROM staffing_rules s;

UPDATE visitor_enrollment_configuration SET initial_role_id = (SELECT id FROM roles WHERE system_key = 'visitor');

-- Requirements that relied on membership get the former membership role as their eligible role.
INSERT INTO open_day_staff_requirement_roles (requirement_id, role_id)
SELECT q.id, r.id
FROM open_day_staff_requirements q
JOIN roles r ON r.system_key = q.kind
WHERE NOT EXISTS (SELECT 1 FROM open_day_staff_requirement_roles x WHERE x.requirement_id = q.id);

ALTER TABLE roles DROP CONSTRAINT roles_system_name_check;
ALTER TABLE roles DROP CONSTRAINT roles_system_key_check;
UPDATE roles SET system_key = NULL WHERE system_key IN ('supervisor', 'trainee', 'visitor');
ALTER TABLE roles
    ADD CONSTRAINT roles_system_key_check CHECK (system_key IS NULL OR system_key = 'master'),
    ADD CONSTRAINT roles_check CHECK (system_key IS NULL OR name = 'master');

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION prevent_system_role_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.system_key IS NOT NULL THEN
            RAISE EXCEPTION 'system roles cannot be created' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD.system_key IS NOT NULL OR NEW.system_key IS NOT NULL THEN
            RAISE EXCEPTION 'system roles are immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.system_key IS NOT NULL THEN
        RAISE EXCEPTION 'system roles cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END;
$$;
-- +goose StatementEnd

ALTER TABLE roles ENABLE TRIGGER roles_protect_system_role;

ALTER TABLE visitor_enrollment_configuration
    ADD CONSTRAINT visitor_enrollment_configuration_check
        CHECK (NOT enabled OR (initial_role_id IS NOT NULL AND cardinality(allowed_methods) > 0));

DROP TABLE staffing_excusals;
DROP TRIGGER staffing_rule_exceptions_reject_system_role ON staffing_rule_exceptions;
DROP FUNCTION prevent_system_role_staffing_exception();
DROP TABLE staffing_rule_exceptions;
DROP TABLE staffing_rules;
