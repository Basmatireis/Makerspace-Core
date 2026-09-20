# Architecture and domain model

## System shape

One deployment serves exactly one makerspace/location. The system is a modular monolith composed of a React browser application, one Go API process, and one PostgreSQL database. Modules share a process and database but expose behavior through explicit service boundaries. There is no multi-tenancy, queue, Redis, distributed cache, or eventual-consistency layer.

The browser calls relative `/api/v1` routes. In development Vite proxies `/api` to the Go container. PostgreSQL is reachable only as the transactional store. Development invokes goose explicitly. In production, the backend container entrypoint runs goose before replacing itself with the API process; a migration failure therefore prevents the API from starting. The API binary never changes the schema itself.

## Backend boundaries

Business features own their service, repository/query, domain model, and tests. The modules include people, accounts, auth, authorization, roles, audit, managed devices, files/storage, Lab Rules, OIDC, SCIM, visitor enrollment, supervisors, and Open Days. A single thin `httpapi` adapter implements the generated strict interface and delegates business behavior to those feature services; it owns only transport mapping, cookies, and HTTP middleware. Shared platform code is limited to configuration, database setup, HTTP/error plumbing, logging, and optional telemetry integration.

Within a feature:

1. A generated strict OpenAPI interface defines transport inputs and outputs.
2. The handwritten HTTP adapter validates transport concerns, maps domain/transport values and safe errors, and delegates immediately.
3. A feature service enforces business rules, permissions, and transaction boundaries.
4. A feature repository or sqlc query performs explicit PostgreSQL operations.
5. The mutation and its audit event commit in the same transaction.

OpenAPI-generated types, domain types, and sqlc rows remain separate. Feature modules must not import each other's persistence packages. Cross-feature orchestration belongs in a service with narrow, concrete collaborators; cyclic package dependencies are not allowed.

## Current domain model

```text
Person 1 ─── 0..1 Account 1 ─── * AuthIdentity(password | pin | oidc)
   │                 │                    ├── 0..1 PasswordCredential
   │                 │                    └── 0..1 PINCredential
   │                 ├── * AccountRole * ─── 1 Role
   │                 │                           └── * RolePermissionGrant
   │                 ├── * Session
   │                 └── * AuthChallenge
   ├── 0..1 private profile-image File
   └── * LabRulesRequest ─── 1 immutable published LabRulesVersion ─── 1 PDF File

DeviceType 1 ─── * ManagedDevice
     ├── * RolePermissionGrantDeviceType * ─── 1 RolePermissionGrant
     └── * VisitorEnrollmentContext

SCIMConnector 1 ─── * SCIMUserMapping ─── 1 Person/Account
OIDCProvider 1 ─── * OIDC AuthIdentity

AuditEvent references an actor account and resource by nullable/minimal identifiers.

OpenDayPeriod 1 ─── * OpenDay 1 ─── 2 StaffRequirement
                              │              ├── * eligible Role
                              └── * Assignment ─── 1 Person

AcademicBreak provides independently versioned calendar context.
```

