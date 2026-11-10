-- Every statement here runs inside the single anonymization transaction. The coverage list in
-- treatments.go names the column or table each statement handles; keep both in step.

-- name: DisableFinancialGuards :exec
-- Booked financial and cash records are immutable by trigger. The anonymizer rewrites their free text
-- only, so their user triggers are switched off for this transaction and switched on again before commit.
ALTER TABLE payments DISABLE TRIGGER USER;

-- name: DisableOrderItemGuards :exec
ALTER TABLE order_items DISABLE TRIGGER USER;

-- name: DisableOrderAdjustmentGuards :exec
ALTER TABLE order_adjustments DISABLE TRIGGER USER;

-- name: DisableCustomerSnapshotGuards :exec
ALTER TABLE order_customer_snapshots DISABLE TRIGGER USER;

-- name: DisableInvoiceDetailGuards :exec
ALTER TABLE external_invoice_request_details DISABLE TRIGGER USER;

-- name: DisableInvoiceEventGuards :exec
ALTER TABLE external_invoice_request_events DISABLE TRIGGER USER;

-- name: DisableCashMovementGuards :exec
ALTER TABLE cash_movements DISABLE TRIGGER USER;

-- name: DisableCashCountGuards :exec
ALTER TABLE cash_counts DISABLE TRIGGER USER;

-- name: DisableInventoryTransactionGuards :exec
ALTER TABLE inventory_transactions DISABLE TRIGGER USER;

-- name: EnableFinancialGuards :exec
ALTER TABLE payments ENABLE TRIGGER USER;

-- name: EnableOrderItemGuards :exec
ALTER TABLE order_items ENABLE TRIGGER USER;

-- name: EnableOrderAdjustmentGuards :exec
ALTER TABLE order_adjustments ENABLE TRIGGER USER;

-- name: EnableCustomerSnapshotGuards :exec
ALTER TABLE order_customer_snapshots ENABLE TRIGGER USER;

-- name: EnableInvoiceDetailGuards :exec
ALTER TABLE external_invoice_request_details ENABLE TRIGGER USER;

-- name: EnableInvoiceEventGuards :exec
ALTER TABLE external_invoice_request_events ENABLE TRIGGER USER;

-- name: EnableCashMovementGuards :exec
ALTER TABLE cash_movements ENABLE TRIGGER USER;

-- name: EnableCashCountGuards :exec
ALTER TABLE cash_counts ENABLE TRIGGER USER;

-- name: EnableInventoryTransactionGuards :exec
ALTER TABLE inventory_transactions ENABLE TRIGGER USER;

-- name: DeleteSessions :exec
DELETE FROM sessions;

-- name: DeletePasswordCredentials :exec
DELETE FROM password_credentials;

-- name: DeletePINCredentials :exec
DELETE FROM pin_credentials;

-- name: DeletePasswordResetTokens :exec
DELETE FROM password_reset_tokens;

-- name: DeleteAuthChallenges :exec
DELETE FROM auth_challenges;

-- name: DeleteAuthRateLimits :exec
DELETE FROM auth_rate_limits;

-- name: DeletePINLoginThrottles :exec
DELETE FROM pin_login_throttles;

-- name: DeletePendingLogins :exec
DELETE FROM pending_logins;

-- name: DeleteSecondFactorThrottles :exec
DELETE FROM second_factor_throttles;

-- name: DeleteWebAuthnChallenges :exec
DELETE FROM webauthn_challenges;

-- name: DeleteWebAuthnCredentials :exec
DELETE FROM webauthn_credentials;

-- name: DeleteTOTPCredentials :exec
DELETE FROM mfa_totp_credentials;

-- name: DeleteRecoveryCodes :exec
DELETE FROM mfa_recovery_codes;

-- name: DeleteOIDCFlows :exec
DELETE FROM oidc_flows;

-- name: DeleteNonPasswordIdentities :exec
-- PIN identities go with their PINs; OIDC identities with production's identity provider.
DELETE FROM auth_identities WHERE kind <> 'password';

