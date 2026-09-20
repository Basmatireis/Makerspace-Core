# Repository review — 2026-09-20

## Scope, provenance, and classification

Reviewed the current working tree, including untracked modules and existing local changes. This was not a comparison of HEAD alone. The password/PIN/OIDC identity expansion, assurance grants, files, Lab Rules, SCIM, visitor enrollment, mail settings, supervisor dashboard, role workspace, migration 00012 credential/session repair, and most generated changes were already present. They are **pre-existing work**, not features implemented by this review. No developer database was reset, no dependencies were upgraded, and no release was published.

Findings below are classified as **confirmed bug**, **code quality**, or **uncertain semantics**. Confirmed fixes follow the existing contract, service invariants, or a reproduced failure. Uncertain behavior is preserved, with the evidence needed for a later decision recorded explicitly. Passing checks establish the exercised behavior, not exhaustive security assurance.

## Review inventory

Each row covers handwritten source, its callers/transport mapping, SQL/schema, tests, and relevant documentation. Generated files were reviewed through OpenAPI/SQL, generator configuration, consumers, and regeneration rather than edited by hand.

| Reviewed area | Sources and review dimensions | Outcome |
| --- | --- | --- |
| Accounts and administration | `backend/internal/accounts/`, `admin/`, `cmd/admin/`; credential actions, deletion, invitation/PIN setup, master/delegation locks, CLI prompts and recovery | Challenge invalidation and shared provisioning safeguards fixed; existing recovery tests retained |
| Authentication | `auth/service.go`, `challenges.go`, `pin.go`, feature SQL; normalization, enumeration response shape, throttles, expiry/single use, session rotation/revocation | Account-first challenge locking and OIDC session revalidation fixed; timing/retention questions recorded |
| Security primitives | `security/` password/PIN/token/challenge/keyring implementations, common-password data/license | Existing limits, salts/digests, authenticated encryption and key-rotation behavior reviewed; no algorithm changes |
| Authorization | `authorization/` registry, device/assurance evaluation, self/all and delegation; `roles/` versions, master protection and editing | Existing permission-matrix tests exercised; Settings access drift fixed in client |
| Managed devices | `manageddevices/`, `httpapi/manageddevices.go`, cookies, SQL and migration 00003 | Digest-only credentials, expiry/rotation/revocation, trusted header/cookie handling, device-type scopes reviewed |
| OIDC | `oidc/`, `httpapi/oidc.go`, migration 00011 | Local TLS issuer tests added; JSON persistence compatibility and session checks fixed; lifecycle questions retained |
| SCIM | `scim/`, `httpapi/scim.go`, migration 00013 | Last-master deprovision/reconcile protection and person/account lock ordering added; reconciliation errors propagated; DELETE conflict contract corrected |
| Visitor enrollment/admission | `visitor/`, `httpapi/visitor.go`, migration 00014 | Existing device/replay/delegation/admission tests exercised; frontend secret retention and next-visitor reset fixed |
| Lab Rules | `laborordnung/`, `httpapi/laborordnung.go`, migration 00010 | Immutable versions, effective dates, read-only status, explicit confirmation, physical evidence and PDF authorization reviewed; policy-version ambiguity retained |
| Supervisors | `supervisors/`, `httpapi/supervisors.go` | Purpose-limited permission, role flag, profile/confirmation state and assignment aggregates reviewed |
| People | `people/`, relevant `httpapi/server.go` handlers; contact validation, self/all, matriculation, images and hard deletion | Profile file deletion added with negative/positive access tests |
| Files and storage | `files/`, `storage/`, migrations 00008/00009, admin verify/copy commands | S3 verification now hashes actual bytes; production TLS bypass and local volume ownership fixed; cross-store failure recovery remains debt |
| Mail and notifications | `mail/`, `notifications/`, `httpapi/mail.go`, migration 00015 | Encryption, TLS modes, dynamic configuration, disabled/manual delivery and failure outcomes reviewed; SMTP UI uses secret mutation helper |
| Audit | `audit/`, feature mutation calls, retention CLI and observability middleware | Allowlisted metadata, atomic audit rollback, actor nulling and minimal identifiers verified in existing tests |
| Open Days | `opendays/service.go`, `assignments.go`, `calendar.go`, holiday provider, SQL and migration 00002 | Whole-slot period bounds and assignment names past a full search page fixed; lifecycle/privacy/capacity/concurrency tests exercised |
| HTTP and platform | `httpapi/` adapters/router/cookies, `platform/` configuration/errors/database/logging/telemetry, `cmd/api/` | Origin/CSRF, body limits, no-store failures, safe error mapping, pool/lifecycle reviewed; secret-route no-store expanded |
| Frontend shell/client | `src/api/` handwritten client/query/secret helpers; `src/app/`, `main.tsx` | Shared Settings permissions; SCIM JSON/binary decoding and PIN-login 401 handling fixed; private data clearing and route gates reviewed |
| Frontend auth/profile/people | `features/auth/`, `profile/`, `users/`, dashboard | Generated calls, field redaction, password/code input, forms, mutation invalidation and sensitive state reviewed |
| Frontend roles/devices/settings | `features/roles/`, `devices/`, `settings/` | Existing RolesPage creation/detail URLs retained; three obsolete components and unused selectors removed |
| Frontend OIDC/SCIM/mail | `features/oidc/`, `scim/`, `mail/` | One-time tokens, secret input, request versions and error states reviewed; OIDC/SMTP secret-mutation tests added |
| Frontend visitor/policy/reporting | `features/visitor/`, `laborordnung/`, `supervisors/` | Carbon controls, private photos, terminal reset and loading/error behavior reviewed; visitor interaction/accessibility browser check added |
| Frontend Open Days | Every component/helper in `features/opendays/`: calendars, schedule working copy, recurrence, forms, filters, dates, routes and queries | Existing schedule atomicity, role eligibility UI, staff privacy and browser accessibility scenarios passed; DST policy question retained |
| Frontend integration/configuration | `styles/index.scss`, test fixtures/MSW/render setup, `e2e/`, Vite/Vitest/Playwright/ESLint/TS/Orval config, package/lock files, HTML/assets, Dockerfile/nginx | Dead CSS removed; build/lint/tests/browser checks run; nginx upload envelope fixed |
| API/generation | `api/openapi.yaml`, `backend/oapi-codegen.yaml`, `backend/sqlc.yaml`, `frontend/orval.config.ts`, all generated outputs | SCIM DELETE 409 added first to contract; all bindings regenerated; freshness includes all **15** sqlc output directories |
| Schema/migrations | Every migration 00001–00015, indexes/FKs/checks and Down guards | Missing goose block delimiters fixed in 00004–00011 and 00013–00014; real empty-database Up/Down/Up and existing credential migration tests passed |
| Tooling/deployment | `Makefile`, all shell scripts including the new migration test, Compose files/env examples, Dockerfiles/entrypoint, `.github/workflows/`, ignore/editor files | Reproducible migration round trip added to CI; production startup exception retained and tested; admin runtime config aligned |
| Documentation/instructions | README, AGENTS, `.github` instructions, every document under `docs/` | Authentication/authorization/operations/development descriptions reconciled; architecture, Open Days, device, CI and observability guidance reviewed |

