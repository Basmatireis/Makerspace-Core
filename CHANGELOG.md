# Changelog

Notable changes to Makerspace Core are documented here. Releases follow Semantic Versioning.

## [Unreleased]

### Upgrade notes

- Migration 00064 adds an optional Reply-To address to the wiRef delivery settings. It starts empty, so replies keep going to the mail sender address. API: `replyToEmail` is part of `WiRefDeliverySettings` and required in `UpdateWiRefDeliverySettingsRequest` (an empty string means none).

### Added

- **Reply-To for the wiRef mail.** Settings → Invoicing has an optional reply-to address. Replies from the accounting office go there instead of to the sender address of the email delivery settings, which is often an unread sending account. It is included in configuration export and import.
- **Detected spool tags when registering and editing spools.** Receive stock (new spool or reusable spool) and Register spool / Edit spool offer the NFC tags printers currently read, like Add identifier and Change filament. Register spool can set the NFC tag of the first fill; Edit spool adds a tag to the current fill. API: `CreateFilamentSpoolRequest` takes optional `identifiers` (not with `stockMode: empty`; a taken tag is refused with 409 `identifier_in_use`).

## [0.8.3] - 2026-10-22

### Upgrade notes

- Migration 00060 changes event data: `planning` events become `draft`, `archived` events become `completed` (closed date kept). Tasks `in progress` and `blocked` become open, cancelled tasks become done; priorities `high` and `urgent` become Important, the others are dropped.
- New permissions `events.signup` and `events.read_assignments`. The migration grants `events.signup` to every role with `open_days.signup` and `events.read_assignments` to every role with `open_days.read_assignments`, `events.staffing.manage` or `events.assign`. Review roles that should not let members join event shifts.
- `events.read` alone no longer shows draft events; drafts need `events.manage`, `events.staffing.manage` or `events.assign`.
- API: the `start-planning`, `return-to-planning` and `archive` event actions and the per-position endpoints under `/events/{id}/shifts/{shiftId}/requirements` are gone; positions are saved with their shift. `GET /events` is paged (`scope`, `search`, `ownerPersonId`, `page`, `pageSize`). Tasks use `important` instead of `priority`.
- Migration 00061: every account now has one email. For a person with an account, the person's email mirrors the account's login email. Accounts without a login email adopt their person's email when no other login uses it (plain ASCII addresses only; on a collision the older account wins). Accounts left without one are flagged on the person page with "Set login email". The migration also adds `people.member_since`, filled from the person's creation date.
- Migration 00062 moves connector runtime entries (`printer_event.ingested`, `printer_slot.spool_auto_mounted`/`_unmounted`, `machine_run.recorded`, `machine_job.recorded_run_updated`) from the last 30 days out of the audit log into the new per-connector activity log and deletes the older ones. Admin actions on connectors stay audited. It also adds update request columns for connectors and gateways.
- Migration 00063 adds the wiRef delivery settings and per-request delivery records.
- New permissions `invoicing.settings.manage`, `configuration.export` and `configuration.import`; existing roles do not get them (master does).
- API: `CreateAccountRequest.loginEmail` is required. `PATCH /people/{id}` rejects an email change for a person with an account (422 `email_managed_by_account`); use `PUT /accounts/{id}/login-email`. `memberSince` on the dashboard and supervisors is now a `date`, and `Person` has an editable `memberSince` (needs `people.update.all`).
- Update Core before the printer connector and streaming gateway. Web updates need the optional `updater` sidecar (Compose profile `updater`, Docker socket = root on that host, see `docs/hosting.md`); without it, update as before.
- Settings moved: OpenID Connect and SCIM are one page, Session policies and Managed devices are one page, printer connectors moved from the Machines page to Settings → Local services. Old links redirect.

### Added

