-- Processing activities ------------------------------------------------------

-- name: ListProcessingActivities :many
SELECT * FROM privacy_processing_activities ORDER BY name, id;

-- name: GetProcessingActivity :one
SELECT * FROM privacy_processing_activities WHERE id = sqlc.arg(id);

-- name: InsertProcessingActivity :one
INSERT INTO privacy_processing_activities (id, name, purpose, legal_basis, category_ids, recipients, retention_note, updated_by_account_id)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(purpose), sqlc.arg(legal_basis), sqlc.arg(category_ids)::text[], sqlc.arg(recipients), sqlc.arg(retention_note), sqlc.narg(updated_by_account_id))
RETURNING *;

-- name: UpdateProcessingActivity :one
UPDATE privacy_processing_activities
SET name = sqlc.arg(name), purpose = sqlc.arg(purpose), legal_basis = sqlc.arg(legal_basis), category_ids = sqlc.arg(category_ids)::text[],
    recipients = sqlc.arg(recipients), retention_note = sqlc.arg(retention_note), updated_by_account_id = sqlc.narg(updated_by_account_id),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: DeleteProcessingActivity :one
DELETE FROM privacy_processing_activities WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING id;

-- Subject requests -------------------------------------------------------------

-- name: ListSubjectRequests :many
SELECT * FROM privacy_subject_requests ORDER BY received_at DESC, id DESC LIMIT sqlc.arg(row_limit);

-- name: GetSubjectRequest :one
SELECT * FROM privacy_subject_requests WHERE id = sqlc.arg(id);

-- name: LockSubjectRequest :one
SELECT * FROM privacy_subject_requests WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: InsertSubjectRequest :one
INSERT INTO privacy_subject_requests (id, kind, status, subject_person_id, reference, channel, received_at, due_at, notes, created_by_account_id)
VALUES (sqlc.arg(id), sqlc.arg(kind), 'received', sqlc.arg(subject_person_id), sqlc.arg(reference), sqlc.arg(channel), sqlc.arg(received_at), sqlc.arg(due_at), sqlc.arg(notes), sqlc.narg(created_by_account_id))
RETURNING *;

-- name: MarkSubjectRequestIdentityVerified :one
UPDATE privacy_subject_requests
SET status = 'identity_verified', identity_verified_at = now(), identity_verified_by_account_id = sqlc.narg(actor_account_id),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: MarkSubjectRequestAssessed :one
UPDATE privacy_subject_requests
SET status = 'assessed', assessed_at = now(), assessment = (sqlc.arg(assessment)::text)::jsonb, version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: MarkSubjectRequestApproved :one
UPDATE privacy_subject_requests
SET status = 'approved', approved_at = now(), approved_by_account_id = sqlc.narg(actor_account_id), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: MarkSubjectRequestRejected :one
UPDATE privacy_subject_requests
SET status = 'rejected', rejection_reason = sqlc.arg(rejection_reason), completed_at = now(), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: MarkSubjectRequestExecuted :one
UPDATE privacy_subject_requests
SET status = sqlc.arg(status), executed_at = now(), executed_by_account_id = sqlc.narg(actor_account_id),
    result = (sqlc.arg(result)::text)::jsonb, export_file_id = sqlc.narg(export_file_id), completed_at = now(),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: InsertSubjectRequestStep :exec
INSERT INTO privacy_subject_request_steps (id, request_id, status, actor_account_id, note)
VALUES (sqlc.arg(id), sqlc.arg(request_id), sqlc.arg(status), sqlc.narg(actor_account_id), sqlc.arg(note));

-- name: ListSubjectRequestSteps :many
SELECT * FROM privacy_subject_request_steps WHERE request_id = sqlc.arg(request_id) ORDER BY occurred_at, id;

-- name: CountOpenPersonHolds :one
SELECT count(*)::bigint FROM privacy_retention_holds WHERE subject_person_id = sqlc.arg(subject_person)::uuid AND released_at IS NULL;

-- name: ListSubjectRequestsClosedBefore :many
SELECT id, export_file_id FROM privacy_subject_requests
WHERE status IN ('completed', 'partially_completed', 'rejected') AND completed_at < sqlc.arg(before_time)::timestamptz
ORDER BY completed_at LIMIT sqlc.arg(row_limit);