## Baseline and validation

Baseline Go unit checks passed after granting localhost access for SMTP tests. The original database run was skipped because no URL was configured; that skip was not treated as a pass. On an isolated PostgreSQL 18.6 database, the pre-fix integration suite passed. Baseline frontend: 21 files / 83 tests passed. These tests did not cover the defects subsequently reproduced.

New regression cases first exposed surviving reset challenges and stale email verification. Actual goose rollback failed on an un-delimited `DO` block despite `goose validate` succeeding. New test development also exposed fixture mistakes (missing contact fields, invalid timestamps, wrong session-column name, and missing upload headers); these were corrected as test errors, not attributed to the application. The first OIDC provider test exposed JSON byte parameters incompatible with the suite's simple-protocol connection, now aligned with other modules' explicit text-to-jsonb persistence.

| Check | Result |
| --- | --- |
| Documented Docker check | `make check` passed on the completed implementation: regeneration, formatting, vet, Go unit tests, frontend lint/type checking/tests/build |
| Generated freshness | `make check-generated` passed after full OpenAPI/Orval/sqlc regeneration; every configured sqlc output included. An isolated harness independently mutated each of the 17 output directories (15 sqlc, Go OpenAPI, TS client): every mutation was detected, and unchanged outputs passed. |
| Go formatting | `gofmt -l backend` empty |
| Go static analysis | `go vet ./...` passed |
| Go tests with PostgreSQL | `go test -count=1 ./...` with an isolated `TEST_DATABASE_URL` passed; integration package 45.488 seconds |
| S3 integrity regression | Local S3-compatible HTTP fixture passed, including forged digest metadata and missing object |
| Frontend | ESLint, TypeScript, 22 files / 93 tests, and production Vite build passed |
| Playwright | Nine existing scenarios passed against the isolated live stack; the additional visitor reset scenario passed in Chrome with WCAG A/AA checks. Desktop success and mobile next-visitor screenshots were visually inspected. Ten scenarios passed in total. |
| Migrations | `make test-migrations`: real goose Up → Down to 0 → Up passed in a fresh project; credential-preservation/repair tests also passed in the integration suite |
| Production | Both final images built; standalone Compose startup, migration gating, ready proxy, API recreation, private-volume write check and large-upload gateway probe validated in the final smoke run |

