-- +goose Up
CREATE TABLE session_policies (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 120),
    idle_timeout_seconds integer NOT NULL CHECK (idle_timeout_seconds BETWEEN 60 AND 2592000),
    absolute_lifetime_seconds integer NOT NULL CHECK (absolute_lifetime_seconds BETWEEN 300 AND 7776000),
    post_session_destination text NOT NULL CHECK (post_session_destination IN ('login', 'visitor_terminal')),
    is_default boolean NOT NULL DEFAULT false,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (idle_timeout_seconds <= absolute_lifetime_seconds)
);
CREATE UNIQUE INDEX session_policies_name_ci_idx ON session_policies (lower(name));
CREATE UNIQUE INDEX session_policies_one_default_idx ON session_policies (is_default) WHERE is_default;

INSERT INTO session_policies (id, name, idle_timeout_seconds, absolute_lifetime_seconds, post_session_destination, is_default)
VALUES
    ('0199c3ad-0000-7000-8000-000000000001', 'Private devices', 259200, 604800, 'login', true),
    ('0199c3ad-0000-7000-8000-000000000002', 'Makerspace PCs', 2700, 43200, 'login', false),
    ('0199c3ad-0000-7000-8000-000000000003', 'Entrance terminal', 420, 43200, 'visitor_terminal', false);

ALTER TABLE managed_devices
    ADD COLUMN session_policy_id uuid REFERENCES session_policies(id) ON DELETE RESTRICT,
    ADD COLUMN terminal_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN check_in_assurance text NOT NULL DEFAULT 'low'
        CHECK (check_in_assurance IN ('low', 'normal', 'strong', 'strong_mfa')),
    ADD COLUMN check_out_assurance text NOT NULL DEFAULT 'low'
        CHECK (check_out_assurance IN ('low', 'normal', 'strong', 'strong_mfa')),
    ADD COLUMN checkout_mode text NOT NULL DEFAULT 'verified'
        CHECK (checkout_mode IN ('verified', 'public_tap'));
ALTER TABLE managed_devices
    ADD CONSTRAINT managed_devices_terminal_policy_check
    CHECK (NOT terminal_enabled OR session_policy_id IS NOT NULL);
CREATE INDEX managed_devices_session_policy_idx ON managed_devices (session_policy_id, id);

CREATE TABLE managed_device_capabilities (
    managed_device_id uuid NOT NULL REFERENCES managed_devices(id) ON DELETE CASCADE,
    capability text NOT NULL CHECK (capability IN ('nfc', 'camera', 'qr', 'barcode', 'scale', 'label_printer')),
    enabled boolean NOT NULL DEFAULT true,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (managed_device_id, capability)
);

ALTER TABLE sessions
    ADD COLUMN managed_device_id uuid REFERENCES managed_devices(id) ON DELETE SET NULL,
    ADD COLUMN session_policy_id uuid REFERENCES session_policies(id) ON DELETE SET NULL,
    ADD COLUMN session_policy_version bigint,
    ADD COLUMN idle_timeout_seconds integer,
    ADD COLUMN post_session_destination text;

UPDATE sessions
SET session_policy_id = '0199c3ad-0000-7000-8000-000000000001',
    session_policy_version = 1,
    idle_timeout_seconds = GREATEST(60, LEAST(2592000, extract(epoch FROM (idle_expires_at - last_seen_at))::integer)),
    post_session_destination = 'login';

ALTER TABLE sessions
	ALTER COLUMN session_policy_id SET DEFAULT '0199c3ad-0000-7000-8000-000000000001',
	ALTER COLUMN session_policy_version SET DEFAULT 1,
	ALTER COLUMN idle_timeout_seconds SET DEFAULT 259200,
	ALTER COLUMN post_session_destination SET DEFAULT 'login',
    ALTER COLUMN session_policy_version SET NOT NULL,
    ALTER COLUMN idle_timeout_seconds SET NOT NULL,
    ALTER COLUMN post_session_destination SET NOT NULL,
    ADD CONSTRAINT sessions_idle_timeout_check CHECK (idle_timeout_seconds BETWEEN 60 AND 2592000),
    ADD CONSTRAINT sessions_post_destination_check CHECK (post_session_destination IN ('login', 'visitor_terminal'));
CREATE INDEX sessions_managed_device_idx ON sessions (managed_device_id) WHERE revoked_at IS NULL;

