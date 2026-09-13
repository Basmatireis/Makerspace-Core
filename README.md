# Makerspace Core

[![CI](https://github.com/Basmatireis/Makerspace-Core/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Basmatireis/Makerspace-Core/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/Basmatireis/Makerspace-Core?sort=semver)](https://github.com/Basmatireis/Makerspace-Core/releases/latest)
[![License](https://img.shields.io/github/license/Basmatireis/Makerspace-Core)](LICENSE)

Makerspace Core is a privacy-conscious management application for one makerspace/location. It is a modular monolith: one Go API, one React application, and one PostgreSQL database per deployment.

The first vertical slice covers people, optional user accounts, email/password authentication, server-side sessions, permission-based roles, user administration, and audit logging. Machines, orders, open days, training, rental, terminals, PIN login, documents, visits, analytics, and feedback are deliberately not implemented yet.

## Technology

- Go 1.26 (`golang:1.26.5-alpine3.24`), `net/http`, Chi, pgx, sqlc, and goose
- PostgreSQL 18 (`postgres:18.6-alpine3.24`)
- Node 24 LTS (`node:24.21.0-alpine3.24`), pnpm 11.19.0, React 19.3.0, Vite 8.3.0, IBM Carbon 11 (`@carbon/react` 1.116.0), TanStack Query, and React Hook Form
- OpenAPI 3.0.3 with oapi-codegen 2.5.1 and Orval 7.21-generated bindings
- Docker Compose for the reproducible development environment and the production deployment example

## Repository map

```text
api/openapi.yaml     canonical HTTP contract
backend/             modular Go application, migrations, SQL, and generated bindings
frontend/            React application and generated API client
docs/                architecture and operating documentation
compose.yaml         local PostgreSQL/backend/frontend environment
compose.production.yaml  production PostgreSQL/backend/frontend example
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

## Production quick start

The production Compose example runs the published frontend, backend, and PostgreSQL images. Only the nginx frontend publishes a host port; it serves the application and relays `/api/` to the backend on the private Compose network.

```sh
cp production.env.example .env.production
# Set an immutable release version, HTTPS public origin, and random database password.
docker compose --env-file .env.production -f compose.production.yaml pull
docker compose --env-file .env.production -f compose.production.yaml up -d --wait db
docker compose --env-file .env.production -f compose.production.yaml run --rm --no-deps --entrypoint goose backend -dir /app/migrations up
docker compose --env-file .env.production -f compose.production.yaml up -d --wait backend frontend
```

The default frontend binding is `127.0.0.1:8080`, ready for a host-level reverse proxy that terminates HTTPS. Migrations remain an explicit release operation. See [production operations](docs/operations.md#production-compose-deployment) before serving traffic.

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

## CI and releases

Pull requests to `main` and pushes to `main` run generated-code checks, backend and frontend checks, PostgreSQL integration tests, the full-stack Playwright suite, and production container builds. These validation runs never publish images.

Stable releases are explicit: push a `vMAJOR.MINOR.PATCH` tag to run the same validation, publish versioned backend and frontend images to GHCR, and create a GitHub Release. CI also smoke-tests the production Compose topology and nginx API relay. See [CI, releases, and container images](docs/ci-cd.md) for the release commands, tag policy, rollback procedure, and recommended branch rules.

## Documentation

- [Architecture and domain model](docs/architecture.md)
- [Authentication and sessions](docs/authentication.md)
- [Bootstrap, recovery, cleanup, and deployment operations](docs/operations.md)
- [Authorization and registered permissions](docs/authorization.md)
- [Development and code generation](docs/development.md)
- [Logging and optional OpenTelemetry export](docs/observability.md)
- [CI, releases, and container images](docs/ci-cd.md)

Repository-wide AI-agent conventions are in [`AGENTS.md`](AGENTS.md), with path-specific rules under `.github/instructions/`.