-- name: DeleteSCIMUsers :exec
DELETE FROM scim_users;

-- name: DeleteSCIMConnectorTokens :exec
DELETE FROM scim_connector_tokens;

-- name: DeleteSCIMConnectors :exec
DELETE FROM scim_connectors;

-- name: DeleteOIDCProviders :exec
-- Client secrets are encrypted with production's keys and the provider would sign people in as production
-- identities, so staging starts without providers.
DELETE FROM oidc_providers;

-- name: DeleteCalendarFeeds :exec
DELETE FROM calendar_feeds;

-- name: DeleteVisitorEnrollmentContexts :exec
DELETE FROM visitor_enrollment_contexts;

-- name: DeleteAccountPresence :exec
DELETE FROM account_presence;

-- name: DeletePrinterConnectorEnrollments :exec
DELETE FROM printer_connector_enrollments;

-- name: DeletePrinterConnectorCredentials :exec
DELETE FROM printer_connector_credentials;

-- name: DeleteSignagePairingRequests :exec
DELETE FROM signage_pairing_requests;

-- name: ReplaceManagedDeviceTokens :exec
-- The digest column is required and unique; a digest of a fresh random value matches no token anywhere,
-- so every device has to be paired again.
UPDATE managed_devices SET token_digest = sha256(convert_to(gen_random_uuid()::text || id::text, 'UTF8'));

-- name: DisableSignageWebEmbeds :exec
-- Staging must not serve the production screens on other websites: every web embed is switched off and gets a new
-- random key (24 random bytes, base64url), so the production embed codes do not work against staging.
UPDATE signage_web_embeds
SET enabled = false,
    embed_key = translate(encode(uuid_send(gen_random_uuid()) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 8), 'base64'), '+/', '-_');

-- name: ClearPrinterConnectorSecrets :exec
UPDATE printer_connector_assignments SET encrypted_secrets = NULL WHERE encrypted_secrets IS NOT NULL;

-- name: DeleteAuditEvents :exec
DELETE FROM audit_events;

-- name: DeleteNotificationPendingActions :exec
DELETE FROM notification_pending_actions;

-- name: DeleteNotificationFiringRecipients :exec
DELETE FROM notification_firing_recipients;

-- name: DeleteNotificationMailOutbox :exec
DELETE FROM notification_mail_outbox;

-- name: DeleteKioskRuleNotices :exec
DELETE FROM kiosk_rule_notices;

-- name: DeleteSignageRuleNotices :exec
DELETE FROM signage_rule_notices;

-- name: DeleteInboxNotifications :exec
DELETE FROM inbox_notifications;

-- name: DeleteNotificationFirings :exec
DELETE FROM notification_firings;

-- name: DeleteNotificationRuleRuns :exec
DELETE FROM notification_rule_runs;

-- name: DeleteNotificationThrottle :exec
DELETE FROM notification_throttle;

-- name: DeleteSurveyInvitations :exec
DELETE FROM survey_invitations;

-- name: DeleteSurveyOffers :exec
DELETE FROM survey_offers;

-- name: DeleteSurveyShareLinks :exec
DELETE FROM survey_share_links;

-- name: ClearSurveyTextAnswers :exec
-- An answer holds exactly one value; free text becomes a neutral marker instead of NULL.
UPDATE survey_answers SET text_value = '—' WHERE text_value IS NOT NULL;

-- name: DeletePrivacySubjectRequestSteps :exec
DELETE FROM privacy_subject_request_steps;

-- name: DeletePrivacySubjectRequests :exec
DELETE FROM privacy_subject_requests;

-- name: NeutralizePrivacyRetentionHolds :exec
UPDATE privacy_retention_holds SET reason = 'Retention hold';

-- name: ClearPrivacyContact :exec
UPDATE privacy_settings SET data_protection_contact = '';

-- name: DeletePrinterLiveStatuses :exec
DELETE FROM printer_live_statuses;

-- name: DeletePrinterConnectorActivity :exec
DELETE FROM printer_connector_activity;

