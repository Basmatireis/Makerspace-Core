-- +goose Up
-- Previous OIDC sessions recorded callback time rather than verified auth_time.
-- Preserve their login validity, but require fresh proof for sensitive operations.
UPDATE sessions SET authenticated_at='epoch'::timestamptz, assurance_expires_at=NULL WHERE auth_method='oidc';

-- Old link flows have no bound session or recent-authentication proof.
DELETE FROM oidc_flows WHERE kind='link';
ALTER TABLE oidc_flows ADD COLUMN session_id uuid REFERENCES sessions(id) ON DELETE CASCADE;
ALTER TABLE oidc_flows DROP CONSTRAINT oidc_flows_kind_check;
ALTER TABLE oidc_flows DROP CONSTRAINT oidc_flows_check;
ALTER TABLE oidc_flows ADD CONSTRAINT oidc_flows_kind_check CHECK (kind IN ('login','link','reauthenticate'));
ALTER TABLE oidc_flows ADD CONSTRAINT oidc_flows_context_check CHECK (
    (kind='login' AND account_id IS NULL AND session_id IS NULL) OR
    (kind IN ('link','reauthenticate') AND account_id IS NOT NULL AND session_id IS NOT NULL)
);

-- +goose Down
DELETE FROM oidc_flows WHERE kind IN ('link','reauthenticate');
ALTER TABLE oidc_flows DROP CONSTRAINT oidc_flows_context_check;
ALTER TABLE oidc_flows DROP CONSTRAINT oidc_flows_kind_check;
ALTER TABLE oidc_flows DROP COLUMN session_id;
ALTER TABLE oidc_flows ADD CONSTRAINT oidc_flows_kind_check CHECK (kind IN ('login','link'));
ALTER TABLE oidc_flows ADD CONSTRAINT oidc_flows_check CHECK (
    (kind='login' AND account_id IS NULL) OR (kind='link' AND account_id IS NOT NULL)
);