-- name: DeleteSubjectRequestsByID :execrows
DELETE FROM privacy_subject_requests WHERE id = ANY((sqlc.arg(ids)::text[])::uuid[]);

-- name: DeleteExportFilesQueueBlobs :exec
WITH deleted AS (
    DELETE FROM files WHERE id = ANY((sqlc.arg(file_ids)::text[])::uuid[]) RETURNING storage_key
)
INSERT INTO file_blob_deletions (storage_key) SELECT storage_key FROM deleted
ON CONFLICT (storage_key) DO NOTHING;

-- Names for the request pages: who the request is about and who acted. The person is gone after an erasure.

-- name: ListPeopleNames :many
SELECT id, first_name, last_name FROM people WHERE id = ANY((sqlc.arg(ids)::text[])::uuid[]);

-- name: ListAccountPersonNames :many
SELECT a.id AS account_id, p.first_name, p.last_name
FROM accounts a JOIN people p ON p.id = a.person_id
WHERE a.id = ANY((sqlc.arg(ids)::text[])::uuid[]);

-- Subject lookups ----------------------------------------------------------------

-- name: GetSubjectPerson :one
SELECT p.id, p.version, p.profile_image_file_id, a.id AS account_id
FROM people p LEFT JOIN accounts a ON a.person_id = p.id
WHERE p.id = sqlc.arg(subject_person)::uuid;

-- Export sections. Every query returns one JSON document for the subject with explicit
-- columns, so a new column never reaches an export without being listed here. Secrets
-- (digests, ciphertexts, tokens) are never selected.

-- name: ExportPersonIdentity :one
SELECT jsonb_build_object(
    'id', p.id, 'firstName', p.first_name, 'lastName', p.last_name, 'email', p.email, 'phone', p.phone,
    'matriculationNumber', p.matriculation_number, 'photoReference', p.photo_reference, 'memberSince', p.member_since,
    'profileImageSource', p.profile_image_source, 'createdAt', p.created_at, 'updatedAt', p.updated_at,
    'roles', (SELECT COALESCE(jsonb_agg(jsonb_build_object('name', r.name, 'assignedAt', pr.assigned_at) ORDER BY r.name), '[]'::jsonb)
              FROM person_roles pr JOIN roles r ON r.id = pr.role_id WHERE pr.person_id = p.id)
)::jsonb AS document
FROM people p WHERE p.id = sqlc.arg(subject_person)::uuid;

-- name: ExportAccount :one
SELECT jsonb_build_object(
    'id', a.id, 'status', a.status, 'provisioningSource', a.provisioning_source, 'createdAt', a.created_at,
    'firstAuthenticatedAt', a.first_authenticated_at, 'administrativelyDisabledAt', a.administratively_disabled_at,
    'identities', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'kind', i.kind, 'identifier', i.identifier_display, 'issuer', i.issuer, 'createdAt', i.created_at,
        'verifiedAt', i.verified_at, 'disabledAt', i.disabled_at) ORDER BY i.created_at), '[]'::jsonb)
        FROM auth_identities i WHERE i.account_id = a.id),
    'authenticatorApps', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'createdAt', t.created_at, 'confirmedAt', t.confirmed_at, 'lastUsedAt', t.last_used_at) ORDER BY t.created_at), '[]'::jsonb)
        FROM mfa_totp_credentials t WHERE t.account_id = a.id),
    'passkeys', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'name', w.name, 'createdAt', w.created_at, 'lastUsedAt', w.last_used_at) ORDER BY w.created_at), '[]'::jsonb)
        FROM webauthn_credentials w WHERE w.account_id = a.id),
    'recoveryCodes', (SELECT jsonb_build_object('total', count(*), 'used', count(*) FILTER (WHERE used_at IS NOT NULL))
        FROM mfa_recovery_codes c WHERE c.account_id = a.id)
)::jsonb AS document
FROM accounts a WHERE a.id = sqlc.arg(subject_account)::uuid;

-- name: ExportSessions :one
SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'authMethod', s.auth_method, 'createdAt', s.created_at, 'lastSeenAt', s.last_seen_at, 'authenticatedAt', s.authenticated_at,
    'revokedAt', s.revoked_at, 'revocationReason', s.revocation_reason) ORDER BY s.created_at), '[]'::jsonb)::jsonb AS document
FROM sessions s WHERE s.account_id = sqlc.arg(subject_account)::uuid;

