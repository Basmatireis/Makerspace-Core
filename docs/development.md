# Development and generation workflow

## Reproducible environment

Docker Compose is authoritative for the application, generators, database checks, and image builds. Host installations of Go, Node, PostgreSQL, goose, sqlc, or OpenAPI generators are not required for those workflows. The Playwright suite is the deliberate exception: it runs against a host browser as documented below.

```sh
cp .env.example .env
```

Set a local `POSTGRES_PASSWORD` before first start. Because Compose constructs a PostgreSQL URL from this value, URL-encode characters that are not safe in a URL user-info component. Do not put master-account credentials in `.env`.

The development services are:

- `db`: exactly `postgres:18.6-alpine3.24`, with its named volume mounted at the PostgreSQL 18 parent data path;
- `backend`: exactly `golang:1.26.5-alpine3.24` for development and build, source-mounted at `/workspace/backend`, published on port 8080;
- `frontend`: exactly `node:24.21.0-alpine3.24` with pnpm 11.19.0, source-mounted at `/workspace/frontend`, published on port 5173;
- `migrate`: profile-gated goose command using the backend final image.
- `admin`: profile-gated interactive administrative CLI from the backend final image.

The backend runtime stage is exactly `alpine:3.24.1`. Its normal image entrypoint remains the API binary; the production Compose bundle selects `/app/production-entrypoint`, which applies goose migrations and then replaces itself with the API process. The frontend production stage uses the unprivileged NGINX image `nginxinc/nginx-unprivileged:1.31.3-alpine3.24`, listens on port 8080, serves the built single-page application, and proxies `/api/` to the Compose backend service. External production ingress forwards the complete origin to this frontend and remains responsible for TLS. `compose.production.yaml` is the source template for the version-pinned bundle attached to each GitHub Release; `make test-production-compose` packages and tests that standalone bundle. Package versions are exact in `backend/go.mod`, `frontend/package.json`, and `frontend/pnpm-lock.yaml`; dependency installation in the frontend image uses the frozen lockfile.

Start the schema and application explicitly:

```sh
make migrate-up
make dev
```

The frontend has Vite hot reload. It proxies relative `/api` requests to `http://backend:8080` inside Compose. Backend source is mounted; restart the backend service after a Go change when the current development command does not provide process reload:

```sh
docker compose restart backend
```

`make down` stops containers without deleting PostgreSQL data. Removing the `postgres_data` volume is destructive and intentionally has no Make target.

## Database migrations and SQL

Migrations live under `backend/migrations/` and use goose SQL `Up`/`Down` sections. Application startup never runs them.

```sh
make migrate-status
make migrate-up
make migrate-down   # intentionally reverts exactly one migration
make db-shell
```

Schema changes and their compatible application behavior belong in the same change. A migration must apply to a fresh PostgreSQL 18 database and, when safely reversible, its Down section must restore the previous schema. Destructive/data migrations require an explicit retention and rollback decision.

Feature-owned SQL queries live with their backend module. `backend/sqlc.yaml` lists each query set while sharing UUID/time mappings. Keep SQL explicit; do not hide domain rules in generic repository helpers.

## OpenAPI and sqlc generation

[`api/openapi.yaml`](../api/openapi.yaml) is the only handwritten HTTP contract. It uses OpenAPI 3.0.3 and relative server base `/api/v1`.

```sh
make generate-openapi-go
make generate-openapi-ts
make generate-sqlc
# or all three:
make generate
```

- oapi-codegen 2.5.1 reads `backend/oapi-codegen.yaml` and emits Go transport models plus strict Chi interfaces under `backend/internal/openapi/`.
- Orval 7.21 reads `frontend/orval.config.ts` and emits a tag-split fetch client and TypeScript models under `frontend/src/api/generated/`.
- sqlc 1.31.1 reads `backend/sqlc.yaml` and emits module-local pgx bindings. Goose 3.28.0 is included in the same pinned tool image for explicit migrations.

Generated files are committed and never hand-edited. Inspect generated diffs as part of the source change. Freshness can be verified with:

