-- name: ListSurveys :many
-- Search is a case-insensitive substring match; position() avoids LIKE wildcard escaping.
SELECT s.*, sv.id AS survey_version_id, sv.revision, sv.title, sv.introduction,
  (SELECT count(*) FROM survey_responses r JOIN survey_versions v ON v.id = r.survey_version_id
    WHERE v.survey_id = s.id) AS response_count,
  (SELECT count(*) FROM survey_share_links l WHERE l.survey_id = s.id) AS link_count
FROM surveys s
JOIN LATERAL (
  SELECT * FROM survey_versions WHERE survey_id = s.id ORDER BY revision DESC LIMIT 1
) sv ON true
WHERE (sqlc.narg(status)::text IS NULL OR s.status = sqlc.narg(status)::text)
  AND (sqlc.narg(search)::text IS NULL OR position(lower(sqlc.narg(search)::text) IN lower(s.name)) > 0
       OR position(lower(sqlc.narg(search)::text) IN lower(sv.title)) > 0)
ORDER BY
  CASE WHEN sqlc.arg(sort)::text = 'name' AND NOT sqlc.arg(descending)::boolean THEN lower(s.name) END ASC,
  CASE WHEN sqlc.arg(sort)::text = 'name' AND sqlc.arg(descending)::boolean THEN lower(s.name) END DESC,
  CASE WHEN sqlc.arg(sort)::text = 'status' AND NOT sqlc.arg(descending)::boolean THEN s.status END ASC,
  CASE WHEN sqlc.arg(sort)::text = 'status' AND sqlc.arg(descending)::boolean THEN s.status END DESC,
  CASE WHEN sqlc.arg(sort)::text = 'updatedAt' AND NOT sqlc.arg(descending)::boolean THEN s.updated_at END ASC,
  CASE WHEN sqlc.arg(sort)::text = 'updatedAt' AND sqlc.arg(descending)::boolean THEN s.updated_at END DESC,
  CASE WHEN sqlc.arg(sort)::text = 'responseCount' AND NOT sqlc.arg(descending)::boolean THEN
    (SELECT count(*) FROM survey_responses r JOIN survey_versions v ON v.id = r.survey_version_id
      WHERE v.survey_id = s.id) END ASC,
  CASE WHEN sqlc.arg(sort)::text = 'responseCount' AND sqlc.arg(descending)::boolean THEN
    (SELECT count(*) FROM survey_responses r JOIN survey_versions v ON v.id = r.survey_version_id
      WHERE v.survey_id = s.id) END DESC,
  s.updated_at DESC, s.id
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: CountSurveys :one
SELECT count(*) FROM surveys s
WHERE (sqlc.narg(status)::text IS NULL OR s.status = sqlc.narg(status)::text)
  AND (sqlc.narg(search)::text IS NULL OR position(lower(sqlc.narg(search)::text) IN lower(s.name)) > 0
       OR EXISTS (SELECT 1 FROM survey_versions lv WHERE lv.survey_id = s.id AND lv.revision = (SELECT max(x.revision) FROM survey_versions x WHERE x.survey_id = s.id)
                  AND position(lower(sqlc.narg(search)::text) IN lower(lv.title)) > 0));

-- name: GetSurvey :one
SELECT s.*, sv.id AS survey_version_id, sv.revision, sv.title, sv.introduction,
  (SELECT count(*) FROM survey_responses r JOIN survey_versions v ON v.id = r.survey_version_id
    WHERE v.survey_id = s.id) AS response_count,
  (SELECT count(*) FROM survey_share_links l WHERE l.survey_id = s.id) AS link_count
FROM surveys s
JOIN LATERAL (
  SELECT * FROM survey_versions WHERE survey_id = s.id ORDER BY revision DESC LIMIT 1
) sv ON true
WHERE s.id = sqlc.arg(id);

-- name: GetSurveyForUpdate :one
SELECT * FROM surveys WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: GetLatestSurveyVersionForUpdate :one
SELECT * FROM survey_versions WHERE survey_id = sqlc.arg(survey_id)
ORDER BY revision DESC LIMIT 1 FOR UPDATE;

-- name: ListSurveyQuestions :many
SELECT * FROM survey_questions WHERE survey_version_id = sqlc.arg(survey_version_id)
ORDER BY position, id;

