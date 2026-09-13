# Architecture and domain model

## System shape

One deployment serves exactly one makerspace/location. The system is a modular monolith composed of a React browser application, one Go API process, and one PostgreSQL database. Modules share a process and database but expose behavior through explicit service boundaries. There is no multi-tenancy, queue, Redis, distributed cache, or eventual-consistency layer.

The browser calls relative `/api/v1` routes. In development Vite proxies `/api` to the Go container. PostgreSQL is reachable only as the transactional store; migrations run through an explicit goose command rather than API startup.

## Backend boundaries

Business features own their service, repository/query, domain model, and tests. The initial modules are people, accounts, auth, authorization, roles, and audit. A single thin `httpapi` adapter implements the generated strict interface and delegates business behavior to those feature services; it owns only transport mapping, cookies, and HTTP middleware. Shared platform code is limited to configuration, database setup, HTTP/error plumbing, logging, and optional telemetry integration.

Within a feature:

1. A generated strict OpenAPI interface defines transport inputs and outputs.
2. The handwritten HTTP adapter validates transport concerns, maps domain/transport values and safe errors, and delegates immediately.
3. A feature service enforces business rules, permissions, and transaction boundaries.
4. A feature repository or sqlc query performs explicit PostgreSQL operations.
5. The mutation and its audit event commit in the same transaction.

OpenAPI-generated types, domain types, and sqlc rows remain separate. Feature modules must not import each other's persistence packages. Cross-feature orchestration belongs in a service with narrow, concrete collaborators; cyclic package dependencies are not allowed.

## Initial domain model

```text
Person 1 ─── 0..1 Account 1 ─── 1 AuthIdentity(email_password)
                     │                    │
                     │                    └── 0..1 PasswordCredential
                     ├── * AccountRole * ─── 1 Role
                     │                           └── * RolePermission
                     ├── * Session
                     └── 0..1 active PasswordResetToken

AuditEvent references an actor account and resource by nullable/minimal identifiers.
```

- **Person** is the human/business record. It has a UUIDv7, required first and last names, optional contact email, phone, matriculation number, and a reserved photo reference. At least one of email or phone must remain non-null. Photo storage and arbitrary photo-reference writes are not part of v1.
- **Account** is the optional ability for one Person to access the application. It has an enabled/disabled status and optimistic-concurrency version; disabling it revokes active sessions.
- **AuthIdentity** keeps the normalized email login identifier separate from the Person contact email. Updating either value never silently changes the other.
- **PasswordCredential** contains only the dedicated password hash and reset-required state. Its absence means no password has been set.
- **Session** stores digests of opaque session and CSRF tokens, the account/identity, password authentication method, idle and absolute expiry, and revocation state.
- **PasswordResetToken** stores only a token digest, expiry, target account, and nullable issuing account. Only one active reset token exists per account.
- **Role** is operator-configurable. `master` is the sole protected system role; its permissions are computed from the application registry rather than copied into role-permission rows.
- **AuditEvent** contains an action, resource type/ID, nullable actor account, time, nullable HTTP request ID, changed field names, source, and selected non-sensitive metadata.

UUIDv7 values are generated in application code. Timestamps use UTC `timestamptz`. Mutable people, accounts, and roles use a monotonically increasing version; clients submit `expectedVersion`, and stale writes fail with HTTP 409 and the stable `stale_write` code. Person deletion locks the Person and any attached Account so concurrent Account creation or Role assignment cannot bypass cascade-delete authorization. Login/session creation and security-sensitive Account mutations serialize on the Account row, preventing an in-flight login or password change from escaping a concurrent disable, identity change, administrative password action, or reset. Operations that could remove an enabled master acquire the last-master advisory lock before the Account lock so the invariant and lock order remain safe under concurrency.

## Privacy and deletion

Person and Account records have genuine hard-delete paths. Deleting a Person cascades its Account, identity, credential, sessions, reset token, and assignments. Deleting only an Account retains the Person. A Person with an Account requires both `people.delete` and `accounts.delete` to delete.

Audit rows do not hold before/after PII snapshots. Foreign keys to deleted actor accounts become null, while resource IDs remain context-only UUIDs without retaining the deleted record. Passwords, hashes, session/reset tokens, cookies, authorization headers, and request bodies are never written to logs or audit metadata.

## API contract and generated code

[`api/openapi.yaml`](../api/openapi.yaml) is the canonical REST contract at `/api/v1`. oapi-codegen produces Go models and strict Chi interfaces; Orval produces the fetch client and TypeScript models. Handlers implement generated interfaces, but generators never create business logic or persistence code. sqlc generates database bindings from reviewed SQL.

The contract uses lower-camel JSON properties. Optional nullable PATCH properties preserve omitted versus explicit `null`; generated Go configuration must retain this distinction. Error responses have the stable `{code, message, details, requestId}` envelope and never expose SQL/internal errors.

## Deliberate non-goals

The initial schema and code contain no Machines, Orders, Open Days, Trainings, Rental, Documentation, Terminals, PIN authentication, document signing, Visits, Analytics, or Feedback placeholders. The Person/Account/AuthIdentity separation and recorded session authentication method provide an ordinary extension seam when a future requirement is accepted; they do not justify implementing those features now.
