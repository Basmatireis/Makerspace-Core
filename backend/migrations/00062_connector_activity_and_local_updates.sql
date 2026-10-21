-- +goose Up

-- Automatic runtime effects of a printer connector (ingested events, spool
-- auto-mounts, recorded runs and their jobs) are kept per connector for a short
-- time instead of in the audit log, which stays the record of staff actions.
-- Rows hold identifiers only, no personal data, and are pruned by age and count
-- (printerconnectors.ActivityRetention, ActivityLimitPerConnector).
CREATE TABLE printer_connector_activity (
    id uuid PRIMARY KEY,
    connector_id uuid NOT NULL REFERENCES printer_connectors(id) ON DELETE CASCADE,
    machine_id uuid REFERENCES machines(id) ON DELETE SET NULL,
    kind text NOT NULL CHECK (kind IN ('event_ingested', 'spool_auto_mounted', 'spool_auto_unmounted', 'run_recorded', 'job_run_updated')),
    -- The printer event, printer slot, machine run or machine job, depending on kind.
    resource_id uuid,
    event_kind text CHECK (event_kind IS NULL OR event_kind ~ '^[a-z_]{1,40}$'),
    changed_fields text[] NOT NULL DEFAULT '{}' CHECK (cardinality(changed_fields) <= 16),
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX printer_connector_activity_connector_idx ON printer_connector_activity (connector_id, occurred_at DESC, id DESC);

-- Existing runtime audit rows move into the activity log when they are recent
-- enough to be kept there; all of them leave the audit log. The audit table has
-- no append-only trigger, so a plain DELETE removes them. Audit row IDs are
-- kept, which lets Down move the rows back.
INSERT INTO printer_connector_activity (id, connector_id, machine_id, kind, resource_id, event_kind, occurred_at)
SELECT ae.id, e.connector_id, e.machine_id, 'event_ingested', ae.resource_id, e.kind, ae.occurred_at
FROM audit_events ae
JOIN printer_events e ON e.id = ae.resource_id
WHERE ae.action = 'printer_event.ingested' AND e.connector_id IS NOT NULL
  AND ae.occurred_at >= now() - interval '30 days';

INSERT INTO printer_connector_activity (id, connector_id, machine_id, kind, resource_id, occurred_at)
SELECT ae.id, c.id, u.machine_id,
    CASE ae.action WHEN 'printer_slot.spool_auto_mounted' THEN 'spool_auto_mounted' ELSE 'spool_auto_unmounted' END,
    ae.resource_id, ae.occurred_at
FROM audit_events ae
JOIN printer_connectors c ON c.id::text = ae.metadata->>'connectorId'
LEFT JOIN printer_slots s ON s.id = ae.resource_id
LEFT JOIN printer_input_units u ON u.id = s.input_unit_id
WHERE ae.action IN ('printer_slot.spool_auto_mounted', 'printer_slot.spool_auto_unmounted')
  AND ae.occurred_at >= now() - interval '30 days';

INSERT INTO printer_connector_activity (id, connector_id, machine_id, kind, resource_id, changed_fields, occurred_at)
SELECT ae.id, c.id, COALESCE(r.machine_id, j.machine_id),
    CASE ae.action WHEN 'machine_run.recorded' THEN 'run_recorded' ELSE 'job_run_updated' END,
    ae.resource_id, ae.changed_fields[1:16], ae.occurred_at
FROM audit_events ae
JOIN printer_connectors c ON c.id::text = ae.metadata->>'connectorId'
LEFT JOIN machine_runs r ON ae.action = 'machine_run.recorded' AND r.id = ae.resource_id
LEFT JOIN machine_jobs j ON ae.action = 'machine_job.recorded_run_updated' AND j.id = ae.resource_id
WHERE ae.action IN ('machine_run.recorded', 'machine_job.recorded_run_updated')
  AND ae.occurred_at >= now() - interval '30 days';

DELETE FROM audit_events
WHERE action IN (
    'printer_event.ingested',
    'printer_slot.spool_auto_mounted',
    'printer_slot.spool_auto_unmounted',
    'machine_run.recorded',
    'machine_job.recorded_run_updated'
);

-- Updates of a connector or gateway to Core's release, requested in the web UI
-- and carried out by the optional updater sidecar of its Compose bundle. Only
-- the latest request is kept; who asked for it is in the audit log.
ALTER TABLE printer_connectors
    ADD COLUMN updater_available boolean NOT NULL DEFAULT false,
    ADD COLUMN update_request_id uuid,
    ADD COLUMN update_target_version text CHECK (update_target_version IS NULL OR update_target_version ~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$'),
    ADD COLUMN update_requested_at timestamptz,
    ADD COLUMN update_status text CHECK (update_status IS NULL OR update_status IN ('requested', 'in_progress', 'succeeded', 'failed')),
    ADD COLUMN update_status_reason text CHECK (update_status_reason IS NULL OR update_status_reason ~ '^[a-z0-9_]{1,64}$'),
    ADD COLUMN update_status_at timestamptz,
    ADD CONSTRAINT printer_connectors_update_request_check CHECK (
        (update_request_id IS NULL AND update_target_version IS NULL AND update_requested_at IS NULL
            AND update_status IS NULL AND update_status_reason IS NULL AND update_status_at IS NULL)
        OR (update_request_id IS NOT NULL AND update_target_version IS NOT NULL AND update_requested_at IS NOT NULL
            AND update_status IS NOT NULL AND update_status_at IS NOT NULL)
    );

ALTER TABLE streaming_gateways
    ADD COLUMN updater_available boolean NOT NULL DEFAULT false,
    ADD COLUMN update_request_id uuid,
    ADD COLUMN update_target_version text CHECK (update_target_version IS NULL OR update_target_version ~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$'),
    ADD COLUMN update_requested_at timestamptz,
    ADD COLUMN update_status text CHECK (update_status IS NULL OR update_status IN ('requested', 'in_progress', 'succeeded', 'failed')),
    ADD COLUMN update_status_reason text CHECK (update_status_reason IS NULL OR update_status_reason ~ '^[a-z0-9_]{1,64}$'),
    ADD COLUMN update_status_at timestamptz,
    ADD CONSTRAINT streaming_gateways_update_request_check CHECK (
        (update_request_id IS NULL AND update_target_version IS NULL AND update_requested_at IS NULL
            AND update_status IS NULL AND update_status_reason IS NULL AND update_status_at IS NULL)
        OR (update_request_id IS NOT NULL AND update_target_version IS NOT NULL AND update_requested_at IS NOT NULL
            AND update_status IS NOT NULL AND update_status_at IS NOT NULL)
    );

-- +goose Down
ALTER TABLE streaming_gateways
    DROP CONSTRAINT streaming_gateways_update_request_check,
    DROP COLUMN update_status_at,
    DROP COLUMN update_status_reason,
    DROP COLUMN update_status,
    DROP COLUMN update_requested_at,
    DROP COLUMN update_target_version,
    DROP COLUMN update_request_id,
    DROP COLUMN updater_available;

ALTER TABLE printer_connectors
    DROP CONSTRAINT printer_connectors_update_request_check,
    DROP COLUMN update_status_at,
    DROP COLUMN update_status_reason,
    DROP COLUMN update_status,
    DROP COLUMN update_requested_at,
    DROP COLUMN update_target_version,
    DROP COLUMN update_request_id,
    DROP COLUMN updater_available;

-- The activity rows return to the audit log in the shape the runtime used to write them.
INSERT INTO audit_events (id, actor_type, action, resource_type, resource_id, occurred_at, changed_fields, metadata, source)
SELECT a.id, 'system',
    CASE a.kind
        WHEN 'event_ingested' THEN 'printer_event.ingested'
        WHEN 'spool_auto_mounted' THEN 'printer_slot.spool_auto_mounted'
        WHEN 'spool_auto_unmounted' THEN 'printer_slot.spool_auto_unmounted'
        WHEN 'run_recorded' THEN 'machine_run.recorded'
        ELSE 'machine_job.recorded_run_updated'
    END,
    CASE a.kind
        WHEN 'event_ingested' THEN 'printer_event'
        WHEN 'run_recorded' THEN 'machine_run'
        WHEN 'job_run_updated' THEN 'machine_job'
        ELSE 'printer_slot'
    END,
    a.resource_id, a.occurred_at,
    CASE
        WHEN a.kind = 'event_ingested' THEN ARRAY['kind', 'state']
        WHEN a.kind IN ('spool_auto_mounted', 'spool_auto_unmounted') THEN ARRAY['assignment', 'spoolId']
        ELSE a.changed_fields
    END,
    CASE a.kind WHEN 'event_ingested' THEN '{}'::jsonb ELSE jsonb_build_object('connectorId', a.connector_id::text) END,
    CASE WHEN a.kind IN ('spool_auto_mounted', 'spool_auto_unmounted') THEN 'system' ELSE 'http' END
FROM printer_connector_activity a
ON CONFLICT (id) DO NOTHING;

DROP TABLE printer_connector_activity;