-- name: CountSessions :one
SELECT count(*)::bigint FROM sessions WHERE account_id = sqlc.arg(subject_account)::uuid;

-- name: ExportPendingState :one
SELECT jsonb_build_object(
    'pendingLogins', (SELECT count(*) FROM pending_logins pl WHERE pl.account_id = sqlc.arg(subject_account)::uuid),
    'signInChallenges', (SELECT count(*) FROM auth_challenges ac WHERE ac.account_id = sqlc.arg(subject_account)::uuid),
    'passkeyChallenges', (SELECT count(*) FROM webauthn_challenges wc WHERE wc.account_id = sqlc.arg(subject_account)::uuid),
    'oidcFlows', (SELECT count(*) FROM oidc_flows of WHERE of.account_id = sqlc.arg(subject_account)::uuid),
    'passwordResetTokens', (SELECT count(*) FROM password_reset_tokens prt WHERE prt.account_id = sqlc.arg(subject_account)::uuid)
)::jsonb AS document;

-- name: CountPendingState :one
SELECT ((SELECT count(*) FROM pending_logins pl WHERE pl.account_id = sqlc.arg(subject_account)::uuid)
    + (SELECT count(*) FROM auth_challenges ac WHERE ac.account_id = sqlc.arg(subject_account)::uuid)
    + (SELECT count(*) FROM webauthn_challenges wc WHERE wc.account_id = sqlc.arg(subject_account)::uuid)
    + (SELECT count(*) FROM oidc_flows of WHERE of.account_id = sqlc.arg(subject_account)::uuid)
    + (SELECT count(*) FROM password_reset_tokens prt WHERE prt.account_id = sqlc.arg(subject_account)::uuid))::bigint AS total;

-- name: ExportScimMappings :one
SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'connector', c.name, 'externalId', u.external_id, 'userName', u.user_name, 'createdAt', u.created_at, 'updatedAt', u.updated_at)
    ORDER BY u.created_at), '[]'::jsonb)::jsonb AS document
FROM scim_users u JOIN scim_connectors c ON c.id = u.connector_id WHERE u.person_id = sqlc.arg(subject_person)::uuid;

-- name: CountScimMappings :one
SELECT count(*)::bigint FROM scim_users WHERE person_id = sqlc.arg(subject_person)::uuid;

-- name: ExportVisits :one
SELECT jsonb_build_object(
    'visits', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'checkedInAt', v.checked_in_at, 'checkedOutAt', v.checked_out_at, 'status', v.status, 'checkInMethod', v.check_in_method,
        'checkOutMethod', v.check_out_method, 'admissionDecision', v.admission_decision, 'correctionReason', v.correction_reason)
        ORDER BY v.checked_in_at), '[]'::jsonb) FROM visits v WHERE v.person_id = sqlc.arg(subject_person)::uuid),
    'holds', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'requestedAt', h.requested_at, 'expiresAt', h.expires_at, 'checkInMethod', h.check_in_method) ORDER BY h.requested_at), '[]'::jsonb)
        FROM attendance_holds h WHERE h.person_id = sqlc.arg(subject_person)::uuid)
)::jsonb AS document;

-- name: CountVisits :one
SELECT ((SELECT count(*) FROM visits v WHERE v.person_id = sqlc.arg(subject_person)::uuid)
    + (SELECT count(*) FROM attendance_holds ah WHERE ah.person_id = sqlc.arg(subject_person)::uuid))::bigint AS total;

-- name: ExportSurveyInvitations :one
SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'survey', sv.title, 'recipientEmail', i.recipient_email, 'status', i.status, 'dueAt', i.due_at, 'expiresAt', i.expires_at,
    'sentAt', i.sent_at, 'redeemedAt', i.redeemed_at, 'createdAt', i.created_at) ORDER BY i.created_at), '[]'::jsonb)::jsonb AS document
FROM survey_invitations i JOIN survey_versions sv ON sv.id = i.survey_version_id WHERE i.person_id = sqlc.arg(subject_person)::uuid;

-- name: CountSurveyInvitations :one
SELECT count(*)::bigint FROM survey_invitations WHERE person_id = sqlc.arg(subject_person)::uuid;

