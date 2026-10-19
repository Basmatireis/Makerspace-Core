-- +goose Up
-- Invoice address and contact person for organizations (empty string = not set),
-- plus informational membership of people in organizations. Membership never
-- restricts who may order for an organization.
ALTER TABLE organizations
    ADD COLUMN address_line text NOT NULL DEFAULT '' CHECK (address_line = btrim(address_line) AND length(address_line) <= 200),
    ADD COLUMN postal_code text NOT NULL DEFAULT '' CHECK (postal_code = btrim(postal_code) AND length(postal_code) <= 20),
    ADD COLUMN locality text NOT NULL DEFAULT '' CHECK (locality = btrim(locality) AND length(locality) <= 100),
    ADD COLUMN country_code text NOT NULL DEFAULT '' CHECK (country_code = '' OR country_code ~ '^[A-Z]{2}$'),
    ADD COLUMN contact_name text NOT NULL DEFAULT '' CHECK (contact_name = btrim(contact_name) AND length(contact_name) <= 200),
    ADD COLUMN contact_email text NOT NULL DEFAULT '' CHECK (contact_email = btrim(contact_email) AND length(contact_email) <= 254);

CREATE TABLE organization_members (
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    added_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, person_id)
);

CREATE INDEX organization_members_person_idx ON organization_members (person_id, organization_id);

-- +goose Down
DROP TABLE organization_members;
ALTER TABLE organizations
    DROP COLUMN contact_email,
    DROP COLUMN contact_name,
    DROP COLUMN country_code,
    DROP COLUMN locality,
    DROP COLUMN postal_code,
    DROP COLUMN address_line;
