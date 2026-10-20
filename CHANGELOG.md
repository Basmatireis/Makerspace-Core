# Changelog

Notable changes to Makerspace Core are documented here. Releases follow Semantic Versioning.

## [Unreleased]

### Fixed

- Printer connector: an artifact upload Core rejects with 404 or 409 (assignment ended, run unknown or deleted, configuration changed) is quarantined and its staged 3MF deleted, instead of being retried until it expires. Artifact delivery failures now log Core's HTTP status and error code.

## [0.7.1] - 2026-10-20

### Fixed

- Streaming gateway: `ACME_DNS_PROPAGATION_WAIT` (for example `60s`) replaces the gateway's own DNS propagation check by a fixed wait before Let's Encrypt validates, for networks whose router intercepts or caches DNS on port 53 and kept the certificate request "waiting for DNS record propagation".
- Release images report their version (they reported `dev`): the release build passes `VERSION` to the image builds.
- go2rtc in the streaming and local-services stacks no longer logs a tini warning at start.
- Releases finish when their validation is skipped because CI already passed on `main`: the public-image check and the GitHub Release used to be skipped as well.
- Integration tests no longer fail in CI on Linux (credential expiry times are stored with microsecond precision; package-level database tests use isolated schemas).

## [0.7.0] - 2026-10-20

### Upgrade notes

- Migrations 00051-00055 run automatically when the production stack starts (signage, managed-device mode `signage_player`, streaming gateways, gateway hardening, connector deletion).
- The printer connector's Compose project is now `makerspace-connector` (was `makerspace-printer-connector`), so an existing connector starts with a new, empty data volume and must enroll again: create a new enrollment secret for it in Core (Machines › Connectors › New enrollment secret) and put it into `.env` as `CONNECTOR_ENROLLMENT_SECRET`. The old volume `makerspace-printer-connector_connector_data` can be removed afterwards.
- Enrollment secrets come from `.env` (`CONNECTOR_ENROLLMENT_SECRET`, `STREAM_ENROLLMENT_SECRET`) instead of Docker secret files; `*_SECRET_FILE` still works as a legacy fallback.
- Use the new release bundles per stack (Core, printer connector, streaming gateway, local services) and follow [docs/hosting.md](docs/hosting.md).

### Added

- **Digital signage.** Displays run a separate, lightweight player web app at `/player/` in a kiosk browser and are paired with a six-character code shown on the screen. Scenes are built from zone layouts with widgets (image, video, slideshow, text, QR code, clock, machine status, live camera, open days, events, announcement) and a background colour or image; playlists rotate scenes; an ordered rule list per display ("when … show …": time windows, printing machines, active announcements, unavailable live data) decides what plays, with the default playlist as fallback. Content is published per display as an immutable revision. Announcements are templates with typed fields and `{placeholders}`, started for all or selected displays and shown wherever a scene has an announcement widget. The player works offline: a service worker caches the shell, the published revision and its media, and a new revision only activates once everything is cached. Displays can be revoked or deleted in any state; a deleted display shows a new pairing code. Previews use the real upcoming open days and events. New permissions `signage.read`, `signage.manage`, `signage.content.manage`, `signage.publish`, `signage.override`; optional `SIGNAGE_PAIRING_ALLOWED_CIDRS` limits who may request pairing codes ([docs/signage.md](docs/signage.md), [docs/signage-player.md](docs/signage-player.md)).
- **Live printer cameras.** A streaming gateway in the makerspace network restreams Bambu Lab H2D and X1 Carbon cameras (verified on both) to signage displays with go2rtc over WebRTC, with an MSE fallback; video never passes through Core. Players get short-lived signed tickets only for cameras their published content uses; camera widgets can be limited to chosen machines, and displays visible from outside need explicit consent (`allowCameraOutside`). The gateway can obtain and renew its own Let's Encrypt certificate (DNS-01 via Cloudflare: `ACME_EMAIL` and `CLOUDFLARE_DNS_API_TOKEN`) or use certificate files in `./certs`. Settings › Local services manages gateways and camera assignments; new permission `local_services.manage` ([docs/streaming-gateway.md](docs/streaming-gateway.md)).
- Printer connectors and streaming gateways can be deleted in any state (`DELETE /printer-connectors/{id}`; recorded runs and printer errors are kept without the connector reference) and re-enrolled while active: a new enrollment secret keeps the entry with its assignments or cameras, the running daemon keeps working until the secret is used. A daemon given a different secret in `.env` enrolls again on its own, and its log now names Core's HTTP status and error code and explains a rejected credential.
- `DELETE /machines/{id}` (`machines.manage`, plus `printer_connectors.manage` for a connected machine; expected version) deletes a machine with its printer setup and connector assignments. It refuses with `machine_in_use` while jobs or runs exist (retire the machine instead) and with `machine_has_mounted_spools` while a spool is mounted.