-- name: ListSurveyOptions :many
SELECT * FROM survey_question_options WHERE question_id = sqlc.arg(question_id)
ORDER BY position, id;

-- name: CreateSurvey :one
INSERT INTO surveys (id, name, description, anonymous)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.narg(description), sqlc.arg(anonymous)) RETURNING *;

-- name: CreateSurveyVersion :one
INSERT INTO survey_versions (id, survey_id, revision, title, introduction)
VALUES (sqlc.arg(id), sqlc.arg(survey_id), sqlc.arg(revision), sqlc.arg(title), sqlc.narg(introduction)) RETURNING *;

-- name: CreateSurveyQuestion :one
INSERT INTO survey_questions (id, survey_version_id, kind, prompt, required, position, rating_min, rating_max,
  condition_question_id, condition_operator, condition_option_ids, condition_number, condition_boolean)
VALUES (sqlc.arg(id), sqlc.arg(survey_version_id), sqlc.arg(kind), sqlc.arg(prompt), sqlc.arg(required),
  sqlc.arg(position), sqlc.narg(rating_min), sqlc.narg(rating_max),
  sqlc.narg(condition_question_id), sqlc.narg(condition_operator), sqlc.arg(condition_option_ids)::text[]::uuid[],
  sqlc.narg(condition_number), sqlc.narg(condition_boolean)) RETURNING *;

-- name: CreateSurveyOption :one
INSERT INTO survey_question_options (id, question_id, label, position)
VALUES (sqlc.arg(id), sqlc.arg(question_id), sqlc.arg(label), sqlc.arg(position)) RETURNING *;

-- name: UpdateSurveyDefinition :one
-- Whether the survey may still be edited (draft, or no responses yet) is decided by the service under the row lock.
UPDATE surveys SET name = sqlc.arg(name), description = sqlc.narg(description), anonymous = sqlc.arg(anonymous),
  version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING *;

-- name: UpdateSurveyVersionDefinition :exec
UPDATE survey_versions SET title = sqlc.arg(title), introduction = sqlc.narg(introduction)
WHERE id = sqlc.arg(id);

-- name: SurveyHasResponses :one
SELECT survey_has_responses(sqlc.arg(survey_id)) AS has_responses;

-- name: LockSurveyShared :one
-- Submissions take this share lock before reading the questions so an edit or delete (FOR UPDATE) never interleaves.
SELECT id FROM surveys WHERE id = sqlc.arg(id) FOR SHARE;

-- name: DeleteSurvey :execrows
DELETE FROM surveys WHERE id = sqlc.arg(id);

-- name: ReopenSurvey :one
UPDATE surveys SET status = 'published', version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND status = 'closed' RETURNING *;

-- name: DeleteSurveyQuestions :exec
DELETE FROM survey_questions WHERE survey_version_id = sqlc.arg(survey_version_id);

-- name: PublishSurvey :one
UPDATE surveys SET status = 'published', version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND status = 'draft' RETURNING *;

-- name: MarkSurveyVersionPublished :exec
UPDATE survey_versions SET published_at = now() WHERE id = sqlc.arg(id) AND published_at IS NULL;

-- name: CloseSurvey :one
UPDATE surveys SET status = 'closed', version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND status = 'published' RETURNING *;

-- name: DisableSurveyTriggers :exec
UPDATE survey_triggers SET enabled = false, version = version + 1, updated_at = now()
WHERE survey_id = sqlc.arg(survey_id) AND enabled;

-- name: CancelSurveyInvitationsForSurvey :execrows
UPDATE survey_invitations si SET status = 'cancelled', person_id = NULL, visit_id = NULL,
  recipient_email = NULL, delivery_claimed_at = NULL
FROM survey_versions sv
WHERE si.survey_version_id = sv.id AND sv.survey_id = sqlc.arg(survey_id)
  AND si.status IN ('pending', 'delivering', 'sent', 'failed');

-- name: GetSurveyTrigger :one
SELECT * FROM survey_triggers WHERE survey_id = sqlc.arg(survey_id) AND kind = 'visit_checked_out';

