# Surveys

Surveys collect feedback from visitors and members. A survey has an editable definition, optional post-visit invitations (`visit_checked_out` trigger), any number of anonymous share links, and results with a CSV export. Operations need `surveys.read` (view, results, export) or `surveys.manage` (build, publish, close, reopen, delete, links, trigger); see [authorization.md](authorization.md). The HTTP contract is in `api/openapi.yaml` (tag Surveys).

## Definition and lifecycle

Surveys have editable drafts, immutable published versions, ordered typed questions, options, and optional `visit_checked_out` triggers. Supported question kinds are single choice, multiple choice, free text, rating, and yes/no. Closing a Survey disables its trigger and cancels outstanding invitations. Checkout creates eligible invitations in the Visit transaction. The `visit_checked_out` trigger is configured on the survey settings page (`surveys.manage`): enabled switch, delay after check-out in minutes (0 to 10080, stored as seconds) and cooldown in days (0 to 3650, no new invitation to the same person within that period). The values can be saved on a draft, but the trigger can only be enabled once the survey is published; the survey summary shows them as, for example, "Sent 30 min after check-out · cooldown 30 days".

Status moves `draft -> published -> closed`, and `closed -> published` again through **reopen**. The model keeps one version row per survey (`revision` 1): the "published version" is the survey definition as it stands while it has responses.

- **Edit.** A draft is always editable. A published or closed survey is edited **in place** (same version row, same `revision`, new question and option ids) but only while it has **no responses** (any version); otherwise `PUT /surveys/{id}` answers 409 `survey_has_responses`. The database enforces the same rule: the immutability triggers on `survey_versions`, `survey_questions` and `survey_question_options` block changes once `survey_has_responses(survey_id)` is true. Service edits run with the survey row locked, and submissions take a share lock on it before reading the questions, so an edit and a first response cannot interleave.
- **Delete.** `DELETE /surveys/{id}` hard-deletes the survey with its versions, questions, trigger, share links and invitations (pending, sent and cancelled); 409 `survey_has_responses` once a response exists. The audit event `survey.deleted` is written in the same transaction.
- **Close.** Disables the trigger and cancels outstanding invitations. **Reopen** (`POST /surveys/{id}/reopen`) publishes it again so it accepts answers; the trigger stays disabled until an administrator re-enables it, and invitations cancelled by closing stay cancelled (audit `survey.reopened`).
- **List.** `GET /surveys` supports `search` (name substring), `status`, `sort` (`name`, `status`, `updatedAt`, `responseCount`), `order`, `limit` and `offset`; each item carries `revision`, `responseCount`, `linkCount` and the trigger, and `total` counts all matches.

## Conditional questions