### Changed

- Hosting is four Compose stacks with fixed project names and one guide, [docs/hosting.md](docs/hosting.md): `makerspace-core`, `makerspace-connector` (`printer-connector/`), `makerspace-streaming` (`streaming-gateway/`) and `makerspace-local-services` (`local-services/`, connector and gateway on one host). Each has its own `.env.example`. Every release attaches a Compose bundle per stack and publishes the `streaming-gateway` image.
- New development commands `make dev-connector` and `make dev-streaming` (each prepares its `.env`, checks enrollment or explains the next step, builds and starts; `-logs` and `-down` variants). Removed: `dev-printer-connector`, `dev-printer-connector-detached`, `dev-local-services*`, `build-local-services`, `local-services-up/down/logs`.
- Faster CI and releases with the same checks: Go images cross-compile instead of building and testing under QEMU, the frontend builds once natively, Docker layers and Playwright browsers are cached, end-to-end tests run in three shards, and a release skips repeating the validation when CI already passed on `main` for exactly the tagged commit.

### Security

- Raw binary uploads (connector artifacts, event files, profile images, branding assets, Laborordnung PDFs, signage media) are no longer read into memory by the request validator before authentication, which let unauthenticated clients force large allocations.

### Fixed

- Editing a machine failed every time: request validation rejected `expectedVersion` because `UpdateMachineRequest` extended the closed `CreateMachineRequest` through `allOf`.
- The same validation error broke editing open days, academic breaks, event sessions, shifts, requirements, task lists and tasks, surveys and session policies, and signing up for an event while signed in. These request schemas are spelled out now, and a spec test rejects request bodies whose closed `allOf` members would refuse each other's fields.
- Connecting a printer after it was set up offered only the simulator: the connection step now uses the live adapter of the printer's model (Bambu Lab H2D/X1C) with IP address, serial number and LAN access code.
- The printer's serial number is taken from the machine's external identifier until it is edited, so the same value is not typed twice.
- A failed or timed-out connection test can be repeated with Test again, and changing a connection field asks for a new test instead of keeping the old result.
- The section switcher in table toolbars no longer jitters while hovered.
- The jobs list and a machine's jobs refresh every 10 seconds, so runs reported by a connector appear without a reload.
- Replaying an already used connector enrollment with the same credential no longer fails with a server error.

## [0.6.0] - 2026-10-19

### Added

- Directory: the People group becomes Directory with People, Organizations and Staffing. Organizations get an invoice address, a contact person and informational members (migration 00045), their own list and detail pages, and member endpoints guarded by `organizations.read`/`organizations.manage`. The job form suggests the organization when the person belongs to exactly one.
- `DELETE /organizations/{id}` (`organizations.manage`, expected version) refuses with `organization_in_use` while jobs, orders or invoice requests refer to the organization; members, the pricing assignment and invoicing requirements are deleted with it.
- Material types with per-type prices (migration 00046): each legacy category and unit becomes a material type, materials and pricing rules link to it, and the free-text colour becomes a colour name and hex. Inventory gets a Material types section, statistics report by type, and printer setup warns when a mounted spool's colour differs from the colour the printer reports.
- Processes per machine type (migration 00047): `fdm_printing`, `embroidery`, `uv_printing`, `laser_cutting`, `vinyl_cutting`, `other`. Adds the `cm2` unit, run measures (stitches) and a `machine_measure` pricing rule billed per 1000 stitches. The run form and material picker follow the machine's process; the backend only accepts materials of that process.
- Mass edit in the jobs table: delete, create separate jobs, create one combined job, or attach to a job. Each bulk endpoint runs in one transaction with per-item version checks and audit events and refuses the whole request with `bulk_blocked` when any item is blocked.
- Shared filter panel for every filtered table, a section switcher in the Machines and Inventory toolbars, and links on job, run, order, payment and spool references.
- Sales frontend: overview, orders with Open/Paid/Cancelled sections and a review-jobs flow, order detail with the invoice approval section (copy for wiRef, return, forward), record payment with an invoice option, the cashbook with period filter, cash movements and semicolon CSV export, and a pricing page with the rates matrix, groups and role mapping.
- Orders expose their latest invoice request in any state and requests can be listed per order; a cancelled request stays visible with a "Request invoice again" action. Orders and payments get a printable receipt.
- Invoice request approval: draft, awaiting approval, issued. New permission `external_invoice_requests.approve` (edit, return for correction, forward to wiRef, cancel). Forwarding settles the order with an `external` "Invoice (wiRef)" payment; an invoice can be requested for partially paid orders (`alreadyPaid`).
- Cash movements (`/cash-movements`, `cash_movements.read/record`) and the expected cash in the register (`GET /payments/cash-register`, cash only).
- Role based pricing: `/pricing-role-groups` maps roles to pricing groups by priority.
- `createdBy` on orders and `recordedBy` on payments, cash movements and request events.

