-- +goose Up
CREATE TABLE person_roles (
    person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    assigned_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    assigned_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (person_id, role_id)
);

INSERT INTO person_roles (person_id, role_id, assigned_by_account_id, assigned_at)
SELECT a.person_id, ar.role_id, ar.assigned_by_account_id, ar.assigned_at
FROM account_roles ar
JOIN accounts a ON a.id = ar.account_id;

CREATE INDEX person_roles_role_idx ON person_roles (role_id, person_id);

DROP TABLE account_roles;

UPDATE role_permission_grants
SET permission_id = 'people.roles.assign'
WHERE permission_id = 'accounts.roles.assign';

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM person_roles pr
        LEFT JOIN accounts a ON a.person_id = pr.person_id
        WHERE a.id IS NULL
    ) THEN
        RAISE EXCEPTION 'cannot downgrade while a Person without an Account has Role assignments';
    END IF;
END $$;
-- +goose StatementEnd

UPDATE role_permission_grants
SET permission_id = 'accounts.roles.assign'
WHERE permission_id = 'people.roles.assign';

CREATE TABLE account_roles (
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    assigned_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    assigned_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, role_id)
);

INSERT INTO account_roles (account_id, role_id, assigned_by_account_id, assigned_at)
SELECT a.id, pr.role_id, pr.assigned_by_account_id, pr.assigned_at
FROM person_roles pr
JOIN accounts a ON a.person_id = pr.person_id;

CREATE INDEX account_roles_role_idx ON account_roles (role_id, account_id);

DROP TABLE person_roles;