-- name: ExportSurveyResponses :one
SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'survey', sv.title, 'submittedOn', r.submitted_on, 'source', r.source,
    'answers', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'question', q.prompt, 'text', a.text_value, 'number', a.numeric_value, 'boolean', a.boolean_value, 'option', o.label)
        ORDER BY a.position), '[]'::jsonb)
        FROM survey_answers a JOIN survey_questions q ON q.id = a.question_id
        LEFT JOIN survey_question_options o ON o.id = a.option_id WHERE a.response_id = r.id)
) ORDER BY r.submitted_on), '[]'::jsonb)::jsonb AS document
FROM survey_responses r JOIN survey_versions sv ON sv.id = r.survey_version_id WHERE r.identified_person_id = sqlc.arg(subject_person)::uuid;

-- name: CountSurveyResponses :one
SELECT count(*)::bigint FROM survey_responses WHERE identified_person_id = sqlc.arg(subject_person)::uuid;

-- name: ExportEventSignups :one
SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'event', e.name, 'shift', s.name, 'startsAt', s.starts_at, 'endsAt', s.ends_at, 'status', a.status, 'source', a.source,
    'firstName', a.first_name_snapshot, 'lastName', a.last_name_snapshot, 'email', a.email_snapshot, 'phone', a.phone_snapshot,
    'createdAt', a.created_at) ORDER BY s.starts_at), '[]'::jsonb)::jsonb AS document
FROM event_shift_assignments a JOIN event_shifts s ON s.id = a.shift_id JOIN events e ON e.id = a.event_id
WHERE a.person_id = sqlc.arg(subject_person)::uuid;

-- name: CountEventSignups :one
SELECT count(*)::bigint FROM event_shift_assignments WHERE person_id = sqlc.arg(subject_person)::uuid;

-- name: ExportEventContent :one
SELECT jsonb_build_object(
    'ownedEvents', (SELECT COALESCE(jsonb_agg(jsonb_build_object('name', e.name, 'status', e.status, 'createdAt', e.created_at) ORDER BY e.created_at), '[]'::jsonb)
        FROM events e WHERE e.owner_person_id = sqlc.arg(subject_person)::uuid),
    'assignedTasks', (SELECT COALESCE(jsonb_agg(jsonb_build_object('event', e.name, 'title', t.title, 'status', t.status, 'dueAt', t.due_at, 'completedAt', t.completed_at) ORDER BY t.created_at), '[]'::jsonb)
        FROM event_tasks t JOIN events e ON e.id = t.event_id WHERE t.assignee_person_id = sqlc.arg(subject_person)::uuid)
)::jsonb AS document;

-- name: CountEventContent :one
SELECT ((SELECT count(*) FROM events e WHERE e.owner_person_id = sqlc.arg(subject_person)::uuid)
    + (SELECT count(*) FROM event_tasks et WHERE et.assignee_person_id = sqlc.arg(subject_person)::uuid))::bigint AS total;

-- name: ExportOpenDayAssignments :one
SELECT COALESCE(jsonb_agg(jsonb_build_object('startsAt', d.starts_at, 'endsAt', d.ends_at, 'status', d.status, 'assignedAt', a.created_at) ORDER BY d.starts_at), '[]'::jsonb)::jsonb AS document
FROM open_day_assignments a JOIN open_days d ON d.id = a.open_day_id WHERE a.person_id = sqlc.arg(subject_person)::uuid;

-- name: CountOpenDayAssignments :one
SELECT count(*)::bigint FROM open_day_assignments WHERE person_id = sqlc.arg(subject_person)::uuid;

-- name: ExportTrainingRecords :one
SELECT COALESCE(jsonb_agg(jsonb_build_object('training', t.name, 'status', r.status, 'completedOn', r.completed_on, 'notes', r.notes, 'createdAt', r.created_at) ORDER BY t.name), '[]'::jsonb)::jsonb AS document
FROM training_records r JOIN trainings t ON t.id = r.training_id WHERE r.person_id = sqlc.arg(subject_person)::uuid;

-- name: CountTrainingRecords :one
SELECT count(*)::bigint FROM training_records WHERE person_id = sqlc.arg(subject_person)::uuid;

-- name: ExportLabRulesRequests :one
SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'status', r.status, 'requestedAt', r.requested_at, 'completedAt', r.completed_at, 'supersededAt', r.superseded_at,
    'signedDate', r.signed_date, 'physicalDocumentReference', r.physical_document_reference, 'archiveNote', r.archive_note)
    ORDER BY r.requested_at), '[]'::jsonb)::jsonb AS document
