# Makerspace Core

Makerspace Core is a privacy-conscious management application for one makerspace/location. It is a modular monolith: one Go API, one React application, and one PostgreSQL database per deployment.

The first vertical slice covers people, optional user accounts, email/password authentication, server-side sessions, permission-based roles, user administration, and audit logging. Machines, orders, open days, training, rental, terminals, PIN login, documents, visits, analytics, and feedback are deliberately not implemented yet.

## Technology

- Go 1.26 (`golang:1.26.5-alpine3.24`), `net/http`, Chi, pgx, sqlc, and goose
- PostgreSQL 18 (`postgres:18.6-alpine3.24`)
- Node 24 LTS (`node:24.21.0-alpine3.24`), pnpm 11.19.0, React 19.3.0, Vite 8.3.0, IBM Carbon 11 (`@carbon/react` 1.116.0), TanStack Query, and React Hook Form
- OpenAPI 3.0.3 with oapi-codegen 2.5.1 and Orval 7.21-generated bindings
- Docker Compose as the reproducible local environment

## Repository map

```text
api/openapi.yaml     canonical HTTP contract
backend/             modular Go application, migrations, SQL, and generated bindings
frontend/            React application and generated API client
docs/                architecture and operating documentation
compose.yaml         local PostgreSQL/backend/frontend environment
```

Generated Go, TypeScript, and sqlc files are committed but never edited by hand. Change their source contract/query and run `make generate`.

## License

Makerspace Core is licensed under the [Apache License 2.0](LICENSE). The
[NOTICE](NOTICE) file records the project copyright and third-party
attributions. Browser builds expose the applicable Carbon and IBM Plex notices
at `/THIRD_PARTY_NOTICES.txt`.

## Local quick start

Docker with Compose is the only required host dependency for running the application, generation, unit/integration checks, and production builds. The Playwright browser smoke suite is host-run and additionally requires Node 24, pnpm 11, and Chrome or the Playwright-managed Chromium described in [development](docs/development.md#browser-end-to-end-checks).

```sh
cp .env.example .env
# Replace POSTGRES_PASSWORD in .env before starting the database.
make migrate-up
make dev
```

Open <http://localhost:5173>. Vite proxies relative `/api` requests to the backend, so browser sessions remain same-origin. The API is also published at <http://localhost:8080/api/v1> for diagnostics.

Migrations are always an explicit operation; API startup never changes the schema. See [development](docs/development.md) for migration, generation, test, and hot-reload commands.

## Bootstrap the first master

There is no public registration or bootstrap endpoint. After applying migrations, create the first master deliberately with the interactive administrative CLI:

```sh
docker compose --profile tools run --rm --build admin bootstrap-master
```

The command prompts on its TTY for first name, last name, separate contact and login email addresses, and a non-echoed password. It accepts no password flag, standard-input pipe, or password environment variable. It is safe to retry: it refuses to create another initial master after one exists. Recovery is an explicit CLI-only workflow described in [operations](docs/operations.md).

## Essential commands

```sh
make help
make generate
make test
make test-integration
make check
make migrate-status
```

Run `make test-e2e` after the one-time browser setup for the complete smoke/accessibility suite, including the isolated live Go/PostgreSQL vertical slice. Run `pnpm test:e2e` from `frontend/` for the faster mocked UI scenarios during frontend development.

## Documentation

- [Architecture and domain model](docs/architecture.md)
- [Authentication and sessions](docs/authentication.md)
- [Bootstrap, recovery, cleanup, and deployment operations](docs/operations.md)
- [Authorization and registered permissions](docs/authorization.md)
- [Development and code generation](docs/development.md)
- [Logging and optional OpenTelemetry export](docs/observability.md)

Repository-wide AI-agent conventions are in [`AGENTS.md`](AGENTS.md), with path-specific rules under `.github/instructions/`.
