-- +goose Up
-- people.member_since: the day the person joined the makerspace (editable by administrators).
ALTER TABLE people ADD COLUMN member_since date;
UPDATE people SET member_since = (created_at AT TIME ZONE 'Europe/Vienna')::date;
ALTER TABLE people
    ALTER COLUMN member_since SET NOT NULL,
    ALTER COLUMN member_since SET DEFAULT CURRENT_DATE;

-- One email per account: for a person with an account, people.email mirrors the account's login email
-- (the 'password' authentication identity). The application keeps both in sync inside one transaction.
-- 1. Accounts that already have a login email: the person's email becomes the login email.
UPDATE people p
SET email = i.identifier_display
FROM accounts a
JOIN auth_identities i ON i.account_id = a.id AND i.kind = 'password'
WHERE a.person_id = p.id AND p.email IS DISTINCT FROM i.identifier_display;

-- 2. Accounts without a login email adopt the person's email as login email unless another login identity
-- already uses it. Only ASCII addresses are backfilled so lower() matches the application's normalization
-- exactly (security.NormalizeEmail is trim + lowercase). Two accounts whose persons share an email: the older
-- account wins. Accounts left without a login email (no or non-ASCII email, collision) stay as they are;
-- the person detail page warns about them.
INSERT INTO auth_identities (id, account_id, kind, identifier_display, identifier_normalized)
SELECT uuidv7(), candidate.account_id, 'password', candidate.email, lower(candidate.email)
FROM (
    SELECT DISTINCT ON (lower(p.email)) a.id AS account_id, p.email
    FROM accounts a
    JOIN people p ON p.id = a.person_id
    WHERE p.email IS NOT NULL
      AND p.email ~ '^[ -~]+$'
      AND NOT EXISTS (SELECT 1 FROM auth_identities i WHERE i.account_id = a.id AND i.kind = 'password')
      AND NOT EXISTS (
          SELECT 1 FROM auth_identities i
          WHERE i.kind = 'password' AND i.identifier_normalized = lower(p.email)
      )
    ORDER BY lower(p.email), a.created_at, a.id
) candidate;

-- +goose Down
-- The email backfill is not reversed: identities created above are indistinguishable from later ones and
-- people.email keeps the mirrored value.
ALTER TABLE people DROP COLUMN member_since;
