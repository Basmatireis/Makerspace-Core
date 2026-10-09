-- name: ListSurveys :many
SELECT s.*, sv.id AS survey_version_id, sv.revision, sv.title, sv.introduction
FROM surveys s
JOIN LATERAL (
  SELECT * FROM survey_versions WHERE survey_id = s.id ORDER BY revision DESC LIMIT 1
) sv ON true
ORDER BY s.updated_at DESC, s.id;

-- name: GetSurvey :one
SELECT s.*, sv.id AS survey_version_id, sv.revision, sv.title, sv.introduction
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
INSERT INTO survey_questions (id, survey_version_id, kind, prompt, required, position, rating_min, rating_max)
VALUES (sqlc.arg(id), sqlc.arg(survey_version_id), sqlc.arg(kind), sqlc.arg(prompt), sqlc.arg(required),
  sqlc.arg(position), sqlc.narg(rating_min), sqlc.narg(rating_max)) RETURNING *;

-- name: CreateSurveyOption :one
INSERT INTO survey_question_options (id, question_id, label, position)
VALUES (sqlc.arg(id), sqlc.arg(question_id), sqlc.arg(label), sqlc.arg(position)) RETURNING *;

-- name: UpdateSurveyDraft :one
UPDATE surveys SET name = sqlc.arg(name), description = sqlc.narg(description), anonymous = sqlc.arg(anonymous),
  version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND status = 'draft' RETURNING *;

-- name: UpdateSurveyVersionDraft :exec
UPDATE survey_versions SET title = sqlc.arg(title), introduction = sqlc.narg(introduction)
WHERE id = sqlc.arg(id) AND published_at IS NULL;

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
UPDATE survey_invitations SET status = 'failed', delivery_claimed_at = NULL,
  delivery_failure_code = sqlc.arg(delivery_failure_code) WHERE id = sqlc.arg(id) AND status = 'delivering';

-- name: GetPublicSurveyInvitation :one
SELECT si.id AS invitation_id, si.expires_at, si.status, si.person_id,
  s.anonymous, sv.id AS survey_version_id, sv.title, sv.introduction
FROM survey_invitations si
JOIN survey_versions sv ON sv.id = si.survey_version_id
JOIN surveys s ON s.id = sv.survey_id
WHERE si.token_digest = sqlc.arg(token_digest);

-- name: GetPublicSurveyInvitationForUpdate :one
SELECT si.id AS invitation_id, si.expires_at, si.status, si.person_id,
  s.anonymous, sv.id AS survey_version_id
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
INSERT INTO survey_responses (id, survey_version_id, submitted_on, identified_person_id)
VALUES (sqlc.arg(id), sqlc.arg(survey_version_id), sqlc.arg(submitted_on), sqlc.narg(identified_person_id)) RETURNING *;

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