-- name: DeletePrinterDiscoveryCandidates :exec
DELETE FROM printer_discovery_candidates;

-- name: DeletePrinterDiscoveryRequests :exec
DELETE FROM printer_discovery_requests;

-- name: ClearPrinterEventPayloads :exec
-- Runs and usage items keep pointing at their events; the raw payloads (file names, printer messages) go.
UPDATE printer_events SET payload = '{}'::jsonb;

-- name: ClearPrinterErrorContexts :exec
UPDATE printer_error_occurrences SET context = '{}'::jsonb;

-- name: DeleteFileBlobDeletions :exec
-- The queue names production storage keys; staging's file store does not hold them.
DELETE FROM file_blob_deletions;

-- name: AnonymizePeople :exec
-- Names are chosen from the given lists by a digest of the person's ID, so a person keeps the same fake
-- name across refreshes. The email embeds part of that digest to stay unique.
UPDATE people p SET
    first_name = n.first_name,
    last_name = n.last_name,
    email = lower(n.first_name) || '.' || lower(n.last_name) || '.' || n.tag || '@example.invalid',
    phone = NULL,
    matriculation_number = NULL,
    photo_reference = NULL,
    profile_image_file_id = NULL,
    profile_image_source = NULL
FROM (
    SELECT
        id,
        (sqlc.arg(first_names)::text[])[1 + (('x' || substr(md5(id::text), 1, 8))::bit(32)::bigint
            % cardinality(sqlc.arg(first_names)::text[]))] AS first_name,
        (sqlc.arg(last_names)::text[])[1 + (('x' || substr(md5(id::text), 9, 8))::bit(32)::bigint
            % cardinality(sqlc.arg(last_names)::text[]))] AS last_name,
        substr(md5(id::text), 17, 6) AS tag
    FROM people
) n
WHERE p.id = n.id;

-- name: AlignPasswordIdentitiesWithPeople :exec
UPDATE auth_identities i SET identifier_display = p.email, identifier_normalized = lower(p.email)
FROM accounts a JOIN people p ON p.id = a.person_id
WHERE i.account_id = a.id AND i.kind = 'password';

-- name: ListMasterAccountsWithoutPasswordIdentity :many
SELECT a.id, p.email FROM accounts a
JOIN people p ON p.id = a.person_id
JOIN person_roles pr ON pr.person_id = p.id
JOIN roles r ON r.id = pr.role_id AND r.system_key = 'master'
WHERE NOT EXISTS (SELECT 1 FROM auth_identities i WHERE i.account_id = a.id AND i.kind = 'password')
ORDER BY a.id;

-- name: CreatePasswordIdentity :exec
INSERT INTO auth_identities (id, account_id, kind, identifier_display, identifier_normalized)
VALUES (sqlc.arg(id), sqlc.arg(account_id), 'password', sqlc.arg(email)::text, lower(sqlc.arg(email)::text));

-- name: ListMasterLoginEmails :many
SELECT i.identifier_display::text AS email FROM auth_identities i
JOIN accounts a ON a.id = i.account_id
JOIN person_roles pr ON pr.person_id = a.person_id
JOIN roles r ON r.id = pr.role_id AND r.system_key = 'master'
WHERE i.kind = 'password'
ORDER BY a.status, i.identifier_display;

-- name: AnonymizeEventSignups :exec
UPDATE event_shift_assignments SET
    first_name_snapshot = 'Guest',
    last_name_snapshot = upper(substr(md5(id::text), 1, 6)),
    email_snapshot = 'signup.' || substr(md5(id::text), 1, 10) || '@example.invalid',
    email_normalized = 'signup.' || substr(md5(id::text), 1, 10) || '@example.invalid',
    phone_snapshot = NULL,
    phone_normalized = NULL,
    management_token_digest = NULL
WHERE personal_data_erased_at IS NULL;

-- name: ClearEventTexts :exec
UPDATE events SET internal_description = NULL WHERE internal_description IS NOT NULL;