CREATE TABLE visits (
    id uuid PRIMARY KEY,
    person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    checked_in_at timestamptz NOT NULL,
    checked_out_at timestamptz,
    check_in_device_id uuid REFERENCES managed_devices(id) ON DELETE SET NULL,
    check_out_device_id uuid REFERENCES managed_devices(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'checked_in' CHECK (status IN ('checked_in', 'checked_out', 'voided')),
    check_in_method text NOT NULL CHECK (check_in_method IN ('password', 'pin', 'oidc', 'nfc', 'supervisor')),
    check_out_method text CHECK (check_out_method IS NULL OR check_out_method IN ('password', 'pin', 'oidc', 'nfc', 'public_tap', 'supervisor')),
    check_in_assurance text NOT NULL CHECK (check_in_assurance IN ('low', 'normal', 'strong', 'strong_mfa')),
    check_out_assurance text CHECK (check_out_assurance IS NULL OR check_out_assurance IN ('low', 'normal', 'strong', 'strong_mfa')),
    admission_decision text NOT NULL CHECK (admission_decision IN ('admitted', 'warning')),
    laborordnung_version_id uuid REFERENCES laborordnung_versions(id) ON DELETE RESTRICT,
    checked_in_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    checked_out_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    correction_reason text CHECK (correction_reason IS NULL OR (correction_reason = btrim(correction_reason) AND correction_reason <> '' AND length(correction_reason) <= 500)),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((status = 'checked_in' AND checked_out_at IS NULL AND check_out_method IS NULL)
        OR (status = 'checked_out' AND checked_out_at IS NOT NULL AND check_out_method IS NOT NULL)
        OR status = 'voided'),
    CHECK (checked_out_at IS NULL OR checked_out_at >= checked_in_at),
    CHECK ((checked_out_at IS NULL) = (check_out_method IS NULL)),
    CHECK (status <> 'voided' OR correction_reason IS NOT NULL)
);
CREATE UNIQUE INDEX visits_one_open_person_idx ON visits (person_id) WHERE status = 'checked_in';
CREATE INDEX visits_presence_idx ON visits (checked_in_at, id) WHERE status = 'checked_in';
CREATE INDEX visits_reporting_idx ON visits (checked_in_at, checked_out_at, id) WHERE status <> 'voided';
CREATE INDEX visits_person_idx ON visits (person_id, checked_in_at DESC, id);

CREATE TABLE attendance_daily_statistics (
    day date PRIMARY KEY,
    visitor_count bigint NOT NULL DEFAULT 0 CHECK (visitor_count >= 0),
    daily_unique_visitors bigint NOT NULL DEFAULT 0 CHECK (daily_unique_visitors >= 0),
    visitor_seconds bigint NOT NULL DEFAULT 0 CHECK (visitor_seconds >= 0),
    completed_visit_count bigint NOT NULL DEFAULT 0 CHECK (completed_visit_count >= 0),
    completed_visit_seconds bigint NOT NULL DEFAULT 0 CHECK (completed_visit_seconds >= 0),
    peak_occupancy bigint NOT NULL DEFAULT 0 CHECK (peak_occupancy >= 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE surveys (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 160),
    description text CHECK (description IS NULL OR length(description) <= 2000),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed')),
    anonymous boolean NOT NULL DEFAULT true,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE survey_versions (
    id uuid PRIMARY KEY,
    survey_id uuid NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    revision integer NOT NULL CHECK (revision > 0),
    title text NOT NULL CHECK (title = btrim(title) AND title <> '' AND length(title) <= 200),
    introduction text CHECK (introduction IS NULL OR length(introduction) <= 5000),
    published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (survey_id, revision)
);

CREATE TABLE survey_questions (
    id uuid PRIMARY KEY,
    survey_version_id uuid NOT NULL REFERENCES survey_versions(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('single_choice', 'multiple_choice', 'free_text', 'rating', 'yes_no')),
    prompt text NOT NULL CHECK (prompt = btrim(prompt) AND prompt <> '' AND length(prompt) <= 1000),
    required boolean NOT NULL DEFAULT false,
    position integer NOT NULL CHECK (position > 0),
    rating_min integer,
    rating_max integer,
    UNIQUE (survey_version_id, position),
    CHECK ((kind = 'rating' AND rating_min IS NOT NULL AND rating_max IS NOT NULL AND rating_min < rating_max AND rating_min >= 0 AND rating_max <= 10)
        OR (kind <> 'rating' AND rating_min IS NULL AND rating_max IS NULL))
);

CREATE TABLE survey_question_options (
    id uuid PRIMARY KEY,
    question_id uuid NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
    label text NOT NULL CHECK (label = btrim(label) AND label <> '' AND length(label) <= 500),
    position integer NOT NULL CHECK (position > 0),
    UNIQUE (question_id, position),
    UNIQUE (id, question_id)
);

-- +goose StatementBegin
CREATE FUNCTION enforce_survey_version_immutability() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.published_at IS NOT NULL THEN
            RAISE EXCEPTION 'published survey versions are immutable'
                USING ERRCODE = '23514', CONSTRAINT = 'survey_versions_immutable_check';
        END IF;
        RETURN OLD;
    END IF;
    IF OLD.published_at IS NOT NULL OR (
        NEW.published_at IS NOT NULL AND (
            NEW.survey_id IS DISTINCT FROM OLD.survey_id
            OR NEW.revision IS DISTINCT FROM OLD.revision
            OR NEW.title IS DISTINCT FROM OLD.title
            OR NEW.introduction IS DISTINCT FROM OLD.introduction
            OR NEW.created_at IS DISTINCT FROM OLD.created_at
        )
    ) THEN
        RAISE EXCEPTION 'published survey versions are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'survey_versions_immutable_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER survey_versions_immutable_check
BEFORE UPDATE OR DELETE ON survey_versions
FOR EACH ROW EXECUTE FUNCTION enforce_survey_version_immutability();

CREATE FUNCTION enforce_survey_question_immutability() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    old_version uuid;
    new_version uuid;
BEGIN
    IF TG_OP <> 'INSERT' THEN old_version := OLD.survey_version_id; END IF;
    IF TG_OP <> 'DELETE' THEN new_version := NEW.survey_version_id; END IF;
    IF EXISTS (
        SELECT 1 FROM survey_versions
        WHERE id IN (old_version, new_version) AND published_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'published survey questions are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'survey_questions_immutable_check';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER survey_questions_immutable_check
BEFORE INSERT OR UPDATE OR DELETE ON survey_questions
FOR EACH ROW EXECUTE FUNCTION enforce_survey_question_immutability();

CREATE FUNCTION enforce_survey_option_immutability() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    old_question uuid;
    new_question uuid;
BEGIN
    IF TG_OP <> 'INSERT' THEN old_question := OLD.question_id; END IF;
    IF TG_OP <> 'DELETE' THEN new_question := NEW.question_id; END IF;
    IF EXISTS (
        SELECT 1
        FROM survey_questions q
        JOIN survey_versions sv ON sv.id = q.survey_version_id
        WHERE q.id IN (old_question, new_question) AND sv.published_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'published survey options are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'survey_options_immutable_check';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER survey_options_immutable_check
BEFORE INSERT OR UPDATE OR DELETE ON survey_question_options
FOR EACH ROW EXECUTE FUNCTION enforce_survey_option_immutability();
-- +goose StatementEnd

CREATE TABLE survey_triggers (
    id uuid PRIMARY KEY,
    survey_id uuid NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind = 'visit_checked_out'),
    enabled boolean NOT NULL DEFAULT false,
    delay_seconds integer NOT NULL DEFAULT 1800 CHECK (delay_seconds BETWEEN 0 AND 604800),
    cooldown_days integer NOT NULL DEFAULT 30 CHECK (cooldown_days BETWEEN 0 AND 3650),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (survey_id, kind)
);

CREATE TABLE survey_invitations (
    id uuid PRIMARY KEY,
    survey_version_id uuid NOT NULL REFERENCES survey_versions(id) ON DELETE CASCADE,
    person_id uuid REFERENCES people(id) ON DELETE CASCADE,
    visit_id uuid REFERENCES visits(id) ON DELETE CASCADE,
    token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
    recipient_email text CHECK (recipient_email IS NULL OR (recipient_email = btrim(recipient_email) AND recipient_email <> '' AND length(recipient_email) <= 254)),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivering', 'sent', 'failed', 'redeemed', 'expired', 'cancelled')),
    due_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    sent_at timestamptz,
    redeemed_at timestamptz,
    delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts BETWEEN 0 AND 10),
    delivery_claimed_at timestamptz,
    delivery_failure_code text CHECK (delivery_failure_code IS NULL OR length(delivery_failure_code) <= 100),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at > due_at),
    CHECK (person_id IS NOT NULL OR status IN ('redeemed', 'cancelled', 'expired'))
);
CREATE UNIQUE INDEX survey_invitations_visit_idx ON survey_invitations (survey_version_id, visit_id) WHERE visit_id IS NOT NULL;
CREATE INDEX survey_invitations_delivery_idx ON survey_invitations (status, due_at, id);
CREATE INDEX survey_invitations_person_idx ON survey_invitations (person_id, created_at DESC) WHERE person_id IS NOT NULL;

CREATE TABLE survey_responses (
    id uuid PRIMARY KEY,
    survey_version_id uuid NOT NULL REFERENCES survey_versions(id) ON DELETE RESTRICT,
    submitted_on date NOT NULL,
    identified_person_id uuid REFERENCES people(id) ON DELETE SET NULL
);
CREATE INDEX survey_responses_version_idx ON survey_responses (survey_version_id, submitted_on, id);

-- +goose StatementBegin
CREATE FUNCTION enforce_anonymous_survey_response() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.identified_person_id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM survey_versions sv
        JOIN surveys s ON s.id = sv.survey_id
        WHERE sv.id = NEW.survey_version_id AND s.anonymous
    ) THEN
        RAISE EXCEPTION 'anonymous survey responses cannot identify a person'
            USING ERRCODE = '23514', CONSTRAINT = 'survey_responses_anonymous_person_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER survey_responses_anonymous_person_check
BEFORE INSERT OR UPDATE OF survey_version_id, identified_person_id ON survey_responses
FOR EACH ROW EXECUTE FUNCTION enforce_anonymous_survey_response();
-- +goose StatementEnd

CREATE TABLE survey_answers (
    id uuid PRIMARY KEY,
    response_id uuid NOT NULL REFERENCES survey_responses(id) ON DELETE CASCADE,
    question_id uuid NOT NULL REFERENCES survey_questions(id) ON DELETE RESTRICT,
    option_id uuid,
    text_value text CHECK (text_value IS NULL OR length(text_value) <= 5000),
    numeric_value integer,
    boolean_value boolean,
    position integer NOT NULL DEFAULT 1 CHECK (position > 0),
    UNIQUE (response_id, question_id, position),
    FOREIGN KEY (option_id, question_id) REFERENCES survey_question_options(id, question_id) ON DELETE RESTRICT,
    CHECK (num_nonnulls(option_id, text_value, numeric_value, boolean_value) = 1)
);

-- +goose StatementBegin
CREATE FUNCTION enforce_survey_answer_question() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    question survey_questions%ROWTYPE;
    response_version uuid;
BEGIN
    SELECT * INTO question FROM survey_questions WHERE id = NEW.question_id;
    SELECT survey_version_id INTO response_version FROM survey_responses WHERE id = NEW.response_id;
    IF question.id IS NULL OR response_version IS NULL OR question.survey_version_id <> response_version THEN
        RAISE EXCEPTION 'survey answer question does not belong to the response version'
            USING ERRCODE = '23514', CONSTRAINT = 'survey_answers_version_check';
    END IF;
    IF (question.kind IN ('single_choice', 'multiple_choice') AND NEW.option_id IS NULL)
        OR (question.kind = 'free_text' AND NEW.text_value IS NULL)
        OR (question.kind = 'rating' AND (NEW.numeric_value IS NULL OR NEW.numeric_value < question.rating_min OR NEW.numeric_value > question.rating_max))
        OR (question.kind = 'yes_no' AND NEW.boolean_value IS NULL) THEN
        RAISE EXCEPTION 'survey answer value does not match its question type'
            USING ERRCODE = '23514', CONSTRAINT = 'survey_answers_kind_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER survey_answers_question_check
BEFORE INSERT OR UPDATE ON survey_answers
FOR EACH ROW EXECUTE FUNCTION enforce_survey_answer_question();
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM visits) OR EXISTS (SELECT 1 FROM surveys) OR EXISTS (SELECT 1 FROM survey_responses) THEN
        RAISE EXCEPTION 'cannot downgrade while terminal, attendance, or survey data exists';
    END IF;
END $$;
-- +goose StatementEnd
DROP TABLE survey_answers;
DROP FUNCTION enforce_survey_answer_question();
DROP TABLE survey_responses;
DROP FUNCTION enforce_anonymous_survey_response();
DROP TABLE survey_invitations;
DROP TABLE survey_triggers;
DROP TABLE survey_question_options;
DROP FUNCTION enforce_survey_option_immutability();
DROP TABLE survey_questions;
DROP FUNCTION enforce_survey_question_immutability();
DROP TABLE survey_versions;
DROP FUNCTION enforce_survey_version_immutability();
DROP TABLE surveys;
DROP TABLE attendance_daily_statistics;
DROP TABLE visits;
ALTER TABLE sessions DROP COLUMN post_session_destination, DROP COLUMN idle_timeout_seconds,
    DROP COLUMN session_policy_version, DROP COLUMN session_policy_id, DROP COLUMN managed_device_id;
DROP TABLE managed_device_capabilities;
ALTER TABLE managed_devices DROP COLUMN checkout_mode, DROP COLUMN check_out_assurance,
    DROP COLUMN check_in_assurance, DROP COLUMN terminal_enabled, DROP COLUMN session_policy_id;
DROP TABLE session_policies;