Isolated projects used disposable credentials and separate volumes. Integration tests create/drop unique schemas. The migration and production scripts remove only their own projects. No production identity provider, mail account, remote S3 bucket, GitHub release, or external ingress was contacted for validation. Local TLS OIDC, SMTP, and S3 protocol fixtures were used. Vite still emits existing Sass/chunk-size warnings; these are not test failures.

`git diff --check` reports trailing whitespace emitted by the pinned Orval generator in generated clients. Handwritten diffs are clean; generated files were kept identical to generator output rather than manually reformatted.

## 1. Bugs fixed

| ID / classification | Evidence, correction, and impact | Validation / references |
| --- | --- | --- |
| B1 — confirmed bug | Users with only `oidc.manage` could see Settings navigation but fail its route gate; mail-only users lacked Settings access. One shared list now gates both. | Positive isolated-permission and negative route cases in [`App.test.tsx`](../frontend/src/app/App.test.tsx); [`permissions.ts`](../frontend/src/features/auth/permissions.ts), [`App.tsx`](../frontend/src/app/App.tsx) |
| B2 — confirmed bug | Administrative password set/recover-master and login-email changes removed legacy reset tokens but left newer password challenges redeemable. All three now invalidate reset/invitation/verification challenges atomically. Email changes also clear verification when the normalized address changes. | [`review_auth_test.go`](../backend/tests/integration/review_auth_test.go), [`accounts/service.go`](../backend/internal/accounts/service.go), [`accounts/db/queries.sql`](../backend/internal/accounts/db/queries.sql), [`admin/service.go`](../backend/internal/admin/service.go) |
| B3 — confirmed bug | New password challenge completion locked the challenge before the Account, unlike credential administration. Account-first locking plus target revalidation prevents a waiting operation from using cancelled/retargeted challenges and removes that lock inversion. | Real PostgreSQL blocked-query/cancelled-challenge regression; [`auth/challenges.go`](../backend/internal/auth/challenges.go) |
| B4 — confirmed bug | OIDC session creation accepted unchecked identity/account pairs and could create a session after a status change. It now locks/rechecks the Account and identity; session lookup rejects disabled identities. | Enabled/disabled-account/disabled-identity/foreign-identity cases in `review_auth_test.go`; [`auth/service.go`](../backend/internal/auth/service.go), auth SQL |
| B5 — confirmed bug | SCIM could disable/delete the last enabled master, or reconcile it into a disabled target. The accounts service now supplies the existing invariant and lock to provisioning. Reconciliation locks people before Account security locks and rolls back on a master conflict. DELETE returns protocol 409 rather than mapping every protocol failure to 404. | Negative last-master and positive second-master/deactivated-target cases in [`scim_test.go`](../backend/tests/integration/scim_test.go); [`accounts/provisioning.go`](../backend/internal/accounts/provisioning.go), [`scim/service.go`](../backend/internal/scim/service.go), OpenAPI and HTTP adapter |
| B6 — confirmed bug | Person hard deletion left its private profile file and bytes retained. Successful deletion now invokes system file cleanup, including when deleting the actor's own Account. | Denied deletion preserves bytes; authorized deletion removes Person/File/blob and records audit: [`review_files_test.go`](../backend/tests/integration/review_files_test.go), [`people/service.go`](../backend/internal/people/service.go). Failure-recovery limitation remains in section 8. |
| B7 — confirmed bug | Shrinking an Open Day period checked slot starts but not ends. An overnight slot could lie partly outside the period. Both local-date bounds are checked, treating an exact midnight end as exclusive. | [`review_opendays_test.go`](../backend/tests/integration/review_opendays_test.go), [`opendays/service.go`](../backend/internal/opendays/service.go) |
| B8 — confirmed bug | Assignment responses searched only the first 200 eligible people for a display name. Eligible people past that page received an empty name. A direct Person lookup follows successful authorization/eligibility checks. | More than 200 eligible people regression; [`assignments.go`](../backend/internal/opendays/assignments.go), Open Days SQL |
| B9 — confirmed bug | SMTP input was retained in mutation variables, and visitor input included PIN/photo/PII. SMTP, visitor, and OIDC secret requests now use the existing short-lived secret helper; visitor success clears local fields and provides a fresh next-visitor context. | Success/failure SMTP and OIDC tests; visitor submitted/next-user tests; relevant feature pages and [`use-secret-mutation.ts`](../frontend/src/api/use-secret-mutation.ts) |
| B10 — confirmed bug | The fetch client treated SCIM `+json` as text and parameterized PDFs as text. PIN-login 401s also emitted a session-expiry event. MIME parsing and public-login classification now match the actual contract. | [`http-client.test.ts`](../frontend/src/api/http-client.test.ts), [`http-client.ts`](../frontend/src/api/http-client.ts) |
| B11 — confirmed bug | Several rollback `DO` blocks were split incorrectly by goose. Explicit statement delimiters preserve each block. | Real complete goose round trip; migrations 00004–00011, 00013–00014 |
| B12 — confirmed bug | The unprivileged production API lacked ownership of a fresh local file-storage directory. The final image creates/chowns it before switching user. | Non-root persistent-volume write probe in [`test-production-compose.sh`](../scripts/test-production-compose.sh), [`backend/Dockerfile`](../backend/Dockerfile) |
| B13 — confirmed bug | Production S3 configuration could bypass TLS by supplying an explicit `http://` endpoint with `S3_DISABLE_TLS=false`. Endpoint parsing now requires HTTPS in production and rejects credentials/query/fragment. | Positive HTTPS/bare-host and negative HTTP config cases; [`config_test.go`](../backend/internal/platform/config/config_test.go) |
| B14 — confirmed bug | nginx's default 1 MiB limit rejected otherwise supported image/PDF uploads. `/api/` now allows the API's 26 MiB envelope; feature limits remain in the service. | Two-MiB request reaches API authentication in production smoke; [`nginx.conf`](../frontend/nginx.conf) |
| B15 — confirmed bug | `verify-files`/copy verification trusted uploader-controlled S3 SHA metadata, so same-size corrupt content could pass. S3 metadata verification now streams and hashes the actual object. | Local S3 fixture returns misleading SHA metadata and altered equal-length bytes; [`s3_test.go`](../backend/internal/storage/s3_test.go), [`s3.go`](../backend/internal/storage/s3.go) |