### Changed

- Decimal fields (quantities, areas, ink, weights, prices, amounts) keep what is typed and accept a comma: "1,5" and "1.5" both mean 1.5, thousands separators are rejected, and integer fields explain instead of clearing.
- Cash and card payments are frozen while an invoice request awaits approval or is issued. Pricing resolves job override, then organization, then role mapping by priority, then default.
- The sidebar reads Dashboard, Workshop, Sales & payments, Operations, Directory. Organization admin moved out of Settings; external invoicing and the machine-logbook configuration page redirect to their new homes.
- Machine types use a process instead of the `printer` flag; printer setup, connectors and spools stay FDM-only.

### Fixed

- Section switcher tabs point at real panels, the jobs batch bar and pricing tables no longer make narrow pages scroll sideways, and a paid order no longer says payments are paused.
- Signing in after someone else signed out lands on the dashboard instead of the previous person's last page.

### Removed

- Counter sales (`/counter-sales`, `/counter-sales/preview`, the counter sale page), the invoice request state `ready`, manual `external` payments and the per-person pricing group assignment (migrations 00048-00050; 00048 refuses to run while submitted or issued requests have an unpaid order).

## [0.5.0] - 2026-10-16

### Added

- Machines & Jobs redesign: navigation is Overview, Jobs, Machines, Inventory, Statistics. A unified work-items list shows jobs and unassigned recorded runs, machines show derived availability and the current run, and the overview and statistics gained running/needs-outcome/unlinked counts, a previous-period comparison, runtime buckets, and material cost versus losses (statistics `to` is exclusive).
- Optional job title. Start, end, runtime, running status, and outcome are derived from the job's runs.
- Price adjustments (fixed, discount percent, discount amount, multiplier) that are re-applied on recalculation, with a stored effective price.
- Machine runs replace prints: a job consists of one or more runs (manual, or recorded by a machine connector with display IDs `R-YYYY-NNNNNN`) for any machine type. Recorded runs can be created into jobs, attached to or detached from jobs on the same machine (also while running), and several runs per job are supported. Connector-reported material is consumed automatically when a run ends.
- Filament spool fills and kinds (reusable or single-use), change filament, finish, cleanup of archived single-use spools, registration of empty reusable spools, and a filament product catalog.
- `make seed-dev` demo data, repeatable on top of existing data: it reuses compatible shared records, creates missing roles, an open day period and a master when needed, and accepts `SEED_ARGS` (`-seed`, `-actor-email`); `make test-integration` uses the dedicated `makerspace_test` database.

- Printer setup backend: machine types have a `printer` flag, printer profiles a `model` and spool input units a `nozzle`; `PUT /machines/{machineId}/printer/setup` saves the profile, units and slots atomically (retiring removed slots, refusing to remove mounted ones) with one audit event; migration 00043.
- Live printer status: the connector reports its newest normalized snapshot per printer (`PUT /printer-connector/self/assignments/{assignmentId}/status`) and `GET /machines/{machineId}/printer/live-status` returns it. The snapshot covers job, temperatures, nozzles, AMS and external spool trays, errors and Wi-Fi signal, never network identifiers.
- Bambu H2D external spool holders (`vir_slot` 254 and 255) are reported as units, resolved as the active tray, and observed like AMS trays.
- Standalone Bambu Lab H2D and X1 Carbon LAN adapters with encrypted assignment credentials, authenticated MQTT telemetry, read-only implicit FTPS artifact retrieval, durable SQLite event and artifact queues, reconnect recovery, and safe unknown-state closure after prolonged disconnects.
- Private, hash-deduplicated 3MF artifacts with bounded ZIP validation, structured filament metadata, preview extraction, protected downloads, and exact-hash association with planned jobs.
- Live printer setup and diagnostics for H2D and X1C, including model-specific connection settings, write-only access-code rotation, AMS and external-spool topology, exact-RFID spool detection, and optional automatic spool mounting.
- Multi-material run reports with per-filament provenance, conservative interrupted-print G-code estimation, staff mapping of unresolved report lines to physical spools, and atomic inventory and pricing updates once a run belongs to a job.
- `make dev-printer-connector` and `make dev-printer-connector-detached` for running the standalone connector in development.

