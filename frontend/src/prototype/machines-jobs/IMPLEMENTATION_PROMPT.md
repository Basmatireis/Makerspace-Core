# Prompt: implement the Machines & Jobs redesign in Makerspace Core

> Copy everything below the line into a new Claude Code session (model: Opus 5.5) started in the repository root.

---

You are implementing the approved **Machines & Jobs redesign** of Makerspace Core end to end: database, backend, OpenAPI contract, generated clients and the production frontend. A frontend-only prototype of the target UI exists and has been approved by the product owner. Your job is to make the real application behave and look **as close to that prototype as possible**, backed by real persistence and enforced authorization.

## 0. Ground rules

- Follow `AGENTS.md` in the repository root exactly (modular monolith, handlers/services/repositories split, OpenAPI as source of truth, generated files never edited by hand, pgx + sqlc, goose migrations, UUIDv7 in application code, UTC `timestamptz`, mutation and audit event in one transaction, permission-based authorization with backend enforcement, privacy rules, Carbon as the only design system, TanStack Query / React Hook Form, frontend performance budgets, tests for every authorization-sensitive behaviour).
- **Orchestration:** activate the installed `smart-model-router` skill first and follow it for the whole task. You (Opus) own planning, schema and API design, security-sensitive decisions, integration and final review. Delegate per the skill: `Explore` for codebase mapping, `sonnet-worker` for well-scoped vertical slices with disjoint file ownership, `haiku-worker` for mechanical work (running `make generate`, test runs, renames, docs), `sonnet-verifier` after every phase, `opus-expert` only for isolated hard problems. Keep authorization, migrations, deletion paths, pricing and the OpenAPI contract under your direct supervision and read those diffs yourself. Report routing at the end.
- **Design system:** use the configured **IBM Carbon MCP** (`docs_search`, `code_search`; React, Carbon v11) to verify every component, prop and pattern before using it (DataTable toolbar/batch/filter patterns, ContentSwitcher, MenuButton, ProgressIndicator, ProgressBar, ComposedModal, Popover, ContainedList, ClickableTile, Tag, filtering and status-indicator patterns). Do not invent components. Do not add Carbon Labs or `@carbon/ibm-products`.
- Work on a new branch (e.g. `feat/machines-jobs-redesign`). Do not commit, push or open a PR unless the user asks; propose a commit at the end of each phase instead.
- Do not delete existing data or drop tables/endpoints without explicit confirmation from the user (see §3 open decisions).
- Before writing code, produce a short written plan (schema changes, API changes, frontend slices, test plan, open questions) and wait for the user's go-ahead on the open decisions.

## 1. Read first (sources of truth)

1. `frontend/src/prototype/machines-jobs/DESIGN.md` — approved screen spec: IA, domain model, outcome rule, naming rule, table pattern, every screen and dialog. **This is the target.**
2. `frontend/src/prototype/machines-jobs/REDESIGN.md` — current-state analysis, feature-coverage mapping (nothing may be lost), future improvements, and **implementation notes listing every backend gap**.
3. The prototype source in `frontend/src/prototype/machines-jobs/` (entry `frontend/prototype.html`, run with `cd frontend && pnpm dev` → `http://localhost:5173/prototype.html`; the beaker icon switches role presets and loading/error/empty states). Use it as the visual and behavioural reference: `types.ts` (target domain shape), `store.tsx` (business rules as simulated: linking/replacing runs, cancel run, outcome, price adjustment, stock movements, fills, cleanup), `derived.tsx` (status derivation, display names, price adjustment math), `fillPlan.ts` (ledger planning for refills), pages/dialogs/components (UI). If the prototype directory is missing, stop and ask the user for it.
4. Current production implementation: `frontend/src/features/machinelogbook/**`, `frontend/src/features/printer-connectors/**`, `frontend/src/app/{App,AppNavigation,PageShell,PageHeader,DetailSection,PageState,DestructiveActionDialog,DateInput,charting}.tsx|ts`, `frontend/src/styles/index.scss`, `frontend/src/features/users/UsersPage.tsx` (the Directory table every list must match).
5. Backend: `api/openapi.yaml`, `backend/internal/{machinelogbook,printing,printerconnector,printerconnectors,orders,authorization,audit}/**`, `backend/migrations/` (latest is `00035_…`), `backend/sqlc.yaml`, `backend/oapi-codegen.yaml`, `Makefile` targets.