-- name: CreateSurveyTrigger :one
INSERT INTO survey_triggers (id, survey_id, kind, enabled, delay_seconds, cooldown_days)
VALUES (sqlc.arg(id), sqlc.arg(survey_id), 'visit_checked_out', sqlc.arg(enabled),
  sqlc.arg(delay_seconds), sqlc.arg(cooldown_days)) RETURNING *;

-- name: UpdateSurveyTrigger :one
UPDATE survey_triggers SET enabled = sqlc.arg(enabled), delay_seconds = sqlc.arg(delay_seconds),
  cooldown_days = sqlc.arg(cooldown_days), version = version + 1, updated_at = now()
WHERE survey_id = sqlc.arg(survey_id) AND kind = 'visit_checked_out'
  AND version = sqlc.arg(expected_version) RETURNING *;

-- name: ListEligiblePostVisitTriggers :many
SELECT st.id AS trigger_id, sv.id AS survey_version_id, st.delay_seconds, st.cooldown_days, p.email
FROM survey_triggers st
JOIN surveys s ON s.id = st.survey_id AND s.status = 'published'
JOIN LATERAL (
  SELECT id FROM survey_versions WHERE survey_id = s.id AND published_at IS NOT NULL
  ORDER BY revision DESC LIMIT 1
) sv ON true
JOIN people p ON p.id = sqlc.arg(person_id) AND p.email IS NOT NULL
WHERE st.kind = 'visit_checked_out' AND st.enabled
  AND NOT EXISTS (
    SELECT 1 FROM survey_invitations si JOIN survey_versions previous ON previous.id = si.survey_version_id
    WHERE previous.survey_id = s.id AND si.person_id = sqlc.arg(person_id)
      AND si.created_at > now() - make_interval(days => st.cooldown_days)
  );

-- name: CreateSurveyInvitation :one
INSERT INTO survey_invitations (id, survey_version_id, person_id, visit_id, token_digest,
  recipient_email, due_at, expires_at)
VALUES (sqlc.arg(id), sqlc.arg(survey_version_id), sqlc.arg(person_id), sqlc.arg(visit_id),
  sqlc.arg(token_digest), sqlc.arg(recipient_email), sqlc.arg(due_at), sqlc.arg(expires_at))
RETURNING *;

-- name: ClaimDueSurveyInvitations :many
WITH candidates AS (
  SELECT si.id FROM survey_invitations si
  WHERE (si.status IN ('pending', 'failed') OR (si.status = 'delivering' AND si.delivery_claimed_at < now() - interval '15 minutes'))
    AND si.due_at <= now() AND si.expires_at > now() AND si.delivery_attempts < 5 AND si.recipient_email IS NOT NULL
  ORDER BY si.due_at, si.id LIMIT sqlc.arg(page_limit)
  FOR UPDATE OF si SKIP LOCKED
), claimed AS (
  UPDATE survey_invitations si SET status = 'delivering', delivery_claimed_at = now(),
    delivery_attempts = delivery_attempts + 1
  FROM candidates c WHERE si.id = c.id RETURNING si.*
)
SELECT claimed.*, sv.title, s.name AS survey_name
FROM claimed
JOIN survey_versions sv ON sv.id = claimed.survey_version_id
JOIN surveys s ON s.id = sv.survey_id
ORDER BY claimed.due_at, claimed.id;

-- name: MarkSurveyInvitationSent :exec
UPDATE survey_invitations SET status = 'sent', sent_at = now(), delivery_claimed_at = NULL,
  delivery_failure_code = NULL WHERE id = sqlc.arg(id) AND status = 'delivering';

-- name: MarkSurveyInvitationFailed :exec
-- The next attempt waits 5, 10, 20 and then 40 minutes, so a short mail outage does not use up every attempt while
-- the delivery loop runs each minute.
UPDATE survey_invitations SET status = 'failed', delivery_claimed_at = NULL,
  due_at = now() + interval '5 minutes' * power(2, delivery_attempts - 1),
  delivery_failure_code = sqlc.arg(delivery_failure_code) WHERE id = sqlc.arg(id) AND status = 'delivering';

-- name: GetPublicSurveyInvitation :one
SELECT si.id AS invitation_id, si.expires_at, si.status, si.person_id,
  s.id AS survey_id, s.anonymous, sv.id AS survey_version_id, sv.title, sv.introduction
