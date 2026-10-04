# Makerspace Core repository instructions

## Architecture

- This repository is a modular monolith for one makerspace/location. Do not introduce microservices, multi-tenancy, queues, Redis, distributed caches, or speculative infrastructure.
- Organize backend code by business feature. HTTP handlers translate transport concerns; services own business rules, authorization, and transaction boundaries; repositories own SQL persistence.
- Keep OpenAPI transport types, domain types, and sqlc persistence rows separate.
- Prefer explicit code and existing focused libraries over generic frameworks or abstractions without a present use case.

## API and persistence

- `api/openapi.yaml` is the source of truth for the HTTP API. Generated files are committed and must never be edited manually.
- Use PostgreSQL through pgx and sqlc. Do not add an ORM.
- Use goose SQL migrations. Run migrations explicitly in development. Production Compose runs goose in its container entrypoint before starting the API, and migration failure must prevent startup. The API binary itself never runs migrations.
- Generate UUIDv7 identifiers in application code and use UTC `timestamptz` values.
- Mutations and their audit event must commit in the same database transaction.

## Security and privacy

- Authorize operations with registered permissions, never hard-coded business role names. `master` is the only system role.
- Backend services must enforce self/all scopes, sensitive-field permissions, last-master invariants, and role privilege-subset rules.
- Never expose matriculation numbers without their dedicated permission.
- Never log or serialize passwords, hashes, cookies, session/reset tokens, authorization headers, request bodies, or unnecessary PII.
- Store only digests of session and reset tokens. Preserve genuine hard-deletion paths and minimize retained audit data.
- Tests are required for every authorization-sensitive behavior.

## Frontend

- IBM Carbon is the authoritative design system. Use Carbon components, icons, pictograms, tokens, spacing, typography, and interaction patterns whenever suitable.
- Before building a component manually, verify Carbon does not already provide it. Do not recreate Carbon controls with handwritten HTML, CSS, or JavaScript.
- Custom CSS is limited primarily to application-specific layout and integration glue.
- Use TanStack Query for server state, React Hook Form for nontrivial forms, and local React state for local UI state. Do not add Redux by default.
- Frontend authorization is UX only; it never replaces backend enforcement.
- Do not persist private query data in browser storage.

### Frontend performance

- Treat production loading performance as an acceptance criterion. Preserve route-level code splitting and lazy-load independent pages and heavy feature libraries unless they are required for the initial login, shell, or dashboard experience.
- Keep Carbon Charts and its stylesheet behind the existing asynchronous charting boundary. Do not import chart code or chart CSS from the application entrypoint.
- Keep Carbon Sass selective. When adding a Carbon component, add only its required `@carbon/styles` module; do not restore the full `@carbon/react` stylesheet or enable unused font families.
- Prefer existing dependencies and tree-shakeable named imports. Before adding a runtime dependency, verify that its benefit justifies its production bundle cost. Do not add manual chunks, deep package imports, memoization, preloading, or other performance complexity without measured evidence.
- Keep the recursively loaded initial JavaScript graph at or below 225 kB gzip and entry CSS at or below 80 kB gzip. Measure a production build after frontend dependency, routing, styling, or bundling changes and investigate regressions rather than comparing only the entry filename.
- Preserve production delivery behavior: hashed `/assets/` files are immutable, HTML is not cached, suitable text assets are gzip-compressed, missing hashed assets return 404, and production source maps remain disabled unless an explicit operational requirement changes that policy.
- Performance work must preserve behavior, accessibility, authorization UX, and Carbon visual consistency. Validate affected routes at desktop and narrow viewports when loading or styling behavior changes.

## Quality

- Add or update tests with behavior changes. Prefer real PostgreSQL integration tests for repository/API behavior.
- Keep generated-code freshness, formatting, type checking, unit tests, integration tests, and production builds reproducible through documented commands.
- Do not add placeholder modules, pages, routes, or navigation for future makerspace concepts.