## 2. Target product behaviour (summary — details in DESIGN.md)

**Navigation (Workshop):** Overview · Jobs · Machines · Inventory · Statistics. The separate Review and Print submissions pages disappear (redirect old routes).

**Overview:** fits one laptop viewport; header "New job"; four clickable key-figure tiles (Running now, Needs outcome, Unlinked prints, Billing issues → pre-filtered Jobs); "Active jobs" list (running, printing, needs outcome, unlinked) and a one-line-per-machine "Machines" list with availability and connector issues.

**Jobs (one unified table, Directory style):** each row is either a machine job or an **unlinked print** reported by a printer. Statuses: Running, Printing (unlinked), Unlinked print, Needs outcome, Successful, Partial failure, Failed, Cancelled. Toolbar: expandable search, filter toggle with inline filter panel (status, machine, run manual/printer, customer, operator, material, billing state, date range, clear filters), primary "New job"; sortable columns; pagination footer; filters in the URL.

**Job model changes:**
- Job defined by **start + runtime** (UI); backend still stores `starts_at`/`ends_at`.
- **Optional job name** (`title`); display name = title → linked print's readable file name → job number. Prints keep the printer-reported name (read-only).
- **Running / simulated run:** a manual job whose end lies in the future is "Running" until then; **Cancel run** ends it now, sets outcome Cancelled and reprices.
- **Outcome rule:** no outcome is asked while the end is in the future (stored as `unknown`); a finished job without outcome shows **Needs outcome** with an inline "Record the outcome" prompt; linking a finished printer print sets the outcome from the print state.
- **Prints from printers:** connected printers create prints automatically (no manual print creation, no print queue). An unlinked print can **Create job** (prefilled machine, start, runtime, material, name from file) or **Link to job**; linking to a job with a manual run shows a comparison and **replaces** the manual start/runtime/material with the printer data, recalculating the price. Job detail offers "Link printer data". Unlink returns the job to a manual run.
- **Price adjustment** replaces the plain override: Fixed price, Discount (%), Discount (€) or Multiplier, always with a reason; relative kinds re-apply whenever the calculated price changes; price tile shows Calculated → adjustment → Final.
- Review queue / "needs review" concept is replaced by unlinked prints + Needs outcome (see open decision D2).

**Machines:** Directory-style table (search, filters Status incl. retired-only-when-selected, Type, Collection, Connector; "Manage machine types" toolbar menu; "Add machine"); machine detail with tabs Overview · Jobs · Printer setup and derived availability (In use from running job or printing print, Available, Maintenance, Retired) plus connector issue.

**Inventory:** tabs Materials · Spools · Products, all Directory-style.
- Materials show total stock split into **on spools / loose**; material detail with ledger, spools and products; actions Add stock, consumption, correction, disposal, mark empty, edit.
- **Spools** are physical holders: `reusable` or `single_use`, optional label. The current **fill** (material, product, weight, remaining, identifiers) plus **fill history**. **Change filament** wizard (Spool → Leftover → New filament → Tags): leftover = system value / weighed (gross − tare, difference as correction) / used up, then return to loose stock or dispose; new filament from loose stock (transfer, total unchanged) or new purchase; keep/replace identifiers (NFC tags change with every Bambu refill), old tags stay in fill history. **Finish spool** closes a fill; single-use spools are then archived (and unmounted). **Clean up archived spools** hard-deletes archived single-use spools older than N months while ledger entries and job usages keep spool display id / fill number snapshots ("SP-0155 (deleted)").
- **Product catalog:** manufacturer, name, material, net weight, default price, packaging Refill/Spool, notes, active. Register spool / Change filament pick a product (fills material, weight, price; packaging sets spool type) or "Not in catalog" manual entry. Spools/fills store product id plus snapshot text.