FROM survey_invitations si
JOIN survey_versions sv ON sv.id = si.survey_version_id
JOIN surveys s ON s.id = sv.survey_id
WHERE si.token_digest = sqlc.arg(token_digest);

-- name: GetPublicSurveyInvitationForUpdate :one
SELECT si.id AS invitation_id, si.expires_at, si.status, si.person_id,
  s.id AS survey_id, s.anonymous, sv.id AS survey_version_id
FROM survey_invitations si
JOIN survey_versions sv ON sv.id = si.survey_version_id
JOIN surveys s ON s.id = sv.survey_id
WHERE si.token_digest = sqlc.arg(token_digest)
FOR UPDATE OF si;

-- name: ConsumeSurveyInvitation :execrows
UPDATE survey_invitations SET status = 'redeemed', redeemed_at = now(),
  person_id = NULL, visit_id = NULL, recipient_email = NULL
WHERE id = sqlc.arg(id) AND status IN ('pending', 'sent', 'failed') AND expires_at > now();

-- name: CancelSurveyInvitationsForVisit :execrows
UPDATE survey_invitations SET status = 'cancelled', person_id = NULL, visit_id = NULL,
  recipient_email = NULL, delivery_claimed_at = NULL
WHERE visit_id = sqlc.arg(visit_id) AND status IN ('pending', 'delivering', 'sent', 'failed');

-- name: CreateSurveyResponse :one
INSERT INTO survey_responses (id, survey_version_id, submitted_on, identified_person_id, source, share_link_id)
VALUES (sqlc.arg(id), sqlc.arg(survey_version_id), sqlc.arg(submitted_on), sqlc.narg(identified_person_id),
  sqlc.arg(source), sqlc.narg(share_link_id)) RETURNING *;

-- name: CreateSurveyAnswer :exec
INSERT INTO survey_answers (id, response_id, question_id, option_id, text_value, numeric_value, boolean_value, position)
VALUES (sqlc.arg(id), sqlc.arg(response_id), sqlc.arg(question_id), sqlc.narg(option_id),
  sqlc.narg(text_value), sqlc.narg(numeric_value), sqlc.narg(boolean_value), sqlc.arg(position));

-- name: DeleteExpiredSurveyInvitationPII :execrows
UPDATE survey_invitations SET
  status = CASE
    WHEN expires_at < sqlc.arg(before_time) AND status IN ('pending', 'delivering', 'sent', 'failed') THEN 'expired'
    ELSE status
  END,
  person_id = NULL,
  visit_id = NULL,
  recipient_email = NULL,
  delivery_claimed_at = NULL
WHERE (expires_at < sqlc.arg(before_time) OR redeemed_at < sqlc.arg(before_time))
  AND (person_id IS NOT NULL OR visit_id IS NOT NULL OR recipient_email IS NOT NULL);

-- name: CreateSurveyShareLink :one
INSERT INTO survey_share_links (id, survey_id, label, token_digest, active, expires_at, max_responses)
VALUES (sqlc.arg(id), sqlc.arg(survey_id), sqlc.narg(label), sqlc.arg(token_digest), true,
  sqlc.narg(expires_at), sqlc.narg(max_responses)) RETURNING *;

-- name: ListSurveyShareLinks :many
SELECT l.*, (SELECT count(*) FROM survey_responses r WHERE r.share_link_id = l.id) AS response_count
FROM survey_share_links l WHERE l.survey_id = sqlc.arg(survey_id) ORDER BY l.created_at, l.id;

-- name: GetSurveyShareLink :one
SELECT l.*, (SELECT count(*) FROM survey_responses r WHERE r.share_link_id = l.id) AS response_count
FROM survey_share_links l WHERE l.id = sqlc.arg(id) AND l.survey_id = sqlc.arg(survey_id);

-- name: UpdateSurveyShareLink :one
UPDATE survey_share_links SET label = sqlc.narg(label), expires_at = sqlc.narg(expires_at),
  max_responses = sqlc.narg(max_responses), active = sqlc.arg(active), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND survey_id = sqlc.arg(survey_id) AND version = sqlc.arg(expected_version) RETURNING *;