## 2. Code-quality improvements

- **Q1 — code quality:** [`check-generated.sh`](../scripts/check-generated.sh) derives sqlc output coverage from `sqlc.yaml`, replacing the incomplete hard-coded list. All 15 current modules, including managed devices and newer features, participate.
- **Q2 — code quality:** development admin and backend reuse one environment mapping and the private-file volume, preventing key/storage configuration drift. No new infrastructure was introduced.
- **Q3 — code quality:** SCIM no longer discards re-read errors during reconciliation or returns apparent success when inactive creation unexpectedly disables no identity.
- **Q4 — code quality:** OIDC JSON parameters use explicit text-to-jsonb conversion, consistent with audit/SCIM and both pgx connection modes. No mapping semantics changed.
- **Q5 — code quality:** visitor upload decoding now reports errors and rejects oversized files before reading them; the page uses Carbon Form. Obsolete PIN normalization binding removed.
- **Q6 — code quality:** authentication, authorization, production secrets/storage, migration behavior, and generation documentation now describe the existing expanded implementation. Production smoke fixtures supply the newly required crypto keys; configuration tests isolate those environment fields.
- **Q7 — code quality:** no-store middleware now covers visitor contexts and administrator invitation/PIN/SCIM token-issuance failures as well as their successful responses; router tests cover the additions.

## 3. Architectural improvements

The small [`accounts/provisioning.go`](../backend/internal/accounts/provisioning.go) boundary lets SCIM reuse Account ownership of the last-master invariant without importing accounts persistence or duplicating its rule. Transaction ownership remains in SCIM. The Settings permission list and existing secret-mutation helper similarly remove concrete duplication. The modular monolith, permission registry, SQL repositories, Carbon, TanStack Query, and current dependency versions remain intact.

## 4. Dead or obsolete code removed

