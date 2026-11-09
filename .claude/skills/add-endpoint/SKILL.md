---
name: add-endpoint
description: Step-by-step procedure for adding or changing an HTTP API operation in Makerspace Core end to end — OpenAPI contract, generation, service with authorization, repository/SQL, handler, tests, frontend client and Playwright mocks, docs. Use whenever a change adds, removes or changes an operation in api/openapi.yaml.
---

# Add or change an API operation

Work through the steps in order. Each step names the check that proves it is done.

## 1. Contract

- Edit `api/openapi.yaml` only. Stable lower-camel `operationId`, the `{code,message,details,requestId}` error envelope, and a `security` entry: leave the default (staff session) unless the operation is genuinely public. A new `security: []` makes it reachable without a session; the public-operations golden test will fail until you update `backend/internal/httpapi/testdata/public_operations.txt` on purpose.
- If a new permission is needed, add it to the `PermissionId` enum in the spec.
- Run `make generate` and read the generated diff. Never edit generated files.

## 2. Persistence (if needed)

- New migration in `backend/migrations/` with the next free number on `main` (check `ls backend/migrations | tail -3` after `git fetch`). Up and Down, UUIDv7 from application code, `timestamptz`.
- Queries in `backend/internal/<feature>/db/queries.sql`, then `make generate-sqlc`.
- `make test-migrations`.

## 3. Service

- Business rules, authorization and the transaction live in `backend/internal/<feature>/service*.go`.
- Check registered permissions via the feature's guard (`require`, `authorize`, `Principal.Has`) before reading or writing. Respect `.self`/`.all` scopes using IDs from the principal, sensitive-field permissions, last-master and privilege-subset invariants.
- New permission: register it in `backend/internal/authorization/permissions.go` (registry and description), document it in `docs/authorization.md`, and grant it in a migration only where that was decided.
- Mutation and audit event in the same transaction.

## 4. Handler

- `backend/internal/httpapi/<feature>.go` translates transport ↔ domain types only. No SQL, no sqlc imports (depguard enforces this), no permission decisions.

## 5. Backend tests

- Service/unit tests for the rules.
- Integration test in `backend/tests/integration/` against real PostgreSQL covering the allowed case **and** each denial (missing permission, other person's record with only `.self`, redacted field).
- The authorization sweep (`authorization_sweep_test.go`) must stay green. If the new operation legitimately serves any signed-in person, add it to `selfServiceOperations` with a reason; never add it to silence a missing check.
- `cd backend && go test ./...` and `make test-integration`.

## 6. Frontend

- Use the regenerated Orval client and TanStack Query hooks; invalidate affected query keys after mutations.
- Gate UI by permission for UX only.
- **Add the operation to the Playwright mock API** the affected pages use (`frontend/e2e/*-api.ts`). The mocks fail on unknown requests, and a forgotten mock has broken a release before.
- `cd frontend && pnpm lint && pnpm typecheck && pnpm test && pnpm build && node scripts/check-bundle-budget.mjs`.

## 7. Docs and changelog

- The feature's page in `docs/` and an entry under `[Unreleased]` in `CHANGELOG.md`.

## 8. Review

Before opening the pull request, run the matching project reviewers in parallel: `authz-reviewer` always for a new or changed operation, `migration-reviewer` when step 2 applied, `privacy-reviewer` when personal data is stored, logged, mailed or exported, `frontend-reviewer` when step 6 applied.