-- name: NeutralizeEventTasks :exec
-- Task titles often name the person who should do something.
UPDATE event_tasks SET title = 'Task', description = NULL;

-- name: ClearTrainingRecordNotes :exec
UPDATE training_records SET notes = NULL WHERE notes IS NOT NULL;

-- name: NeutralizeLabRulesConfirmations :exec
UPDATE laborordnung_confirmations SET
    physical_document_reference = CASE WHEN method = 'paper' THEN 'Paper form' END,
    archive_note = NULL;

-- name: ClearOpenDayNotes :exec
UPDATE open_days SET internal_note = NULL WHERE internal_note IS NOT NULL;

-- name: ClearStaffingExcusalReasons :exec
UPDATE staffing_excusals SET reason = '';

-- name: ClearVisitCorrectionReasons :exec
UPDATE visits SET correction_reason = CASE WHEN status = 'voided' THEN 'Voided' END
WHERE correction_reason IS NOT NULL;

-- name: AnonymizeMachineJobs :exec
UPDATE machine_jobs SET
    title = NULL,
    notes = NULL,
    price_adjustment_reason = CASE WHEN price_adjustment_reason IS NOT NULL THEN 'Price adjusted' END;

-- name: AnonymizeMachineRunFileNames :exec
-- The extension stays because the UI and the run statistics distinguish file types by it.
UPDATE machine_runs SET file_name = 'print-' || substr(md5(id::text), 1, 8)
    || coalesce(substring(file_name FROM '(\.[A-Za-z0-9]{1,8}(\.[A-Za-z0-9]{1,8})?)$'), '')
WHERE file_name IS NOT NULL;

-- name: ClearInventoryTransactionTexts :exec
UPDATE inventory_transactions SET note = NULL, supplier = NULL, purchase_reference = NULL
WHERE note IS NOT NULL OR supplier IS NOT NULL OR purchase_reference IS NOT NULL;

-- name: ClearSpoolTexts :exec
UPDATE filament_spools SET notes = NULL, acquisition_reference = NULL
WHERE notes IS NOT NULL OR acquisition_reference IS NOT NULL;

-- name: ClearMaterialNotes :exec
UPDATE materials SET notes = NULL WHERE notes IS NOT NULL;

-- name: ClearPrintArtifactMetadata :exec
-- Slicer metadata carries designer names, project paths and printer serials.
UPDATE print_artifacts SET metadata = '{}'::jsonb;

-- name: AnonymizeOrganizationContacts :exec
UPDATE organizations SET contact_name = '', contact_email = '', address_line = '';

-- name: AnonymizeCustomerSnapshots :exec
-- A person customer may have been deleted since; the snapshot then still holds the real name.
UPDATE order_customer_snapshots s SET display_name = coalesce(
    (SELECT p.first_name || ' ' || p.last_name FROM people p WHERE p.id = o.customer_person_id),
    'Former customer'
)
FROM orders o
WHERE s.order_id = o.id AND o.customer_kind = 'person';

-- name: AnonymizeOrderItems :exec
-- Machine-job lines are rebuilt from their snapshot (display ID and machine), everything else gets a
-- neutral line text; quantities and amounts stay so the books still balance.
UPDATE order_items SET description = CASE
    WHEN kind = 'machine_job' THEN coalesce(machine_job_snapshot ->> 'displayId', 'Machine job')
        || ' · ' || coalesce(machine_job_snapshot ->> 'machineName', 'Machine')
    ELSE 'Item ' || position
END;

-- name: ClearOrderAdjustmentReasons :exec
UPDATE order_adjustments SET reason = 'Reversed';

-- name: AnonymizePayments :exec
UPDATE payments SET
    reason = CASE WHEN entry_kind = 'reversal' THEN 'Reversed' ELSE '' END,
    external_reference = CASE WHEN external_reference <> '' THEN 'REF-' || upper(substr(md5(id::text), 1, 8)) ELSE '' END;

-- name: ClearCashMovementNotes :exec
UPDATE cash_movements SET note = CASE WHEN reason = 'other' THEN 'Other' ELSE '' END;

