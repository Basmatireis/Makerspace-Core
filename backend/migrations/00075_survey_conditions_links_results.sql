-- +goose Up
-- Surveys: conditional questions, share links for public surveys, response source, and editing/deleting a published
-- survey for as long as it has no responses.

-- +goose StatementBegin
CREATE FUNCTION survey_has_responses(p_survey_id uuid) RETURNS boolean
LANGUAGE sql STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM survey_responses r
        JOIN survey_versions v ON v.id = r.survey_version_id
        WHERE v.survey_id = p_survey_id
    );
$$;

-- A published version, its questions and options are immutable from the first response of the survey onwards. Before
-- that the survey may still be edited or deleted as a whole.
CREATE OR REPLACE FUNCTION enforce_survey_version_immutability() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.published_at IS NOT NULL AND survey_has_responses(OLD.survey_id) THEN
            RAISE EXCEPTION 'published survey versions are immutable'
                USING ERRCODE = '23514', CONSTRAINT = 'survey_versions_immutable_check';
        END IF;
        RETURN OLD;
    END IF;
    IF OLD.published_at IS NOT NULL THEN
        IF survey_has_responses(OLD.survey_id)
            OR NEW.published_at IS DISTINCT FROM OLD.published_at
            OR NEW.survey_id IS DISTINCT FROM OLD.survey_id
            OR NEW.revision IS DISTINCT FROM OLD.revision
            OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'published survey versions are immutable'
                USING ERRCODE = '23514', CONSTRAINT = 'survey_versions_immutable_check';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.published_at IS NOT NULL AND (
        NEW.survey_id IS DISTINCT FROM OLD.survey_id
        OR NEW.revision IS DISTINCT FROM OLD.revision
        OR NEW.title IS DISTINCT FROM OLD.title
        OR NEW.introduction IS DISTINCT FROM OLD.introduction
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    ) THEN
        RAISE EXCEPTION 'published survey versions are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'survey_versions_immutable_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_survey_question_immutability() RETURNS trigger
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
        WHERE id IN (old_version, new_version) AND published_at IS NOT NULL AND survey_has_responses(survey_id)
    ) THEN
        RAISE EXCEPTION 'published survey questions are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'survey_questions_immutable_check';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_survey_option_immutability() RETURNS trigger
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
            AND survey_has_responses(sv.survey_id)
    ) THEN
        RAISE EXCEPTION 'published survey options are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'survey_options_immutable_check';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;
-- +goose StatementEnd

-- Display condition of a question: it is shown only when the answer to an earlier question of the same version
-- matches. condition_option_ids hold options of the source question (choice operators), condition_number a rating
-- threshold, condition_boolean a yes/no answer.
ALTER TABLE survey_questions
    ADD COLUMN condition_question_id uuid,
    ADD COLUMN condition_operator text,
    ADD COLUMN condition_option_ids uuid[] NOT NULL DEFAULT '{}',
    ADD COLUMN condition_number integer,
    ADD COLUMN condition_boolean boolean,
    ADD CONSTRAINT survey_questions_id_version_key UNIQUE (id, survey_version_id),
    ADD CONSTRAINT survey_questions_condition_source_fkey
        FOREIGN KEY (condition_question_id, survey_version_id) REFERENCES survey_questions(id, survey_version_id),
    ADD CONSTRAINT survey_questions_condition_check CHECK (
        (condition_question_id IS NULL AND condition_operator IS NULL AND condition_number IS NULL
            AND condition_boolean IS NULL AND cardinality(condition_option_ids) = 0)
        OR (condition_question_id IS NOT NULL AND condition_question_id <> id AND (
            (condition_operator IN ('one_of', 'includes_any') AND cardinality(condition_option_ids) > 0
                AND condition_number IS NULL AND condition_boolean IS NULL)
            OR (condition_operator IN ('lte', 'gte', 'eq') AND condition_number IS NOT NULL
                AND cardinality(condition_option_ids) = 0 AND condition_boolean IS NULL)
            OR (condition_operator = 'eq' AND condition_boolean IS NOT NULL
                AND cardinality(condition_option_ids) = 0 AND condition_number IS NULL)
        ))
    );

-- A share link of a public survey. The token is HMAC-derived from the link id (like invitation tokens), so only its
-- digest is stored and an administrator can be shown the link again.
CREATE TABLE survey_share_links (
    id uuid PRIMARY KEY,
    survey_id uuid NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    label text CHECK (label IS NULL OR (label = btrim(label) AND label <> '' AND length(label) <= 120)),
    token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
    active boolean NOT NULL DEFAULT true,
    expires_at timestamptz,
    max_responses integer CHECK (max_responses IS NULL OR max_responses > 0),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX survey_share_links_survey_idx ON survey_share_links (survey_id, created_at, id);

-- Deleting a link keeps its responses; they stay attributed to the source `link` without a link id.
ALTER TABLE survey_responses
    ADD COLUMN source text NOT NULL DEFAULT 'invitation' CHECK (source IN ('invitation', 'link')),
    ADD COLUMN share_link_id uuid REFERENCES survey_share_links(id) ON DELETE SET NULL,
    ADD CONSTRAINT survey_responses_link_source_check CHECK (share_link_id IS NULL OR source = 'link');
CREATE INDEX survey_responses_share_link_idx ON survey_responses (share_link_id) WHERE share_link_id IS NOT NULL;

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM survey_share_links) OR EXISTS (SELECT 1 FROM survey_responses WHERE source <> 'invitation')
        OR EXISTS (SELECT 1 FROM survey_questions WHERE condition_question_id IS NOT NULL) THEN
        RAISE EXCEPTION 'cannot downgrade while survey share links, link responses, or conditions exist';
    END IF;
END $$;
-- +goose StatementEnd
DROP INDEX survey_responses_share_link_idx;
ALTER TABLE survey_responses
    DROP CONSTRAINT survey_responses_link_source_check,
    DROP COLUMN share_link_id,
    DROP COLUMN source;
DROP TABLE survey_share_links;
ALTER TABLE survey_questions
    DROP CONSTRAINT survey_questions_condition_check,
    DROP CONSTRAINT survey_questions_condition_source_fkey,
    DROP CONSTRAINT survey_questions_id_version_key,
    DROP COLUMN condition_boolean,
    DROP COLUMN condition_number,
    DROP COLUMN condition_option_ids,
    DROP COLUMN condition_operator,
    DROP COLUMN condition_question_id;
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION enforce_survey_version_immutability() RETURNS trigger
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

CREATE OR REPLACE FUNCTION enforce_survey_question_immutability() RETURNS trigger
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

CREATE OR REPLACE FUNCTION enforce_survey_option_immutability() RETURNS trigger
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
DROP FUNCTION survey_has_responses(uuid);
-- +goose StatementEnd