Removed unreferenced `RoleCreatePage.tsx`, `RoleDetailPage.tsx`, and `PermissionChecklist.tsx`, plus unused `.permission-group` and `.permission-grant-row` selectors. `RolesPage` still handles the existing creation and detail URLs. No newer feature module or pre-existing unfinished implementation was deleted.

## 5. Tests added or improved

New PostgreSQL tests cover administrative challenge invalidation, email verification reset, challenge/account locking, invalid OIDC session targets, SCIM master protection/reconciliation rollback, private-profile hard deletion, overnight period bounds, and names beyond an eligibility page. The local TLS OIDC test exercises browser/state binding, expired flow, nonce/issuer/token expiry rejection, real PKCE exchange/signature verification, trusted ACR assurance, role-free JIT without email matching, and callback replay.

New client tests cover isolated Settings permissions and denied routes, SMTP/OIDC secret variables after success/failure, visitor reset, PIN-login failures, SCIM JSON, and parameterized binary content. Router/config tests exercise no-store failures and S3 TLS enforcement. A local S3 service tests actual byte verification. A visitor Playwright scenario checks reset, page errors, accessibility and desktop/mobile screenshots. The new migration target runs in CI; production smoke checks add storage ownership and upload size.

Existing tests also exercise self/all permissions, matriculation redaction, managed/unmanaged/selected-type devices, assurance and master/non-master delegation, stale versions, last-master races, account/session security races, audit rollback, migration credential preservation, visitor replay/admission, immutable Lab Rules, and Open Days final-slot concurrency/public privacy. These are retained coverage, not newly authored tests.

## 6. Behavior-changing modifications

The B1–B15 entries identify behavior changes. Public API surface changes are limited to documenting SCIM DELETE 409. Login-email replacement now requires fresh verification; administrative security changes reject older setup/recovery codes; unsafe SCIM deprovision/reconcile operations are denied. File integrity verification reads S3 objects rather than trusting HEAD metadata, increasing verification bandwidth. Terminal success clears input and offers Next visitor. Production allows supported upload envelopes and can write fresh private storage.

Self password-change versus outstanding recovery precedence was deliberately preserved because an existing regression explicitly requires recovery completion to win. No API route, authentication method, permission, role, or deployment migration policy was removed.

## 7. Suspicious areas intentionally left unchanged

All items below are **uncertain semantics**, not asserted exploit reproductions.

| ID | Contradiction / possible impact | Why preserved / information needed |
| --- | --- | --- |
| U1 | SCIM reconciliation calls a source “provisional” but checks `provisioning_source='scim'`, not `first_authenticated_at`. It unions Roles under `scim.manage`, whereas ordinary Role assignment applies privilege subsets. (`scim/service.go`, `TransferAccountRoles`.) | It is unclear whether reconciliation is an intentionally privileged identity merge or limited duplicate cleanup. Define whether authenticated sources are eligible and whether role transfer requires `accounts.roles.assign`/subset/master authority. The unconditional last-master invariant is fixed independently. |
| U2 | Remaining-method queries count an OIDC identity whose provider may be disabled. Disabling a provider does not itself revoke all its existing sessions. | Provider maintenance might intentionally preserve existing sessions, or disablement might mean immediate credential revocation. Define the intended distinction and whether temporarily unavailable providers count as recovery methods. |
| U3 | Self OIDC linking requires a local password even for OIDC/PIN-only Accounts; registered `identities.oidc.link.all` has no corresponding administrative browser flow. | Adding reauthentication/step-up or linking another person's external subject would invent a security workflow. Specify accepted reauthentication methods and the administrative proof-of-ownership flow. |
| U4 | SCIM `externalId` becomes OIDC subject, while updating a mapping can change that subject; PATCH is a read/transform/replace adapter with a limited multi-value dialect. | Define immutable-subject versus reassignment policy, required session revocation, supported upstream PATCH dialects, and concurrent-patch conflict semantics. Test against the actual provisioner before expanding it. |
| U5 | Visitor settings say new contexts use new settings, but submission reloads current configuration and the current Lab Rules version. A visitor may have reviewed an older document before publication changes. | Decide whether context pins a configuration/document version, fails on change, or deliberately adopts latest policy. The expected acknowledgement/admission policy is missing. |
| U6 | Anonymous recovery has a uniform response shape, but known deliverable Accounts synchronously perform database/mail work while unknown Accounts return sooner. | Timing guarantees and acceptable delivery behavior are unspecified. Changing to asynchronous delivery would require an explicit bounded in-process design or other approved policy, not a speculative queue. |
| U7 | Recurrence/date conversion normalizes ambiguous/nonexistent DST wall times; backend accepts explicit instants. | Decide whether ambiguous clocks select the first/second occurrence or require user correction, and whether gap times are rejected. Ordinary Vienna timezone and overnight checks remain unchanged. |