### Changed

- The printer connector polls its configuration and sends its heartbeat every 10 seconds (was 30), and fetches the configuration immediately when a heartbeat shows a newer revision.
- Automatic job ingest is gone, so connector data no longer creates unconfirmed jobs. The final-price override became a price adjustment.
- Spool lifecycle `retired` became `archived`. Ledger entries and job usages keep spool and fill snapshots.
- Counter sales always create a new manual job; confirming an existing review job is gone.
- Job timing, runtime, material usage, and outcome are derived from runs; material usage moved from jobs to runs. Concurrent run operations return 409 `retry_conflict` on rare conflicts. Migration 00041 contains the schema change.
- API: `/machine-runs` (list, detail, patch, delete, usages, cancellation, job attach/detach/create) and `POST /machine-jobs/{id}/runs`; the overview response adds `unassignedRuns`; the ledger kind is `machine_run_consumption`.
- Printer pages, run details, and connector diagnostics refresh while open; high-volume material-slot observations are summarized instead of flooding the visible machine-event history.
- Recorded-run titles prefer the printer project name. Filament estimates appear as soon as the archived 3MF is available and remain separate from final applied consumption.

### Fixed

- H2D and X1C completed prints retain every reported material instead of collapsing to one filament, and mounted spool evidence is resolved by exact AMS unit and slot rather than tray number alone.
- Interrupted multi-material prints stop accounting at the latest trustworthy layer and progress checkpoint, so later colors that were never reached are not charged.
- X1C single-nozzle filament changes use the printer's filament-to-AMS mapping instead of assigning consumption to whichever tray was current when the terminal snapshot arrived.
- Connector diagnostics tolerate newly arriving event groups, and machine, printer, run, and event views update without a manual page reload.

### Security and privacy

- MQTT, FTPS control, and FTPS data connections validate the vendored Bambu printer CA, certificate validity, full chain, and the configured serial number without an insecure verification bypass.
- Artifact uploads stream into private storage with size, hash, archive, path-traversal, entry-count, expansion, and image limits; printer logs, access codes, network identifiers, RFID values, and private 3MF fixtures remain outside the repository.

### Known limitations

- The connector is monitoring and ingestion only: it does not start, pause, resume, cancel, upload to, or otherwise control a printer.
- H2D and X1C LAN behavior has been exercised against the available printers, while H2D same-hotend AMS color switching remains hardware-unverified and intentionally stays unresolved when the observed route history is ambiguous.

### Removed

- `POST /machine-jobs/automatic`, the review-queue UI, and the final-price override endpoint and schemas.
- `/prints` and its subresources, `/machine-jobs/{id}/usages`, and `/machine-jobs/{id}/run-cancellation`, replaced by runs.
- Print submissions, print attempts, filament declarations, printer-event reconciliation, linking observed runs to attempts, and the review queue with job confirmation, including their tables, endpoints, and the `print_submissions.read`, `print_submissions.manage`, and `machine_jobs.review` permissions.

## [0.4.0] - 2026-10-05

### Added

- Configurable makerspace identity, colors, image assets, and legal content, with public branding applied consistently across authenticated and public pages.
- End-to-end event management for planning, sessions, shifts, staffing assignments, task lists, files, public event pages, and authenticated or token-based signups.
- Directory filtering and bulk actions, richer supervisor staffing views, and direct role assignment on Person records.
- Global academic-break administration for Open Day planning, including a permission-protected list API and period-aware management UI.

### Changed

- Open Day period creation now focuses on the period and date range, while academic breaks and schedule setup live in their dedicated management views.
- Open Day schedule editing, role administration, People, Members, machine-logbook, and settings screens use more compact Carbon workspaces and responsive interaction patterns.
- Role administration now centers one selected role at a time, with explicit none/self/all access controls and an integrated permission detail panel.
- Frontend delivery keeps charting behind its asynchronous boundary, serves compressed static assets with production-safe cache behavior, and enforces documented bundle budgets.

### Fixed

- Branding asset uploads are sent as binary request bodies so uploaded images are preserved correctly.
- Directory filters, supervisor assignment counts, Open Day date handling, and responsive table and toolbar behavior now remain consistent across API, desktop, and narrow-screen flows.

### Security and privacy