- **Person** is the human/business record. It has a UUIDv7, required first and last names, optional contact email, phone, matriculation number, and a private normalized profile-image File. At least one of email or phone must remain non-null. The old `photo_reference` field is preserved as read-only legacy metadata.
- **Account** is the optional ability for one Person to access the application. It has an enabled/disabled status and optimistic-concurrency version; disabling it revokes active sessions.
- **AuthIdentity** represents a password email, case-insensitive PIN username, or exact OIDC issuer/subject pair. Password login identifiers remain separate from Person contact email, and updating either value never silently changes the other.
- **PasswordCredential** contains only the dedicated password hash and reset-required state. Its absence means no password has been set.
- **Session** stores digests of opaque session and CSRF tokens, the account/identity, authentication method, ordered assurance, idle and absolute expiry, optional elevation expiry, and revocation state.
- **AuthChallenge** stores only a keyed code digest, expiry, attempts, single-use state, target account/identity, and non-secret delivery outcome for invitations, email verification, password reset, and PIN setup.
- **Role** is operator-configurable. Each independently identified permission grant is global, valid on any authenticated managed device, or restricted to selected device types, and specifies minimum assurance. `master` is the sole protected system role; its permissions are computed from the application registry as global at minimum low assurance rather than copied into grant rows.
- **DeviceType** is administrator-maintained classification data used by scoped role grants; authorization never hard-codes names such as Reception or Laser Terminal.
- **ManagedDevice** stores a reusable device identity, its type, token digest, expiration/revocation state, throttled last-seen time, and optimistic version. It never authenticates a user.
- **AuditEvent** contains an action, resource type/ID, nullable actor account, time, nullable HTTP request ID, changed field names, source, and selected non-sensitive metadata.
- **OpenDayPeriod** owns an inclusive local-date range and follows `draft ↔ staffing ↔ published → archived`. Backward transitions retain schedules and assignments; archive remains final and read-only. Its version serializes schedule edits and lifecycle changes.
- **OpenDay** stores UTC instants, a scheduled/cancelled state, an optimistic version, and a manager-only note. Each Open Day has stable supervisor and trainee requirements. Person assignments remain as history if eligibility Roles later change.
- **AcademicBreak** is operator-maintained inclusive date context. Public holidays are computed offline from pinned country/subdivision configuration.

UUIDv7 values are generated in application code. Timestamps use UTC `timestamptz`. Mutable people, accounts, and roles use a monotonically increasing version; clients submit `expectedVersion`, and stale writes fail with HTTP 409 and the stable `stale_write` code. Person deletion locks the Person and any attached Account so concurrent Account creation or Role assignment cannot bypass cascade-delete authorization. Login/session creation and security-sensitive Account mutations serialize on the Account row, preventing an in-flight login or password change from escaping a concurrent disable, identity change, administrative password action, or reset. Operations that could remove an enabled master acquire the last-master advisory lock before the Account lock so the invariant and lock order remain safe under concurrency.

## Privacy and deletion

Person and Account records have genuine hard-delete paths. Deleting a Person cascades its Account, identity, credential, sessions, reset token, and assignments. Deleting only an Account retains the Person. A Person with an Account requires both `people.delete` and `accounts.delete` to delete.

Audit rows do not hold before/after PII snapshots. Foreign keys to deleted actor accounts become null, while resource IDs remain context-only UUIDs without retaining the deleted record. Passwords, hashes, session/reset tokens, cookies, authorization headers, and request bodies are never written to logs or audit metadata.

## API contract and generated code

[`api/openapi.yaml`](../api/openapi.yaml) is the canonical REST contract at `/api/v1`. oapi-codegen produces Go models and strict Chi interfaces; Orval produces the fetch client and TypeScript models. Handlers implement generated interfaces, but generators never create business logic or persistence code. sqlc generates database bindings from reviewed SQL.

The contract uses lower-camel JSON properties. Optional nullable PATCH properties preserve omitted versus explicit `null`; generated Go configuration must retain this distinction. Error responses have the stable `{code, message, details, requestId}` envelope and never expose SQL/internal errors.

## Deliberate non-goals

The schema and code contain no Machines, Orders, general Events, Trainings, Rental, general-purpose document signing, Visits, Analytics, or Feedback placeholders. Events remain deliberately outside the Open Days module. Lab Rules evidence records verification of a physical document; it does not store a drawn signature or treat a checkbox, PIN, or session as a legal signature. SCIM supports Users only—Groups, Roles, and entitlements are deliberately unsupported. Visitor enrollment is available only on explicitly approved managed-device types and never creates a generic public registration route.

Visitor enrollment contexts pin the applicable Lab Rules version at creation. Their state, PDF, and resulting physical-confirmation request all reference that exact immutable version, even if another version becomes current while the visitor is enrolling. Confirmation evidence retains the signed version; ordinary policy evaluation can then report the newer version as outstanding. Device eligibility, enabled state, allowed methods, and initial-role configuration are still checked at submission; pinning the document does not freeze security configuration.