- **wiRef delivery.** When an invoice request is approved and forwarded, Core emails it to the wiRef address set in Settings → Invoicing, as a branded mail with a PDF attachment, after the approval is committed. Subject, intro and closing of mail and PDF are editable with placeholders (`{{organisation}}`, `{{anforderungsnummer}}`, `{{summe}}`, …) and optional fields can be switched off; preview, sample PDF and test mail included. The invoice request shows the delivery status and can be resent (`external_invoice_requests.approve`).
- **Configuration export and import.** Settings → Export & import downloads roles, device types and session policies, the machine catalog, inventory articles, pricing, open-day requirements, lab rules, surveys, visitor enrollment, branding and mail settings (never secrets) as one JSON file. Importing previews every change first; Overwrite makes each chosen section match the file (entries still in use are deactivated or kept), Insert only adds what is missing. The import runs in one transaction. See `docs/configuration-transfer.md`.
- **Updates from the web UI.** Settings → Local services → Versions and updates shows each connector's and gateway's version next to Core's and updates them to Core's version through the optional updater sidecar.
- **Connector activity log.** Connector diagnostics have an Activity log tab with the runtime events that used to fill the audit log (kept 30 days, at most 10,000 per connector).
- **Member since.** People have a "member since" date, used by the dashboard and the supervisors list. Administrators can edit it, independently of when the account was created.
- **Members join event shifts in the app.** With `events.signup` members see a helper view of each confirmed event and join or leave open places themselves; the same capacity, role, signup-window and overlap rules apply. Names of co-helpers need `events.read_assignments`.
- **Go-live readiness.** Events report whether the public page and helper signup are live and what is still missing.
- **Events screens redesigned.** `/events` pages events into Upcoming, Drafts and Past with search and an owner filter; organizers see status, public page, signup, staffing and overdue tasks, helpers see open places and their own shifts. An event opens as a participant view (programme by day, Join, a confirmed Leave) and organizers switch to an edit mode (`?mode=edit`) with Overview and next steps, a Go live panel, Programme with a positions editor, Helpers by shift and by helper, Tasks, a Public page tab with a live preview of the real page, and Files. Creating an event also creates its first session.
- **Public event page.** The visitor page has a Help us section with availability per position, a signup dialog with the one-time management link, and move/cancel for signed-in members.
- **Event helpers overview** grouped by helper, with unlinked public signups, suggested people and overridden overlaps.
- Shifts can be duplicated; new events can be created with their first session.
- Event documentation in `docs/events.md`.

### Changed

- One email per account: person pages show a single Email field. For account holders it is the login email.
- System mails (password reset, invitations, PIN setup, email verification, security notices, surveys) are branded HTML with a plain-text part, using the configured name, colour, logo and legal links.
- Reset, invitation and verification links carry the code, so it no longer has to be copied from the mail. The page reads it once and removes it from the address bar.
- Printer connectors and streaming gateways are managed together in Settings → Local services.
- Settings redesign: grouped overview (Access & identity, Lab operations, Communication & appearance, Sales & invoicing, Local services, Data), single sign-on (OIDC + SCIM) and devices & sessions on one page each, and a consistent frame for every settings screen. The Pricing tile is gone; pricing stays under Sales & payments.
- Events have four statuses: Draft, Confirmed, Completed, Cancelled. Helper signup (public and in the app) opens only for confirmed events; a public page can go live from a draft. Completed and cancelled events keep tasks and files editable.
- Event lists are scoped by date (upcoming, drafts, past), sorted by start and paged.
- Shifts are saved together with their positions in one request.
- Tasks are open or done with an Important flag and can be filtered by assignee, overdue and done.
- Toolchain and dependency updates, no behavior change. Go 1.26 to 1.27.3 (including golangci-lint 2.15.0), Alpine 3.24.2, Node 24 to 26 and nginx-unprivileged 1.31.6 in the images, and the pending backend, frontend and desktop-terminal packages. Frontend majors: TypeScript 7, ESLint 10, eslint-plugin-react-hooks 7, eslint-plugin-react-refresh 0.5, msw 3, @testing-library/jest-dom 7 and @types/node 26. typescript-eslint does not support TypeScript 7 yet, so linting runs against the side-by-side TypeScript 6 package.

### Fixed

