-- +goose Up
ALTER TABLE audit_events
    ADD COLUMN actor_type text NOT NULL DEFAULT 'unknown'
        CHECK (actor_type IN ('user', 'system', 'unknown'));

UPDATE audit_events
SET actor_type = CASE
    WHEN actor_account_id IS NOT NULL THEN 'user'
    WHEN source IN ('system', 'admin_cli') THEN 'system'
    ELSE 'unknown'
END;

ALTER TABLE audit_events
    ADD CONSTRAINT audit_events_system_actor_check
        CHECK (actor_type <> 'system' OR actor_account_id IS NULL);

-- +goose Down
ALTER TABLE audit_events DROP CONSTRAINT audit_events_system_actor_check;
ALTER TABLE audit_events DROP COLUMN actor_type;