FROM laborordnung_requests r WHERE r.person_id = sqlc.arg(subject_person)::uuid;

-- name: CountLabRulesRequests :one
SELECT count(*)::bigint FROM laborordnung_requests WHERE person_id = sqlc.arg(subject_person)::uuid;

-- name: ExportAuditEvents :one
SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM audit_events ae WHERE ae.actor_account_id = sqlc.arg(subject_account)::uuid),
    'events', (SELECT COALESCE(jsonb_agg(jsonb_build_object('action', e.action, 'resourceType', e.resource_type, 'occurredAt', e.occurred_at) ORDER BY e.occurred_at DESC), '[]'::jsonb)
        FROM (SELECT ae.action, ae.resource_type, ae.occurred_at FROM audit_events ae WHERE ae.actor_account_id = sqlc.arg(subject_account)::uuid ORDER BY ae.occurred_at DESC LIMIT 10000) e)
)::jsonb AS document;

-- name: CountAuditEvents :one
SELECT count(*)::bigint FROM audit_events WHERE actor_account_id = sqlc.arg(subject_account)::uuid;

-- name: ExportFinancialRecords :one
SELECT jsonb_build_object(
    'orders', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'reference', o.reference, 'status', o.status, 'currency', o.currency, 'totalAmount', o.total_amount, 'createdAt', o.created_at,
        'finalizedAt', o.finalized_at, 'cancelledAt', o.cancelled_at, 'reversedAt', o.reversed_at) ORDER BY o.created_at), '[]'::jsonb)
        FROM orders o WHERE o.customer_person_id = sqlc.arg(subject_person)::uuid),
    'invoiceRequests', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'reference', r.reference, 'state', r.state, 'role', CASE WHEN d.recipient_person_id = sqlc.arg(subject_person)::uuid THEN 'recipient' ELSE 'contact' END,
        'recipientName', d.recipient_name, 'contactName', d.contact_name, 'createdAt', r.created_at) ORDER BY r.created_at), '[]'::jsonb)
        FROM external_invoice_request_details d JOIN external_invoice_requests r ON r.id = d.request_id
        WHERE d.recipient_person_id = sqlc.arg(subject_person)::uuid OR d.contact_person_id = sqlc.arg(subject_person)::uuid),
    'cashMovementsRecorded', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'reference', m.reference, 'kind', m.kind, 'amount', m.amount, 'reason', m.reason, 'occurredAt', m.occurred_at) ORDER BY m.occurred_at), '[]'::jsonb)
        FROM cash_movements m WHERE m.recorded_by_person_id = sqlc.arg(subject_person)::uuid)
)::jsonb AS document;

-- name: CountFinancialRecords :one
SELECT ((SELECT count(*) FROM orders o WHERE o.customer_person_id = sqlc.arg(subject_person)::uuid)
    + (SELECT count(*) FROM external_invoice_request_details eird WHERE eird.recipient_person_id = sqlc.arg(subject_person)::uuid OR eird.contact_person_id = sqlc.arg(subject_person)::uuid)
    + (SELECT count(*) FROM cash_movements cm WHERE cm.recorded_by_person_id = sqlc.arg(subject_person)::uuid))::bigint AS total;

-- name: CountOrderOperations :one
SELECT count(*)::bigint FROM order_operations WHERE actor_account_id = sqlc.arg(subject_account)::uuid;

-- name: ExportOrganizationMemberships :one
SELECT COALESCE(jsonb_agg(jsonb_build_object('organization', o.name, 'kind', o.kind, 'addedAt', m.added_at) ORDER BY o.name), '[]'::jsonb)::jsonb AS document
FROM organization_members m JOIN organizations o ON o.id = m.organization_id WHERE m.person_id = sqlc.arg(subject_person)::uuid;

-- name: CountOrganizationMemberships :one
SELECT count(*)::bigint FROM organization_members WHERE person_id = sqlc.arg(subject_person)::uuid;