- Event, branding, People, role-assignment, and academic-break operations use registered permissions, service-layer authorization, and transactional audit behavior where data is mutated.
- Public event and branding responses expose only purpose-specific fields; private event files and signup capabilities remain protected by visibility rules and scoped tokens.

## [0.3.0] - 2026-10-03

### Added

- Administrative PIN configuration and permission-scoped removal of password, PIN, and OIDC authentication methods, with session revocation and audit events in the same transaction.
- Authentication-method usability reporting, optional manual PIN setup links when email delivery is unavailable, and accounts that can be created without a login method.
- Open Day schedule table and calendar views with date/time filters, bulk editing, reusable defaults, recurrence selection, lifecycle actions, and safer cancellation flows for published dates.
- Dedicated People and Audit Log navigation, Makerspace status details, and richer account, role, profile, and authentication controls on Person and Profile pages.
- HTU Graz Makerspace branding across the application shell and authentication flows, including responsive branded layouts and workshop imagery.

### Changed

- New accounts are active by default, while lifecycle status and authentication methods are managed independently; login email is now optional during account creation.
- Open Day planning and preview workflows are consolidated on the period page, with legacy schedule URLs redirected to the new editing mode.
- People, staffing, audit, settings, About, and Legal & Privacy routes and navigation now follow permission-aware, task-focused groupings while preserving redirects for previous URLs.
- The sign-in, password reset, invitation, email verification, and PIN enrollment experiences use the shared brand treatment and clearer access guidance.

### Fixed

- PIN enrollment no longer requires a Person contact email when an authorized administrator can securely pass on the one-time setup link.
- Password resets can restore an existing password identity without changing account state or roles, and authentication methods can be removed without artificial account-stranding conflicts.
- Permission labels, audit presentations, responsive administration layouts, and end-to-end coverage now reflect the reorganized workflows.

### Security and privacy

- Administrative authentication changes continue to require registered method-specific permissions, optimistic version checks, credential hashing, session revocation, and transactional audit records.
- Authentication identity details expose only safe display metadata and usability state; PINs, password material, and one-time challenges remain secret.

## [0.2.0] - 2026-09-23

### Added

- Assurance-aware password, PIN, and OpenID Connect authentication, account recovery, email verification, invitations, and session reauthentication.
- Managed-device identities and device-scoped permission grants.
- SCIM 2.0 provisioning and reconciliation, OIDC provider administration, and controlled visitor enrollment.
- Private profile images, Local/S3 file storage, versioned Lab Rules, and confirmation workflows.
- Open Day lifecycle management, calendar scheduling, recurrence previews, academic breaks, self-registration, assignment management, and supervisor staffing views.
- Machine logbook catalogs, jobs and ingestion, pricing snapshots, billing, inventory ledger, and operational statistics.
- Expanded People and Account administration plus a redesigned Role permission matrix.
- A permission-gated Activity log with current safe display labels, actor filtering, cursor pagination, and privacy-preserving fallbacks.

### Changed

- Audit events now retain durable user, system, or historical-unknown actor types and expose only allowlisted current labels without storing name snapshots.
- Access logs now correlate authenticated Account IDs and authentication methods, share trusted-proxy client addresses with authentication throttling, omit unmatched raw paths, and quiet successful health probes.
- The OpenAPI contract, generated clients, authorization model, deployment documentation, production Compose bundle, and CI validation were expanded for the new modules.
- Frontend tests use bounded concurrency and realistic UI interaction timeouts for stable execution on CI runners.

### Fixed

- Open Day scheduling now rejects ambiguous or nonexistent local times, validates slot bounds, and preserves assignment labels safely.
- Visitor enrollment pins the applicable immutable Lab Rules version throughout the workflow.
- OIDC linking requires recent proof, SCIM reconciliation preserves provisional identities, and anonymous recovery remains enumeration-safe.

### Security and privacy

- Mutations and audit records remain transactional, deleted users and resources do not leave retained display-name snapshots, and sensitive credentials, request bodies, headers, and arbitrary path values remain excluded from logs.
- Role delegation, assurance requirements, device scopes, last-master protection, and sensitive Person-field permissions are enforced server-side.

## [0.1.0] - 2026-09-18

- Introduced managed devices and scoped permissions alongside the initial People, Account, Role, Open Day, and audit foundations.

## [0.0.1] - 2026-09-14

- Initial development release.

[0.6.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Basmatireis/Makerspace-Core/releases/tag/v0.1.0
[0.0.1]: https://github.com/Basmatireis/Makerspace-Core/releases/tag/v0.0.1
