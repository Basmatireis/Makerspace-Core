-- +goose Up
-- People confirm the current Lab Rules themselves (in the app, at the kiosk, or when enrolling as a visitor) instead
-- of a supervisor checking a signed paper. Completed paper confirmations stay as history with method 'paper' and
-- their document reference; pending and superseded paper requests and held check-ins are dropped.
DELETE FROM laborordnung_requests WHERE status <> 'completed';
-- One confirmation per person and version; a duplicate left behind by an earlier merge keeps the first one.
DELETE FROM laborordnung_requests later
USING laborordnung_requests earlier
WHERE later.person_id = earlier.person_id AND later.required_version_id = earlier.required_version_id
  AND (earlier.completed_at, earlier.id) < (later.completed_at, later.id);

DROP INDEX laborordnung_one_pending_person_idx;
DROP INDEX laborordnung_requests_queue_idx;
DROP INDEX laborordnung_requests_person_idx;

ALTER TABLE laborordnung_requests RENAME TO laborordnung_confirmations;
ALTER TABLE laborordnung_confirmations RENAME COLUMN required_version_id TO version_id;
ALTER TABLE laborordnung_confirmations RENAME COLUMN completed_at TO confirmed_at;
ALTER TABLE laborordnung_confirmations RENAME CONSTRAINT laborordnung_requests_pkey TO laborordnung_confirmations_pkey;
ALTER TABLE laborordnung_confirmations
    RENAME CONSTRAINT laborordnung_requests_person_id_fkey TO laborordnung_confirmations_person_id_fkey;
ALTER TABLE laborordnung_confirmations
    RENAME CONSTRAINT laborordnung_requests_required_version_id_fkey TO laborordnung_confirmations_version_id_fkey;
ALTER TABLE laborordnung_confirmations
    RENAME CONSTRAINT laborordnung_requests_confirmed_by_account_id_fkey TO laborordnung_confirmations_confirmed_by_account_id_fkey;
ALTER TABLE laborordnung_confirmations
    RENAME CONSTRAINT laborordnung_requests_physical_document_reference_check
        TO laborordnung_confirmations_physical_document_reference_check;
ALTER TABLE laborordnung_confirmations
    RENAME CONSTRAINT laborordnung_requests_archive_note_check TO laborordnung_confirmations_archive_note_check;

-- The request workflow columns go; their checks are dropped with them.
ALTER TABLE laborordnung_confirmations
    DROP COLUMN status,
    DROP COLUMN previous_version_id,
    DROP COLUMN requested_at,
    DROP COLUMN superseded_at,
    DROP COLUMN created_at,
    DROP COLUMN updated_at;
ALTER TABLE laborordnung_confirmations ALTER COLUMN confirmed_at SET NOT NULL;

-- confirmed_by_account_id, physical_document_reference, signed_date and archive_note belong to the legacy paper
-- confirmations only: the supervisor who checked the paper and where it is filed. A person confirming themselves
-- leaves them empty.
ALTER TABLE laborordnung_confirmations
    ADD COLUMN method text NOT NULL DEFAULT 'paper'
        CONSTRAINT laborordnung_confirmations_method_check CHECK (method IN ('paper', 'app', 'kiosk', 'enrollment'));
ALTER TABLE laborordnung_confirmations ALTER COLUMN method DROP DEFAULT;
ALTER TABLE laborordnung_confirmations
    ADD CONSTRAINT laborordnung_confirmations_evidence_check CHECK (
        (method = 'paper' AND physical_document_reference IS NOT NULL)
        OR (method <> 'paper' AND confirmed_by_account_id IS NULL AND physical_document_reference IS NULL
            AND signed_date IS NULL AND archive_note IS NULL)
    ),
    ADD CONSTRAINT laborordnung_confirmations_person_version_key UNIQUE (person_id, version_id);
CREATE INDEX laborordnung_confirmations_person_idx ON laborordnung_confirmations (person_id, confirmed_at DESC);