-- name: DeleteSurveyShareLink :execrows
DELETE FROM survey_share_links WHERE id = sqlc.arg(id) AND survey_id = sqlc.arg(survey_id);

-- name: GetSurveyShareLinkByDigest :one
SELECT l.id AS link_id, l.survey_id, l.active, l.expires_at, l.max_responses,
  s.status AS survey_status, sv.id AS survey_version_id, sv.title, sv.introduction,
  (SELECT count(*) FROM survey_responses r WHERE r.share_link_id = l.id) AS response_count
FROM survey_share_links l
JOIN surveys s ON s.id = l.survey_id
JOIN LATERAL (
  SELECT * FROM survey_versions WHERE survey_id = s.id AND published_at IS NOT NULL ORDER BY revision DESC LIMIT 1
) sv ON true
WHERE l.token_digest = sqlc.arg(token_digest);

-- name: LockSurveyShareLink :one
SELECT id FROM survey_share_links WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: CountSurveyShareLinkResponses :one
SELECT count(*) FROM survey_responses WHERE share_link_id = sqlc.arg(share_link_id);

-- name: GetSurveyInvitationCounts :one
SELECT count(*) FILTER (WHERE si.sent_at IS NOT NULL OR si.status = 'redeemed') AS sent,
  count(*) FILTER (WHERE si.status = 'redeemed') AS redeemed,
  count(*) AS created
FROM survey_invitations si JOIN survey_versions v ON v.id = si.survey_version_id
WHERE v.survey_id = sqlc.arg(survey_id);

-- name: GetSurveyResponseOverview :one
SELECT count(*) AS total,
  count(*) FILTER (WHERE r.source = 'invitation') AS by_invitation,
  count(*) FILTER (WHERE r.source = 'link') AS by_link,
  min(r.submitted_on)::date AS first_on, max(r.submitted_on)::date AS last_on
FROM survey_responses r JOIN survey_versions v ON v.id = r.survey_version_id
WHERE v.survey_id = sqlc.arg(survey_id);

-- name: CountFilteredSurveyResponses :one
SELECT count(*) FROM survey_responses r JOIN survey_versions v ON v.id = r.survey_version_id
WHERE v.survey_id = sqlc.arg(survey_id)
  AND (sqlc.narg(from_date)::date IS NULL OR r.submitted_on >= sqlc.narg(from_date)::date)
  AND (sqlc.narg(to_date)::date IS NULL OR r.submitted_on <= sqlc.narg(to_date)::date)
  AND (sqlc.narg(source)::text IS NULL OR r.source = sqlc.narg(source)::text)
  AND (sqlc.narg(link_id)::uuid IS NULL OR r.share_link_id = sqlc.narg(link_id)::uuid);

-- name: ListSurveyAnswerAggregates :many
-- Choice, rating and yes/no answers grouped by value; free text is listed separately and paged.
SELECT a.question_id, a.option_id, a.numeric_value, a.boolean_value, count(*) AS answer_count
FROM survey_answers a
JOIN survey_responses r ON r.id = a.response_id
JOIN survey_versions v ON v.id = r.survey_version_id
WHERE v.survey_id = sqlc.arg(survey_id) AND a.text_value IS NULL
  AND (sqlc.narg(from_date)::date IS NULL OR r.submitted_on >= sqlc.narg(from_date)::date)
  AND (sqlc.narg(to_date)::date IS NULL OR r.submitted_on <= sqlc.narg(to_date)::date)
  AND (sqlc.narg(source)::text IS NULL OR r.source = sqlc.narg(source)::text)
  AND (sqlc.narg(link_id)::uuid IS NULL OR r.share_link_id = sqlc.narg(link_id)::uuid)
GROUP BY a.question_id, a.option_id, a.numeric_value, a.boolean_value;

-- name: ListSurveyQuestionRespondents :many
SELECT a.question_id, count(DISTINCT a.response_id) AS respondents
FROM survey_answers a
JOIN survey_responses r ON r.id = a.response_id
JOIN survey_versions v ON v.id = r.survey_version_id
WHERE v.survey_id = sqlc.arg(survey_id)
  AND (sqlc.narg(from_date)::date IS NULL OR r.submitted_on >= sqlc.narg(from_date)::date)
  AND (sqlc.narg(to_date)::date IS NULL OR r.submitted_on <= sqlc.narg(to_date)::date)
  AND (sqlc.narg(source)::text IS NULL OR r.source = sqlc.narg(source)::text)
  AND (sqlc.narg(link_id)::uuid IS NULL OR r.share_link_id = sqlc.narg(link_id)::uuid)
