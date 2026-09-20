# Makerspace Core

[![CI](https://github.com/Basmatireis/Makerspace-Core/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Basmatireis/Makerspace-Core/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/Basmatireis/Makerspace-Core?sort=semver)](https://github.com/Basmatireis/Makerspace-Core/releases/latest)
[![License](https://img.shields.io/github/license/Basmatireis/Makerspace-Core)](LICENSE)

Makerspace Core is a privacy-conscious management application for one makerspace/location. It is a modular monolith: one Go API, one React application, and one PostgreSQL database per deployment.

The implemented modules cover people, optional user accounts, password/PIN/OIDC authentication, standalone email verification, database-administered transactional SMTP, assurance- and device-scoped permission grants, server-side sessions, managed-device identities, private Local/S3 files, profile images, versioned Lab Rules evidence, SCIM 2.0 provisioning and reconciliation, controlled visitor-terminal enrollment and admission, user administration, Open Days, supervisor reporting, the machine logbook with inventory/pricing/statistics, and audit logging. Orders, training, rental, general-purpose document signing, visits, and feedback remain outside the current scope.

## Technology

- Go 1.26 (`golang:1.26.5-alpine3.24`), `net/http`, Chi, pgx, sqlc, and goose
- PostgreSQL 18 (`postgres:18.6-alpine3.24`)
- Node 24 LTS (`node:24.21.0-alpine3.24`), pnpm 11.19.0, React 19.3.0, Vite 8.3.0, IBM Carbon 11 (`@carbon/react` 1.116.0), TanStack Query, and React Hook Form
- OpenAPI 3.0.3 with oapi-codegen 2.5.1 and Orval 7.21-generated bindings
- Docker Compose for the reproducible development environment and standalone production release bundle

## Repository map

```text
api/openapi.yaml     canonical HTTP contract
backend/             modular Go application, migrations, SQL, and generated bindings
frontend/            React application and generated API client
docs/                architecture and operating documentation
compose.yaml         local PostgreSQL/backend/frontend environment
compose.production.yaml  source template for the production release bundle
```

Generated Go, TypeScript, and sqlc files are committed but never edited by hand. Change their source contract/query and run `make generate`.

## License

Makerspace Core is licensed under the [Apache License 2.0](LICENSE). The
[NOTICE](NOTICE) file records the project copyright and third-party
attributions. Browser builds expose the applicable Carbon and IBM Plex notices
at `/THIRD_PARTY_NOTICES.txt`.

## Production quick start

Download `makerspace-core-VERSION-compose.tar.gz` from the matching [GitHub Release](https://github.com/Basmatireis/Makerspace-Core/releases), extract it into an otherwise empty deployment directory, and copy `.env.example` to `.env`. Set the two blank installation-specific values: the HTTPS `PUBLIC_BASE_URL` and a random `POSTGRES_PASSWORD`.

Production startup and upgrades then use one command:

```sh
docker compose up -d
```

Compose pulls the pinned frontend/backend images and waits for PostgreSQL. The backend container applies pending migrations before starting the API, and nginx starts only after the backend is healthy. The default frontend binding is `127.0.0.1:8080`, ready for a host-level TLS reverse proxy. No repository checkout, build toolchain, Makefile, manual migration command, or dedicated migration container is required. See [production operations](docs/operations.md#production-compose-deployment) before serving traffic.

## Bootstrap the first master

There is no public registration or bootstrap endpoint. After the production deployment is healthy, create the first master deliberately from its bundle directory with the interactive administrative CLI:

```sh
docker compose run --rm --entrypoint /app/admin backend bootstrap-master
```

The command prompts on its TTY for first name, last name, separate contact and login email addresses, and a non-echoed password. It accepts no password flag, standard-input pipe, or password environment variable. It is safe to retry: it refuses to create another initial master after one exists. Recovery is an explicit CLI-only workflow described in [operations](docs/operations.md).

## Local quick start

Docker with Compose is the only required host dependency for running the application, generation, unit/integration checks, and production builds. The Playwright browser smoke suite is host-run and additionally requires Node 24, pnpm 11, and Chrome or the Playwright-managed Chromium described in [development](docs/development.md#browser-end-to-end-checks).

```sh
cp .env.example .env
# Replace POSTGRES_PASSWORD in .env before starting the database.
make migrate-up
make dev
```

Open <http://localhost:5173>. Vite proxies relative `/api` requests to the backend, so browser sessions remain same-origin. The API is also published at <http://localhost:8080/api/v1> for diagnostics.

Migrations remain explicit during development; the production backend container applies them before launching the API process. See [development](docs/development.md) for migration, generation, test, and hot-reload commands.

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

Stable releases are explicit: push a `vMAJOR.MINOR.PATCH` tag to run the same validation, publish versioned backend and frontend images to GHCR, and create a GitHub Release. CI also packages and smoke-tests the standalone production bundle and nginx API relay. See [CI, releases, and container images](docs/ci-cd.md) for the release commands, tag policy, rollback procedure, and recommended branch rules.

## Documentation

- [Architecture and domain model](docs/architecture.md)
- [Authentication and sessions](docs/authentication.md)
- [Bootstrap, recovery, cleanup, and deployment operations](docs/operations.md)
- [Authorization and registered permissions](docs/authorization.md)
- [Managed-device trust and provisioning](docs/managed-devices.md)
- [Development and code generation](docs/development.md)
- [Logging and optional OpenTelemetry export](docs/observability.md)
- [CI, releases, and container images](docs/ci-cd.md)

Repository-wide AI-agent conventions are in [`AGENTS.md`](AGENTS.md), with path-specific rules under `.github/instructions/`.