**Statistics:** period ContentSwitcher (30 days / 6 months / 12 months / custom), five key figures with change vs. previous equal-length period, charts behind the existing lazy charting boundary: charges vs. material cost (monthly line), **machine runtime over weeks/months per selected machines** (MultiSelect, default top 3, selection in URL), material cost by category, losses; per-machine Directory table.

## 3. Open decisions — ask the user before implementing the affected phase

- **D1 Operator permissions:** linking prints, unlinking, cancelling runs and recording outcomes currently require `machine_jobs.edit`. Keep, or allow operators (new permission, e.g. `machine_jobs.run`)?
- **D2 Automatic ingest and review queue:** today `POST /machine-jobs/automatic` and connectors create `needs_review` jobs. Target: printers create **prints**; jobs are created/linked by staff. Decide migration of existing `needs_review` jobs (convert to unlinked prints, keep as jobs with Needs outcome, or leave) and the future of the ingest endpoint.
- **D3 Print submissions:** UI is removed. Keep tables/endpoints read-only for history, migrate attempts/observed runs into the new print model, or remove later? Never drop without confirmation.
- **D4 Prints data model:** build the print entity on existing `printer_observed_runs` / printer events / print attempts, or a new `machine_prints` table fed by the connector event pipeline. Propose one with trade-offs.
- **D5 Simulated run end:** when a manual run reaches its end, outcome stays `unknown` (Needs outcome) — confirm no background job flips it automatically (recommended: derive from time, no scheduler).
- **D6 Spool cleanup policy:** age options (1/3/6/12 months), manual only (recommended) vs. scheduled.
- **D7 Prototype removal:** delete `frontend/src/prototype/` and `frontend/prototype.html` at the end, or keep as reference?

## 4. Backend and database work (derive exact shapes from the prototype `types.ts` and REDESIGN.md §6)

Design each as goose migration(s) with working Down, sqlc queries, service logic with authorization + audit in one transaction, OpenAPI changes, regenerated Go/TS bindings, and integration tests against real PostgreSQL.

1. **Machine jobs:** nullable `title`; allow `ends_at` in the future for manual jobs and `outcome = unknown` until the end (verify current validation); atomic **cancel run** operation (end now, outcome cancelled, reprice, audit); **record outcome** (only after end); derived status fields or query support for Running / Needs outcome.
2. **Price adjustment:** replace `final_price` + reason with `price_adjustment_kind` (`fixed | discount_percent | discount_amount | multiplier`), `price_adjustment_value`, reason, set/cleared metadata; migrate existing overrides to `fixed`; apply in the pricing service on every recalculation; keep `effectivePrice` semantics for orders (charges remain immutable snapshots — keep the existing "changed after charge" handling); permission `machine_jobs.override_price`.
3. **Prints from printers (D4):** print entity with machine, connector, vendor job id / file name, state (printing/finished/failed/cancelled), started/ended/estimated end, progress, reported usage, events, linked job id; list endpoint with filters; **link with replace** (atomic: set job run to automatic, copy times + reported usage via compensating inventory transactions, set outcome from print state when unknown, reprice, audit) and **unlink**; create-job-from-print (create + link in one transaction).
4. **Unified jobs list:** server-side endpoint returning jobs + unlinked prints with the unified status, filters (status, machine, run, customer, operator, material, billing, date range, search), sorting and pagination (UNION query via sqlc); include billing state (order association) so the list does not need N per-row requests.
5. **Overview and machine availability:** extend `GET /machine-logbook/overview` with running / needs-outcome / unlinked / billing-issue counts and per-machine current item (running job or printing print) + connector runtime state, or add fields to the machine list; respect permissions per section.
6. **Inventory:** spools `kind`, `label`; **fills** table (fill number, material, product, initial/remaining weight, filled/closed at, leftover amount + outcome) with identifiers per fill; atomic close-fill/start-fill operation that writes correction/transfer/disposal/purchase ledger entries; finish spool (archive + unmount for single-use); ledger snapshot columns (`spool_display_id`, `fill_number`) and signed transfer direction; **hard-delete archived single-use spools** older than a cutoff (keep snapshots, minimize retained data, audit the deletion); loose vs on-spool stock in material responses; identifier uniqueness across active fills.
7. **Product catalog:** `filament_products` (manufacturer, name, material, net weight, default price, packaging, notes, active) with CRUD under `inventory.manage`; nullable `product_id` on spools/fills plus snapshot text.
8. **Statistics:** extend `GET /machine-logbook/statistics` with previous-period totals, runtime time series per machine with week/month buckets (by period length), material cost by category, losses, per-machine table data.
9. **Authorization tests** for every new/changed operation and every role-dependent field (including D1 outcome), plus last-master/sensitive-field rules untouched.