- Self-service password reset sent no email to accounts that had a login email but had never set a password (for example invited, SSO- or PIN-first accounts). Failed deliveries are now logged (challenge and request IDs only).
- Dropdowns in dialogs (for example Assign role) were cut off by the dialog and showed only one option at a time.
- Order drafts can be finalized again without taking payment; the total stays outstanding and can be paid later.

## [0.8.2] - 2026-10-21

### Upgrade notes

- No migrations. Core and connector can be updated in either order; the recovery below needs both at 0.8.2.

### Fixed

- Printer connector: a connector that lost its local data (for example a container recreated without its volume) numbered its events from 1 again, and Core silently rejected every one, so no runs were recorded while the live status looked normal. Core now answers a reused sequence with the next free one, and the connector renumbers its pending events from there and logs a warning. Both sides stay compatible with 0.8.1. A connector that is already stuck needs Core 0.8.2 and connector 0.8.2; events it quarantined before the update stay quarantined.

## [0.8.1] - 2026-10-21

### Upgrade notes

- No migrations. Update Core before the printer connector: a 0.8.1 connector reports spool tag UIDs in its live status, which a 0.8.0 Core rejects.
- The printer live status now contains the RFID/NFC tag UID of each loaded spool (still no addresses, serial numbers, camera or network identifiers).
- Inventory sections are now Materials, Parts, Spools and Types & categories. Links to the former Filament and Consumables tabs open Materials (Filament with the FDM printing process filter).

### Added

- **Detected spool tags.** When adding an NFC tag to a spool, or tags in Change filament, staff can pick a tag a printer currently reads in one of its slots instead of typing it; tags already on a spool are marked. The printer setup shows each slot's tag UID with a copy button. `GET /printers/detected-spool-tags` needs `machines.read` and `inventory.read`.
- **New filament while filling a spool.** Change filament and Register spool can create the filament article in place and fill the spool with it as a purchase, so stock and cost stay tracked.
- **Recalculate a job's price.** Jobs with an incomplete price, or whose rates changed, can be recalculated from the current rates of their pricing group (`machine_jobs.edit`); the price adjustment stays applied. A charge that is outdated on an order can be refreshed from the job page.
- **Price lookup.** Sales & payments has a read-only price lookup: a machine run of some hours, optionally with material, or an amount of an inventory article, priced for every active pricing group (`pricing.read`).
- **Deleting articles.** Filament, consumables and parts can be deleted while nothing uses them yet (`inventory.manage`). An article with ledger entries, spool fills, run usages or order items cannot be deleted; the dialog says what still uses it.

### Changed

- Filament and consumables share one Materials table, told apart by the Process filter. Material types and part categories are managed in the new Types & categories section, in one combined list, instead of a dialog in the overflow menu.

### Fixed

- The Spools section of a filament article no longer drops empty spools: a finished spool waiting for a refill is listed under the material of its last fill.
- Printer connector: when the connector missed the end of a print, the next print's task ID left the previous run running forever; the open run now ends with an unknown outcome ("superseded").

## [0.8.0] - 2026-10-21

### Upgrade notes

- Migrations 00056–00059 run automatically when the production stack starts (inventory articles, inventory items on orders, role staffing levels and open day requirements, split card receipts).
- The filament product catalog is folded into the inventory articles and removed; its manufacturer, product and package data move onto the articles.
- The role flag "supervisor dashboard" becomes the role's _open day staffing_ level. Roles that had the flag become supervisor-level roles; set the trainee level on your trainee role in the role editor, and choose the role that "Make supervisor" assigns under Settings › Open day requirements.
- The production Compose stack now runs on its own network with a fixed subnet (`MAKERSPACE_NETWORK_SUBNET`, default `172.30.240.0/24`) and trusts it as forwarding proxy by default, so rate limits and audit records see real client addresses. Keep the frontend port bound to loopback or firewalled; set `MAKERSPACE_NETWORK_SUBNET` only if the default collides with a network on the host.
- nginx now sends a Content-Security-Policy, HSTS and further security headers; an external proxy or CDN should pass them through.

### Added