GROUP BY a.question_id;

-- name: ListSurveyTextAnswers :many
SELECT a.text_value, r.submitted_on
FROM survey_answers a
JOIN survey_responses r ON r.id = a.response_id
WHERE a.question_id = sqlc.arg(question_id) AND a.text_value IS NOT NULL
  AND (sqlc.narg(from_date)::date IS NULL OR r.submitted_on >= sqlc.narg(from_date)::date)
  AND (sqlc.narg(to_date)::date IS NULL OR r.submitted_on <= sqlc.narg(to_date)::date)
  AND (sqlc.narg(source)::text IS NULL OR r.source = sqlc.narg(source)::text)
  AND (sqlc.narg(link_id)::uuid IS NULL OR r.share_link_id = sqlc.narg(link_id)::uuid)
ORDER BY r.submitted_on DESC, r.id
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: CountSurveyTextAnswers :one
SELECT count(*)
FROM survey_answers a
JOIN survey_responses r ON r.id = a.response_id
WHERE a.question_id = sqlc.arg(question_id) AND a.text_value IS NOT NULL
  AND (sqlc.narg(from_date)::date IS NULL OR r.submitted_on >= sqlc.narg(from_date)::date)
  AND (sqlc.narg(to_date)::date IS NULL OR r.submitted_on <= sqlc.narg(to_date)::date)
  AND (sqlc.narg(source)::text IS NULL OR r.source = sqlc.narg(source)::text)
  AND (sqlc.narg(link_id)::uuid IS NULL OR r.share_link_id = sqlc.narg(link_id)::uuid);

-- name: ListSurveyResponsesForExport :many
-- The person columns are NULL unless the response is identified; the service only exposes them for identified surveys.
SELECT r.id, r.submitted_on, r.source, r.share_link_id, p.first_name, p.last_name
FROM survey_responses r
JOIN survey_versions v ON v.id = r.survey_version_id
LEFT JOIN people p ON p.id = r.identified_person_id
WHERE v.survey_id = sqlc.arg(survey_id)
  AND (sqlc.narg(from_date)::date IS NULL OR r.submitted_on >= sqlc.narg(from_date)::date)
  AND (sqlc.narg(to_date)::date IS NULL OR r.submitted_on <= sqlc.narg(to_date)::date)
  AND (sqlc.narg(source)::text IS NULL OR r.source = sqlc.narg(source)::text)
  AND (sqlc.narg(link_id)::uuid IS NULL OR r.share_link_id = sqlc.narg(link_id)::uuid)
ORDER BY r.submitted_on, r.id;

-- name: ListSurveyAnswersForExport :many
SELECT a.response_id, a.question_id, a.text_value, a.numeric_value, a.boolean_value, o.label AS option_label
FROM survey_answers a
JOIN survey_responses r ON r.id = a.response_id
JOIN survey_versions v ON v.id = r.survey_version_id
LEFT JOIN survey_question_options o ON o.id = a.option_id
WHERE v.survey_id = sqlc.arg(survey_id)
  AND (sqlc.narg(from_date)::date IS NULL OR r.submitted_on >= sqlc.narg(from_date)::date)
  AND (sqlc.narg(to_date)::date IS NULL OR r.submitted_on <= sqlc.narg(to_date)::date)
  AND (sqlc.narg(source)::text IS NULL OR r.source = sqlc.narg(source)::text)
  AND (sqlc.narg(link_id)::uuid IS NULL OR r.share_link_id = sqlc.narg(link_id)::uuid)
ORDER BY a.response_id, a.question_id, a.position;

-- name: DeleteUnlinkedExpiredInvitations :execrows
-- Removes invitation rows whose delivery identity was already cleared and whose expiry lies before the cutoff.
DELETE FROM survey_invitations
WHERE person_id IS NULL AND recipient_email IS NULL AND expires_at < sqlc.arg(before_time);