## 5. Frontend work

- Implement in `frontend/src/features/machinelogbook/` (and `app/AppNavigation.tsx`, `app/App.tsx` routes with redirects from `/machine-logbook/review` and `/machine-logbook/print-submissions*`). Port prototype screens component by component; replace `useSimulatedQuery`/store actions with TanStack Query options in `queries.ts` and generated client mutations with `expectedVersion`.
- Reuse/introduce one shared Directory-style table component (prototype `components/DirectoryTable.tsx` + `.mj-table-container`/`.mj-filter-panel` CSS) and use it for every list, matching `UsersPage.tsx`.
- Preserve route-level code splitting; Carbon Charts only behind `app/charting.ts` lazy boundary; add only the `@carbon/styles` modules actually used (prototype added `contained-list`, `content-switcher`, `data-table/expandable`, `data-table/skeleton`, `skeleton-styles`, `toggletip`, `progress-bar` — include only what ships). Keep initial JS ≤ 225 kB gzip and entry CSS ≤ 80 kB gzip (`pnpm build` runs the budget check).
- Frontend permission gating is UX only; mirror backend permissions. No private data in browser storage.
- Update existing tests (`MachineLogbookPages.test.tsx`, `MachineCatalog.test.tsx`, `ConfigurationAccess.test.tsx`, `App.test.tsx`, `AppNavigation.test.tsx`) and add tests for new flows and role gating; extend Playwright e2e for: new job with future end → running → cancel; unlinked print → create job / link & replace; record outcome; price adjustment; change filament wizard; finish + cleanup; product catalog; statistics machine selection.
- Note: `App.test.tsx` currently expects a nav group "Machines & inventory" while the app renders "Workshop" (pre-existing failure, plus some Events/MachineLogbook tests fail on `main`). Fix the navigation test as part of this work; report other pre-existing failures without masking them.

## 6. Suggested phases (each ends with sonnet-verifier review, all checks green, user checkpoint)

1. **Plan & decisions:** Explore mapping, written plan, answers to D1–D7.
2. **Contract & schema:** migrations + OpenAPI + sqlc + regenerated bindings for jobs (title, outcome/run, price adjustment) — backend services + integration tests.
3. **Prints & linking (D2–D4)** backend + tests.
4. **Unified jobs list, overview, statistics** backend + tests.
5. **Inventory: fills, cleanup, catalog** backend + tests.
6. **Frontend shell, shared table, Jobs + Job detail + Print detail + Overview.**
7. **Frontend Machines, Inventory (materials/spools/products/wizards), Statistics.**
8. **Hardening:** e2e, accessibility (axe in Playwright), 375 px and desktop walkthrough in the browser, bundle budget, docs (`docs/`, CHANGELOG), prototype removal per D7.

## 7. Verification (must pass before you call a phase done)

```
make generate && make check-generated
make test-migrations
make test-integration
make check-backend
make check-frontend      # lint, typecheck, unit tests, production build + bundle budget
cd frontend && pnpm test:e2e
```

Also run the app (`make dev`) and walk every changed screen in the browser at desktop and 375 px width, in each role preset, including loading, error and empty states. Report results faithfully: list anything not verified and any pre-existing failures separately.

## 8. Final deliverable

A short report: what changed (schema, API, backend, frontend), decisions taken (D1–D7), feature-coverage check against REDESIGN.md §4 (nothing lost), verification results, known gaps/follow-ups, and the routing table (agent → model → task → status).