```sh
make check-generated
```

That target snapshots the generated Go, TypeScript, and sqlc directories, regenerates every binding, and compares the result with the snapshot. It therefore works before the initial commit as well as in later clean checkouts; stale regenerated output is left in the workspace for review.

OpenAPI changes must preserve stable lower-camel operation IDs and the `{code,message,details,requestId}` error envelope. Optional nullable PATCH fields intentionally distinguish omitted from explicit `null`; validate generated Go wrappers before accepting generator/config upgrades.

## Tests and checks

```sh
make test               # Go and frontend unit tests
make test-integration   # runs Go tests with a real Compose PostgreSQL URL
make test-production-compose # builds and smoke-tests the isolated production topology
make check              # generation freshness, vet, tests, lint, typecheck, and frontend build
make build              # build final backend and frontend stages
```

`make test-integration` first applies the Compose migrations, then supplies `TEST_DATABASE_URL` to the Go suite. Each database integration test creates a uniquely named schema, applies every ordered migration there, and drops that schema during cleanup; it does not depend on a bootstrap account or records in the default schema. Persistence and HTTP integration coverage includes authentication/reset and audit privacy, self/all access and matriculation redaction, role privilege subsets, Open Days lifecycle, atomic schedule saves, assignment locking, public-calendar privacy, last-master concurrency, deletion cascades, session revocation, password administration, Account-security race serialization, and atomic audit rollback.

Tests must not depend on an existing developer database or bootstrap account. Use isolated records/transactions and UUIDv7 IDs. Never put real credentials or PII in fixtures, snapshots, or failure output. Running `go test ./...` without `TEST_DATABASE_URL` deliberately skips the real-PostgreSQL integration package; use `make test-integration` for the required database pass.

## Browser end-to-end checks

The browser suite uses the exact `@playwright/test` 1.63.0 and `@axe-core/playwright` 4.13.0 versions in the frontend lockfile. Its fast UI scenarios start Vite on `http://127.0.0.1:4173` and intercept API calls with deterministic, non-PII fixtures. They cover login to Dashboard, permission-gated Settings/profile behavior, keyboard dismissal, responsive SideNav behavior, session-expiry handling, a custom-Role destructive confirmation, and automated WCAG A/AA scans.

The required vertical-slice scenario runs separately against real Go and PostgreSQL services. `make test-e2e` creates a uniquely named Compose project and fresh database volume, applies migrations, invokes the real bootstrap service through a test-only development command, starts the API and Vite proxy, and drives the UI through Person creation, Account provisioning and enablement, Role assignment, supervisor redaction, self-profile editing, Person/Account cascade deletion, and custom-Role management. The faster mocked browser suite additionally covers Open Days staff privacy/signup and manager schedule creation with accessibility scans and captured full-page visuals. Cleanup removes isolated containers, networks, volumes, and browser artifacts without using the ordinary development database volume.

The Alpine frontend container does not contain a browser, so run this suite on the host with Node 24 and pnpm 11:

```sh
cd frontend
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install chromium # one-time; omit when using a supported local Chrome
pnpm test:e2e
```

Run the complete isolated-stack suite from the repository root:

```sh
make test-e2e
```

It temporarily claims host ports 55432, 58080, and 55173 for its database, API, and frontend. On macOS the configuration automatically uses Google Chrome from its standard application path when present. Set `PLAYWRIGHT_CHROME_EXECUTABLE_PATH` to an explicit Chrome/Chromium executable on another host, or install the Playwright-managed Chromium with the command above. Use `pnpm test:e2e:headed` for interactive work on the fast mocked scenarios. Browser tests are intentionally separate from `make check` so the Docker-only check path does not silently depend on a host GUI/browser.

## Change discipline

Keep commits cohesive: foundation/instructions, contract and persistence generation, domain slices, auth/session, authorization/roles, bootstrap, user-management API, audit, application shell/login, Users UI, and final hardening/documentation. Do not combine CI, ingress, or speculative future modules with this first slice.