-- announced_at is when everyone who must confirm was told that the version became effective. It is the only column
-- that may still change on a published version. Versions effective before this migration count as announced, so
-- deploying it does not notify everyone.
ALTER TABLE laborordnung_versions
    ADD COLUMN announced_at timestamptz,
    ADD CONSTRAINT laborordnung_versions_announced_check CHECK (announced_at IS NULL OR status = 'published');

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION prevent_published_laborordnung_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND OLD.status = 'published' THEN
        RAISE EXCEPTION 'published Laborordnung versions are immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'published'
        AND (to_jsonb(NEW) - 'announced_at') IS DISTINCT FROM (to_jsonb(OLD) - 'announced_at') THEN
        RAISE EXCEPTION 'published Laborordnung versions are immutable' USING ERRCODE = '23514';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
-- +goose StatementEnd

UPDATE laborordnung_versions SET announced_at = now() WHERE status = 'published' AND effective_at <= now();

DROP TABLE attendance_holds;

-- laborordnung.requests.read becomes laborordnung.confirmations.read; laborordnung.confirm (checking paper) is gone.
-- Role permissions are stored as role_permission_grants (device type restrictions cascade); the master role derives
-- its permissions from application code.
UPDATE role_permission_grants SET permission_id = 'laborordnung.confirmations.read'
WHERE permission_id = 'laborordnung.requests.read';
DELETE FROM role_permission_grants WHERE permission_id = 'laborordnung.confirm';
UPDATE master_reauthentication_permissions SET permission_id = 'laborordnung.confirmations.read'
WHERE permission_id = 'laborordnung.requests.read';
DELETE FROM master_reauthentication_permissions WHERE permission_id = 'laborordnung.confirm';

-- Supervisors are no longer asked to confirm paper; people are told about new Lab Rules instead, in the app and by
-- e-mail.
DELETE FROM inbox_notifications WHERE kind = 'lab_rules_confirmation_requested';
ALTER TABLE inbox_notifications DROP CONSTRAINT inbox_notifications_kind_check;
ALTER TABLE inbox_notifications
    ADD CONSTRAINT inbox_notifications_kind_check CHECK (kind IN (
        'message',
        'lab_rules_published',
        'open_day_period_open',
        'open_day_place_freed',
        'run_finished',
        'printer_error',
        'filament_change'
    ));
ALTER TABLE notification_mail_outbox DROP CONSTRAINT notification_mail_outbox_kind_check;
ALTER TABLE notification_mail_outbox
    ADD CONSTRAINT notification_mail_outbox_kind_check
        CHECK (kind IN ('printer_error', 'run_finished', 'filament_change', 'lab_rules_published'));

-- +goose Down
-- The request workflow comes back in the shape it had before. Data is not restored: confirmations made in the app,
-- at the kiosk or at enrollment cannot be expressed as checked paper and are deleted, lab_rules_published
-- notifications and mails go, and laborordnung.confirm grants and held check-ins stay removed.
DELETE FROM notification_mail_outbox WHERE kind = 'lab_rules_published';
ALTER TABLE notification_mail_outbox DROP CONSTRAINT notification_mail_outbox_kind_check;
ALTER TABLE notification_mail_outbox
    ADD CONSTRAINT notification_mail_outbox_kind_check CHECK (kind IN ('printer_error', 'run_finished', 'filament_change'));
DELETE FROM inbox_notifications WHERE kind = 'lab_rules_published';
ALTER TABLE inbox_notifications DROP CONSTRAINT inbox_notifications_kind_check;
ALTER TABLE inbox_notifications
    ADD CONSTRAINT inbox_notifications_kind_check CHECK (kind IN (
        'message',
        'lab_rules_confirmation_requested',
        'open_day_period_open',
        'open_day_place_freed',
        'run_finished',
        'printer_error',
        'filament_change'
    ));

UPDATE master_reauthentication_permissions SET permission_id = 'laborordnung.requests.read'
WHERE permission_id = 'laborordnung.confirmations.read';
UPDATE role_permission_grants SET permission_id = 'laborordnung.requests.read'
WHERE permission_id = 'laborordnung.confirmations.read';