## 8. Remaining technical debt

- **Code quality — storage failure recovery:** File deletion commits metadata before external blob deletion; profile replacement/failed workflow cleanup can ignore storage-delete failures. The Person deletion fix covers successful cleanup, not atomicity across PostgreSQL and an external store. A storage failure can leave a blob or cause an error after the Person is already deleted. Define a recoverable deletion record/retry command and add crash/failure-injection tests before claiming complete physical erasure under failure. No queue or distributed transaction was added.
- **Code quality / retention decision:** `admin.Cleanup` prunes sessions, legacy reset tokens, and audit, but does not invoke newer challenge/flow cleanup helpers or prune visitor contexts/PIN throttle history. These rows can retain delivery addresses or keyed identifiers past validity. Specify diagnostic retention and wire bounded cleanup with active-token preservation tests; expiry enforcement itself still rejects expired credentials.
- **Code quality — UI maintainability:** Several newer settings/visitor/Lab Rules forms use many local states and dense JSX rather than the repository's preferred React Hook Form pattern. Consolidate form ownership and dirty/refetch behavior in a focused UI change with interaction tests. Existing Carbon controls were retained; no wholesale rewrite was attempted.
- **Code quality — bundle size:** Production build reports Sass deprecations and a large eager bundle. Route-level splitting and stylesheet modernization deserve measured work rather than dependency upgrades during this review.
- **Code quality — service boundaries:** Some existing administrative/visitor orchestration reaches across feature persistence, and SCIM PATCH transformation lives in the HTTP adapter. The new provisioning boundary removes one concrete duplicated invariant; a broader boundary rewrite was intentionally avoided.
- **Code quality — CI/deployment policy:** CI skips documentation-only path changes, which can interact with required status checks; release tag instructions require `main`, while the workflow validates tag syntax without enforcing ancestry. Confirm desired repository/release policy before changing those gates. Remote Actions/GHCR execution was not performed.

## 9. Areas that should receive a separate focused review

1. OIDC/SCIM identity lifecycle and reconciliation: decisions U1–U4, concurrent linking/unlinking/provider changes, key rotation concurrent with provider edits, and the real upstream provisioner's interoperability. Local handshake and core deprovision tests pass; they do not cover every external-provider lifecycle.
2. Private storage and deletion under faults: crash boundaries, persistent cleanup tracking, S3 network/permission failures, backup restore and deletion retention. Actual S3 bytes are now verified, but no remote bucket was used.
3. Visitor policy consistency and shared-terminal UX: U5, long-lived camera sessions, abandoning incomplete forms, policy updates during enrollment, and full device-native integration. Existing backend enrollment/admission tests and the new browser reset test are complementary, not a hardware-kiosk certification.
4. Authentication abuse and retention: timing behavior, peak concurrent PIN attempts, hash work before some rejection paths, rate-limit retention, and privacy operating policy.
5. Accessibility/form-state work across all newer configuration screens and explicit DST behavior. The exercised Playwright scenarios pass automated WCAG checks; untested screens are not claimed fully accessible.

## 10. Migrations or deployment considerations

Automatic production migrations are explicitly preserved in AGENTS and documentation: Compose invokes `/app/production-entrypoint`, goose must succeed before the API starts, and the API binary never migrates. Development migrations remain explicit. This review adds no new migration version; it corrects goose parsing delimiters in existing development Down sections. Existing data-preservation guards remain and can intentionally refuse a lossy downgrade. Never apply the test Down-to-zero sequence to real data.

Supply stable independent `AUTH_CHALLENGE_HMAC_KEY`, `PIN_PEPPER`, and `APP_ENCRYPTION_KEYS` in production alongside database/origin settings. The smoke values are disposable fixtures. Fresh file volumes get non-root ownership; existing volumes need an ownership/write check because rebuilding an image does not change existing volume metadata. Back up private files and encryption configuration with the database. Custom S3 endpoints must use TLS; digest verification now incurs object reads. External ingress also needs an upload limit compatible with the API's 26 MiB envelope.

No user-owned volume was deleted, no secret rotation was performed, and no production deployment or remote release was changed. The working tree contains the cohesive review corrections alongside the preserved pre-existing work.