A question may carry a `condition` that refers to an **earlier** question of the same survey. In requests the source question and its options are given by **position** (1-based, in the submitted `questions` array and the source's `options`), because ids do not exist before the survey is saved; responses return ids. Allowed combinations:

| Source kind     | Operator       | Value                          |
| --------------- | -------------- | ------------------------------ |
| single choice   | `one_of`       | `optionPositions` (one or more) |
| multiple choice | `includes_any` | `optionPositions`              |
| rating          | `lte`/`gte`/`eq` | `numericValue` within the source's rating bounds |
| yes/no          | `eq`           | `booleanValue`                 |

Free-text questions cannot be a source. The condition is part of the (frozen) definition. When a response is submitted, conditions are evaluated in question order against the **validated** answers of visible questions, so a question that depends on a hidden question is hidden as well. A hidden question is never required, and an answer to it is **rejected** with 422 `survey_answer_not_applicable` (clients must not send answers for questions they hide).

## Invitations and delivery

The API process delivers due invitations by itself: a background loop calls `DeliverDue` every `SURVEY_DELIVERY_INTERVAL` (Go duration, default `1m`, `0` disables the loop) with a batch of at most 100 and stops on graceful shutdown. Claiming is one `UPDATE ... FOR UPDATE SKIP LOCKED` statement and the email is sent outside any transaction, so several API replicas can run the loop concurrently; stale claims (15 minutes) are retried, and a failed send waits 5, 10, 20 and then 40 minutes before its next attempt, up to five attempts. The loop logs only counts and error types. The `deliver-surveys` admin command remains for manual runs and uses the same claiming. Delivery sends through the generic Notifications service; email is implemented and the SMS provider remains an interface.

Invitation tokens are HMAC-derived opaque values whose digests alone are stored. Delivery identity and response data use separate tables. Redeeming an anonymous invitation stores no `identified_person_id`, clears Person, Visit, and recipient fields from the invitation in the same transaction, and a database trigger rejects identified responses for anonymous Survey versions. Submitted dates and operational delivery timestamps still create limited timing-correlation risk, which administrators should consider when cohorts are very small.

## Share links

A survey can have several share links for anonymous, public answering (open days, flyers, QR codes). A link has an optional label (at most 120 characters), an optional `expiresAt`, an optional `maxResponses`, and an `active` flag; its derived `state` is `open`, `inactive`, `expired` or `full`. Links are managed with `surveys.manage`: `GET/POST /surveys/{id}/links`, `PUT/DELETE /surveys/{id}/links/{linkId}` (the PUT replaces label, expiry, limit and active flag, so it also deactivates and reactivates).

The token is **HMAC-derived** from the link id (key `ChallengeHMACKey`, domain prefix `survey-share-link:`), like invitation tokens. Only its SHA-256 digest is stored for lookup, and the administrator can be shown the link again: `SurveyShareLink.token` is returned on every read. That is why reading links needs `surveys.manage`, not `surveys.read`. The frontend decides the public URL; the token goes into `GET/POST /public/survey-links/{token}`.

Public endpoints are declared with `security: []` in the contract. A link answers while its survey is `published`, the link is active, not expired and below `maxResponses`; otherwise 410 with `survey_unavailable`, `survey_link_inactive`, `survey_link_expired` or `survey_link_full` (404 for unknown tokens and for links of a survey that was never published). The response limit is exact under concurrency: submissions lock the survey (share) and the link row. Responses through a link are **always anonymous**, even for a survey that is not anonymous: no person is stored, `source` is `link` and `share_link_id` records the link. Deleting a link keeps its responses (source `link`, no link id). Responses from invitations have source `invitation`.

Rate limiting is in memory and bounded (`internal/platform/ratelimit` evicts the least recently used key when full instead of refusing new clients): 120 reads and 20 submissions per minute per client address (IPv6 by /64), plus 120 submissions per minute per link. A throttled request gets 429 with `Retry-After`.

## Results and export

All need `surveys.read`; they cover every version of the survey (one in practice, see above). Responses store the **calendar day** (Europe/Vienna), not the time, so `from`/`to` are inclusive dates and first/last response are dates, which limits timing correlation.

- `GET /surveys/{id}/results/overview`: invitations sent (delivered or answered), responses, `responsesByInvitation`, `responsesByLink`, `responseRate` (invitation responses / invitations sent; null when none were sent; link responses are not part of it), first/last response date and the response count per link.
- `GET /surveys/{id}/results/questions?from&to&source&linkId&textLimit&textOffset`: per question the respondent count and, by kind, option counts (zero counts included), the rating distribution for every value of the scale with the mean, yes/no counts, or the free-text answers (newest first, paged by `textLimit` up to 200 and `textOffset` for each free-text question, with a `total`). Free-text entries never carry a person.
- `GET /surveys/{id}/results/export.csv` (same filters, `text/csv`, `Content-Disposition: attachment`): one row per response (by day), columns `Submitted on`, `Source`, `Person` and one per question; multiple-choice answers are joined with `; `. The `Person` column exists only for surveys that are **not anonymous** and holds the first and last name of identified invitation responses (empty for link responses and deleted people); anonymous surveys carry no identity column at all. Matriculation numbers and other person data are never included. Every cell is checked against spreadsheet formula injection: a cell starting with `=`, `+`, `-`, `@`, tab or carriage return is prefixed with a single quote. Exports are audited (`survey.results_exported`).

## Administration and public UI

`/settings/surveys` is a lazily loaded unit with its own routes: the list, `new`, `:surveyId` and `:surveyId/edit`.

- **List.** A server-side table (search, status filter, sort by name, status, responses or update time, paging through `limit`/`offset`); a row opens the detail page. "New survey" needs `surveys.manage`.
- **Detail.** Tabs (`?tab=`): Questions, Results, Share links (`surveys.manage`) and Automatic delivery. Publish, Close and Reopen follow the status. Edit and Delete are disabled with an explanation while `responseCount > 0`.
- **Editor.** React Hook Form with ordered questions (move, remove, answer type, options, rating range, required). A question can carry "Show only if an earlier answer matches". The editor keeps conditions by stable keys and translates them to 1-based positions on save (`draftFromSurvey` / `toQuestionInputs` in `surveyModel.ts`), so re-saving preserves them. Reordering, removing or retyping a source clears the conditions it breaks and shows a warning.
- **Results.** Overview tiles (always unfiltered), filters for date range, source and link, one card per question (bar charts through the asynchronous Carbon Charts boundary, rating mean, paged free-text answers) and a CSV export that downloads the filtered `results/export.csv`.
- **Share links.** Table with copy button, state, responses, expiry and limit, plus create, edit, deactivate/reactivate and delete. The public address is `/survey/link/<token>`; invitations keep `/survey/<token>`. No QR code is shown because no QR library is a dependency.
- **Fill-out page.** Mobile-first single column with tile choices, large rating buttons, a progress bar and a sticky submit bar. Display conditions are evaluated in the browser exactly like the server (`visibleQuestionIds`); hidden questions are neither required nor sent. 410 states (deactivated, expired, full, unavailable) show their own message.

## Data model (migration 00075)

`survey_questions` gains `condition_question_id` (same-version foreign key), `condition_operator`, `condition_option_ids`, `condition_number`, `condition_boolean` with a coherence check. `survey_share_links` holds the links (`token_digest`, `label`, `active`, `expires_at`, `max_responses`, `version`). `survey_responses` gains `source` (`invitation`/`link`) and `share_link_id` (`ON DELETE SET NULL`). `survey_has_responses(uuid)` backs the relaxed immutability triggers. Audit events: `survey.created/updated/published/closed/reopened/deleted`, `survey.trigger_updated`, `survey.share_link_created/updated/deleted`, `survey.results_exported`; none contains answers, tokens or labels.