- **Personal dashboard.** The landing page is about the signed-in person: next open day or shift with one info box, semester progress against the open-day minimum, coming-up open days and event shifts (open days can be left), all-time statistics (jobs and success rate, material printed in Benchys, machine time, favourite machine, open days and shifts staffed), recent jobs and orders, a jobs-per-month chart and the lab-rules status. Sections follow the person's permissions; guests see their lab-rules status and the next open days ([docs/staffing-and-dashboard.md](docs/staffing-and-dashboard.md)).
- **Open balance and paying your own orders.** The dashboard shows unpaid orders and own priced jobs that are not on an order yet, with the sum (also at €0.00). "Pay now" pays everything or a selection in one step: jobs go onto one new order, and every selected order is paid in full with cash, card or split, recorded under your own name. A card slip that covers several orders is stored as numbered receipts sharing the terminal reference.
- **Semester staffing.** Roles carry an open day staffing level (supervisor or trainee). Settings › Open day requirements holds the minimum open days per semester (default 2), the open days as trainee before someone counts as ready (default 3) and the role a promoted trainee gets. Being signed up is enough to reach the minimum; supervisor and trainee places both count; only empty supervisor places make an open day short-staffed.
- **Supervisor staffing page.** Four key figures (below minimum, lab rules not signed, ready for supervisor, no profile picture) filter the member table, which shows role and trainee progress, lab rules, open days this semester, status and last open day, with pagination. "Make supervisor" promotes a trainee by hand.
- **Inventory articles.** Inventory is organised by article kind: filament, consumables and parts, each with variant, manufacturer, sale price, package size, storage location and notes. "Receive stock" books purchases onto existing or new articles (and new spools), with suggestions from earlier entries; material types and categories are managed in one dialog.
- **Selling from stock.** Orders can contain inventory items ("From inventory…"). Finalizing an order books the stock out, reversing or replacing it books the stock back, and an order that would go below zero is refused with `insufficient_stock`.

### Security

- Login throttling can no longer lock everyone out: a full limiter table evicts the least recently active entry instead of refusing new clients, and every credential check also has a per-client limit.
- Password and PIN hashing runs outside database transactions with bounded concurrency, so parallel logins cannot exhaust memory or the connection pool.
- PIN attempts pass an atomic in-memory gate before the persistent back-off, and the persistent back-off starts over after 15 quiet minutes.
- Which API operations need a staff session is derived from the OpenAPI contract instead of hand-kept path lists; every API response defaults to `Cache-Control: no-store`; rate-limited responses carry the `Retry-After` of the limiter that fired.
- nginx sends a Content-Security-Policy without inline scripts and with `frame-ancestors 'none'`, HSTS, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` and `Cross-Origin-Opener-Policy`.
- Go 1.26.10, pgx 5.9.2 and x/net 0.60.0 close the vulnerabilities govulncheck reported as reachable; vulnerable transitive frontend packages are pinned to patched versions.
- GitHub Actions are pinned to commit SHAs; CI runs golangci-lint, govulncheck and `pnpm audit`, and Dependabot proposes weekly updates.

### Changed

- The code base follows a written style guide ([docs/styleguide.md](docs/styleguide.md)): golangci-lint and Prettier in CI, typed enums for domain states, shared helpers, all SQL in sqlc, large files split by topic. The design prototype, plan documents and the old review report were removed; open points are in [docs/known-limitations.md](docs/known-limitations.md).

### Fixed

- Several Carbon colour tokens had no value in the default theme (for example the text on selected read-only access buttons in the role editor was dark on the primary colour); styles now use Carbon's Sass tokens with fallbacks.
- Clearing a printer connector's events compared timestamps from two different clocks, so an event arriving right after clearing could stay hidden.

## [0.7.2] - 2026-10-20

### Fixed

- Open days: the calendar of the period and academic-break date ranges no longer snaps back to the start month or drops a picked date, so ranges spanning months can be picked with the mouse.
- The browser reported session activity on every click instead of at most once a minute, re-rendering the whole page each time.
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

[0.8.3]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Basmatireis/Makerspace-Core/releases/tag/v0.1.0
[0.0.1]: https://github.com/Basmatireis/Makerspace-Core/releases/tag/v0.0.1