-- name: ClearCashCountNotes :exec
UPDATE cash_counts SET note = CASE WHEN reason IN ('unknown', 'other') THEN 'Other' ELSE '' END;

-- name: AnonymizeInvoiceRequestDetails :exec
-- Organization recipients keep their name; people and contacts take their fake name, or a neutral one when
-- the person has been deleted since. The item summary repeats the order lines and follows AnonymizeOrderItems.
UPDATE external_invoice_request_details d SET
    recipient_name = CASE WHEN d.recipient_kind = 'person' THEN coalesce(
        (SELECT p.first_name || ' ' || p.last_name FROM people p WHERE p.id = d.recipient_person_id),
        'Former customer'
    ) ELSE d.recipient_name END,
    address_line1 = 'Example Street 1',
    address_line2 = '',
    postal_code = '8010',
    locality = 'Graz',
    region = '',
    contact_name = coalesce(
        (SELECT p.first_name || ' ' || p.last_name FROM people p WHERE p.id = d.contact_person_id),
        CASE WHEN d.contact_name <> '' THEN 'Contact' ELSE '' END
    ),
    contact_channel = '',
    service_description = 'Makerspace services',
    item_summary = coalesce((
        SELECT jsonb_agg(
            item || jsonb_build_object('description', CASE
                WHEN item ->> 'kind' = 'machine_job'
                    THEN coalesce(item #>> '{snapshot,displayId}', 'Machine job')
                        || ' · ' || coalesce(item #>> '{snapshot,machineName}', 'Machine')
                ELSE 'Item ' || coalesce(item ->> 'position', '')
            END)
            ORDER BY ordinality
        )
        FROM jsonb_array_elements(d.item_summary) WITH ORDINALITY AS elements(item, ordinality)
    ), '[]'::jsonb);

-- name: NeutralizeInvoiceRequestEvents :exec
UPDATE external_invoice_request_events SET
    reason = CASE WHEN reason <> '' THEN 'Recorded' ELSE '' END,
    external_reference = CASE WHEN external_reference <> '' THEN 'REF-' || upper(substr(md5(id::text), 1, 8)) ELSE '' END;

-- name: PointMailAtMailpit :exec
-- The SMTP password is encrypted with production's keys and staging must never reach real inboxes.
UPDATE mail_configuration SET
    smtp_host = 'mailpit',
    smtp_port = 1025,
    smtp_tls_mode = 'none',
    smtp_username = '',
    encrypted_smtp_password = NULL,
    from_address = 'makerspace-staging@example.invalid',
    base_url = sqlc.arg(base_url)::text;

-- name: RedirectWiRefDelivery :exec
-- The closings usually carry a staff member's signature.
UPDATE wiref_delivery_settings SET
    recipient_email = CASE WHEN recipient_email <> '' THEN 'wiref@example.invalid' ELSE '' END,
    cc_emails = '{}',
    reply_to_email = '',
    mail_closing = '',
    pdf_closing = '';

-- name: ListPersonalFileIDs :many
-- Files that belong to people: profile images, event attachments and subject request exports. They are
-- collected before the anonymizer unlinks them and deleted at the end; system files keep their metadata.
SELECT profile_image_file_id::uuid AS id FROM people WHERE profile_image_file_id IS NOT NULL
UNION
SELECT file_id FROM event_files
UNION
SELECT export_file_id::uuid FROM privacy_subject_requests WHERE export_file_id IS NOT NULL;

-- name: DeleteEventFiles :exec
DELETE FROM event_files;

-- name: DeleteFiles :exec
DELETE FROM files WHERE id = ANY(sqlc.arg(ids)::uuid[]);

-- name: NeutralizeFileNames :exec
UPDATE files SET original_filename = 'file-' || substr(md5(id::text), 1, 8)
    || coalesce(substring(original_filename FROM '(\.[A-Za-z0-9]{1,8}(\.[A-Za-z0-9]{1,8})?)$'), '');