-- name: ExportMachineJobs :one
SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'displayId', j.display_id, 'machine', m.name, 'title', j.title, 'notes', j.notes,
    'role', CASE WHEN j.customer_person_id = sqlc.arg(subject_person)::uuid AND j.operator_person_id = sqlc.arg(subject_person)::uuid THEN 'customer_and_operator'
                 WHEN j.customer_person_id = sqlc.arg(subject_person)::uuid THEN 'customer' ELSE 'operator' END,
    'effectivePrice', j.effective_price, 'createdAt', j.created_at, 'deletedAt', j.deleted_at) ORDER BY j.created_at), '[]'::jsonb)::jsonb AS document
FROM machine_jobs j JOIN machines m ON m.id = j.machine_id
WHERE j.customer_person_id = sqlc.arg(subject_person)::uuid OR j.operator_person_id = sqlc.arg(subject_person)::uuid;

-- name: CountMachineJobs :one
SELECT count(*)::bigint FROM machine_jobs WHERE customer_person_id = sqlc.arg(subject_person)::uuid OR operator_person_id = sqlc.arg(subject_person)::uuid;

-- name: ExportNotifications :one
SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', n.kind, 'title', n.title, 'createdAt', n.created_at, 'readAt', r.read_at) ORDER BY n.created_at), '[]'::jsonb)::jsonb AS document
FROM inbox_recipients r JOIN inbox_notifications n ON n.id = r.notification_id WHERE r.account_id = sqlc.arg(subject_account)::uuid;

-- name: CountNotifications :one
SELECT count(*)::bigint FROM inbox_recipients WHERE account_id = sqlc.arg(subject_account)::uuid;

-- name: ExportActorReferences :one
-- Counts of records that name the account as the acting staff member (no content, the records belong to others).
SELECT jsonb_build_object(
    'visitsCheckedIn', (SELECT count(*) FROM visits v WHERE v.checked_in_by_account_id = sqlc.arg(subject_account)::uuid OR v.checked_out_by_account_id = sqlc.arg(subject_account)::uuid),
    'trainingRecordsRecorded', (SELECT count(*) FROM training_records tr WHERE tr.recorded_by_account_id = sqlc.arg(subject_account)::uuid),
    'labRulesConfirmed', (SELECT count(*) FROM laborordnung_requests lr WHERE lr.confirmed_by_account_id = sqlc.arg(subject_account)::uuid),
    'ordersCreated', (SELECT count(*) FROM orders o WHERE o.created_by_account_id = sqlc.arg(subject_account)::uuid),
    'paymentsRecorded', (SELECT count(*) FROM payments p WHERE p.actor_account_id = sqlc.arg(subject_account)::uuid),
    'eventsCreated', (SELECT count(*) FROM events e WHERE e.created_by_account_id = sqlc.arg(subject_account)::uuid),
    'eventAssignmentsCreated', (SELECT count(*) FROM event_shift_assignments esa WHERE esa.created_by_account_id = sqlc.arg(subject_account)::uuid),
    'rolesAssigned', (SELECT count(*) FROM person_roles pr WHERE pr.assigned_by_account_id = sqlc.arg(subject_account)::uuid),
    'filesCreated', (SELECT count(*) FROM files f WHERE f.created_by_account_id = sqlc.arg(subject_account)::uuid),
    'notificationsSent', (SELECT count(*) FROM inbox_notifications notif WHERE notif.created_by_account_id = sqlc.arg(subject_account)::uuid)
)::jsonb AS document;

-- name: ExportPrivacyRecords :one
SELECT jsonb_build_object(
    'holds', (SELECT COALESCE(jsonb_agg(jsonb_build_object('reason', h.reason, 'createdAt', h.created_at, 'releasedAt', h.released_at) ORDER BY h.created_at), '[]'::jsonb)
        FROM privacy_retention_holds h WHERE h.subject_person_id = sqlc.arg(subject_person)::uuid),
    'requests', (SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', r.kind, 'status', r.status, 'receivedAt', r.received_at, 'completedAt', r.completed_at) ORDER BY r.received_at), '[]'::jsonb)
        FROM privacy_subject_requests r WHERE r.subject_person_id = sqlc.arg(subject_person)::uuid)
)::jsonb AS document;

-- name: CountPrivacyRecords :one
SELECT ((SELECT count(*) FROM privacy_retention_holds prh WHERE prh.subject_person_id = sqlc.arg(subject_person)::uuid)
    + (SELECT count(*) FROM privacy_subject_requests psr WHERE psr.subject_person_id = sqlc.arg(subject_person)::uuid))::bigint AS total;