CREATE TABLE attendance_holds (
    id uuid PRIMARY KEY,
    person_id uuid NOT NULL UNIQUE REFERENCES people(id) ON DELETE CASCADE,
    requested_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    check_in_device_id uuid REFERENCES managed_devices(id) ON DELETE SET NULL,
    check_in_method text NOT NULL CONSTRAINT attendance_holds_check_in_method_check
        CHECK (check_in_method IN ('password', 'pin', 'oidc', 'nfc', 'supervisor', 'enrollment')),
    check_in_assurance text NOT NULL CHECK (check_in_assurance IN ('low', 'normal', 'strong', 'strong_mfa')),
    checked_in_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    CHECK (expires_at > requested_at)
);
CREATE INDEX attendance_holds_expiry_idx ON attendance_holds (expires_at);

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION prevent_published_laborordnung_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND OLD.status = 'published' THEN
        RAISE EXCEPTION 'published Laborordnung versions are immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'published' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'published Laborordnung versions are immutable' USING ERRCODE = '23514';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
-- +goose StatementEnd
-- Dropping the column is not an UPDATE, so the restored guard does not interfere.
ALTER TABLE laborordnung_versions DROP CONSTRAINT laborordnung_versions_announced_check;
ALTER TABLE laborordnung_versions DROP COLUMN announced_at;

DELETE FROM laborordnung_confirmations WHERE method <> 'paper';
DROP INDEX laborordnung_confirmations_person_idx;
ALTER TABLE laborordnung_confirmations
    DROP CONSTRAINT laborordnung_confirmations_person_version_key,
    DROP CONSTRAINT laborordnung_confirmations_evidence_check,
    DROP COLUMN method;
ALTER TABLE laborordnung_confirmations RENAME TO laborordnung_requests;
ALTER TABLE laborordnung_requests RENAME COLUMN version_id TO required_version_id;
ALTER TABLE laborordnung_requests RENAME COLUMN confirmed_at TO completed_at;
ALTER TABLE laborordnung_requests RENAME CONSTRAINT laborordnung_confirmations_pkey TO laborordnung_requests_pkey;
ALTER TABLE laborordnung_requests
    RENAME CONSTRAINT laborordnung_confirmations_person_id_fkey TO laborordnung_requests_person_id_fkey;
ALTER TABLE laborordnung_requests
    RENAME CONSTRAINT laborordnung_confirmations_version_id_fkey TO laborordnung_requests_required_version_id_fkey;
ALTER TABLE laborordnung_requests
    RENAME CONSTRAINT laborordnung_confirmations_confirmed_by_account_id_fkey TO laborordnung_requests_confirmed_by_account_id_fkey;
ALTER TABLE laborordnung_requests
    RENAME CONSTRAINT laborordnung_confirmations_physical_document_reference_check
        TO laborordnung_requests_physical_document_reference_check;
ALTER TABLE laborordnung_requests
    RENAME CONSTRAINT laborordnung_confirmations_archive_note_check TO laborordnung_requests_archive_note_check;
ALTER TABLE laborordnung_requests
    ALTER COLUMN completed_at DROP NOT NULL,
    ADD COLUMN previous_version_id uuid REFERENCES laborordnung_versions(id) ON DELETE RESTRICT,
    ADD COLUMN status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'superseded')),
    ADD COLUMN requested_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN superseded_at timestamptz,
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
UPDATE laborordnung_requests
SET status = 'completed', requested_at = completed_at, created_at = completed_at, updated_at = completed_at;
ALTER TABLE laborordnung_requests
    ADD CONSTRAINT laborordnung_requests_check CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
    ADD CONSTRAINT laborordnung_requests_check1 CHECK ((status = 'superseded') = (superseded_at IS NOT NULL)),
    ADD CONSTRAINT laborordnung_requests_check2
        CHECK (status <> 'completed' OR (confirmed_by_account_id IS NOT NULL AND physical_document_reference IS NOT NULL));
CREATE UNIQUE INDEX laborordnung_one_pending_person_idx ON laborordnung_requests (person_id) WHERE status = 'pending';
CREATE INDEX laborordnung_requests_queue_idx ON laborordnung_requests (status, requested_at, id);
CREATE INDEX laborordnung_requests_person_idx ON laborordnung_requests (person_id, requested_at DESC);
