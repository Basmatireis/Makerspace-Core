# Machines & Jobs redesign — analysis, coverage and integration notes

Companion to `DESIGN.md` (structure + screen spec). Prototype: `cd frontend && pnpm dev` →
`http://localhost:5173/prototype.html` (dev-only; not part of `index.html` or the production build).

## 1. Current-state analysis

### Implemented today (verified in code)
- **Workshop overview** (`/machine-logbook`): attention list (needs review, jobs without order, failed this
  week, low stock) + machine list with administrative status.
- **Machines** (`/machine-logbook/machines`): table/cards, search, status filter, add/edit machine, machine
  types managed in a section below the table. Detail page with tabs *Overview* / *Printer configuration*
  (profile enable/disable, input units, slots, mount/unmount spool).
- **Jobs** (`/machine-logbook/jobs`): 10 always-visible filters, 9-column table, card view on mobile, manual
  job creation modal (facts + material usage). Job detail: tiles for timing, parties, usage, pricing (override /
  clear override with reason, snapshot rules), order association, outcome/notes.
- **Review** (`/machine-logbook/review`): split list/form to confirm automatically ingested jobs, anonymous
  counter sale link.
- **Print submissions**: list with state filter, create modal (printer, customer, title, filament
  declaration), detail with attempts (accept → printing → complete / fail / cancel), link job by typed job ID,
  reconcile consumption reports by typed job ID **and job version**, raw JSON event payloads.
- **Statistics**, **Inventory / spools**, **Settings › Machine logbook (pricing)**, **Printer connectors**
  (settings) — adjacent, out of scope here.

### Supported by the backend but not exposed in the UI
- **Editing a confirmed job** (`PATCH /machine-jobs/{id}`) and **replacing its material usage**
  (`PUT /machine-jobs/{id}/usages`). `CreateJobModal` already has `facts`/`usages` modes, but no screen opens
  them; a supervisor cannot correct a job after confirmation.
- `reprintsSubmissionId` on print submissions (always sent as `null`).
- Connector runtime state per machine (`PrinterConnectorAssignment.runtimeState/runtimeErrorCode`) and observed
  runs exist, but machine screens never show them; "statuses are administrative, not live telemetry".

### UX problems
| Problem | Where | Fix type |
|---|---|---|
| 10 filters always visible above the table; page header pushed below the fold | Jobs | Progressive disclosure (Filters popover + applied tags) |
| 9 table columns incl. material, duration, operator, source | Jobs | Layout: 5 columns, details on job page |
| Review is a separate page with a hand-styled list; confirming is disconnected from the job record | Review | Workflow: Jobs tab + guided modal, also reachable from job detail |
| User must type a machine-job **UUID** and **version number** to link/reconcile | Print submission detail | Workflow: job picker, version handled internally |
| Up to 5 equal-weight buttons per attempt; raw JSON payloads in code snippets | Print submission detail | Hierarchy: one next-step primary, overflow, events collapsed |
| Machine status is administrative only; "is it busy?" cannot be answered anywhere | Overview, Machines | Layout: derived availability from printing attempts + connector state |
| Machine types section under the machines table | Machines | Own tab (Machines › Machine types) instead of a hidden overflow action |
| Two separate concepts both called "job"-like (submissions vs jobs) with unclear naming | Nav | IA: prints and logbook jobs share one Jobs table |
| Duplicated table + card markup on every list | All lists | Layout: responsive table/ContainedList |
| No way to fix a confirmed job | Job detail | Workflow: expose existing edit endpoints |
| Status rendered with raw enum strings (`partial_failure`, `in_progress`) and colour only | Many | Status indicator pattern: labelled tag + icon |

## 4. Feature coverage

| Existing feature | New location |
|---|---|
| Workshop counts (jobs today/week) | Overview description line |
| Attention: needs review | Removed; replaced by Overview › Unlinked prints → Jobs › status *Unlinked print* |
| Attention: jobs without order + open amount | Jobs filter *Billing: not on order* (Overview row) |
| Attention: failed/partial this week | Jobs filter *Outcome* (Overview row) |
| Attention: low stock | Inventory (unchanged) — row kept on Overview in production |
| Machine list, search, status filter | Machines table (search, status dropdown, show retired toggle) |
| Machine runtime / jobs / failure rate / collection / last ingest | Machines table (jobs, failure rate) + expandable row; Machine › Overview |
| Add / edit machine | Machines primary action opens the setup wizard; Machine › overflow *Edit machine* opens it on one step |
| Machine types (add/edit/active) | Machines › *Machine types* tab (table, Add type, Rename, Activate/Deactivate) |
| Printer connectors (create, enroll, enable, revoke, diagnostics, assignments) | Machines › *Connectors* tab; assignment moved to the printer: Machine › Printer setup › *Connection* and the setup wizard (model, IP, serial, access code, test) |
| Setting up a printer (profile, input units, slots, external ids typed by hand) | Machine setup wizard (Machine · Connection · Spool inputs · Review): model template, units/slots edited directly and mapped to the slots the printer reports |
| Printer profile enable/disable, input units, slots, mount/unmount | Machine › *Printer setup* tab |
| Jobs list + all 10 filters | Jobs › All jobs (search + Filters popover with machine, customer, operator, material, outcome, source, billing, date range; review state = tab) |
| Manual job creation (facts + usage) | *New job* (Jobs, Overview, Machine, Print › *Create job*); a future end is a simulated run |
| Job detail facts, usage, pricing snapshot, override/clear, order association | Job detail (facts strip, usage table, Price & billing tile) |
| Review queue confirm (customer, operator, outcome, notes) | Print detail › *Create job* (customer, operator, outcome entered in the job form, prefilled from the print); no unconfirmed jobs remain |
| Anonymous counter sale from review | Dropped with the review queue (Orders › Counter sale is unchanged) |
| Print submissions list/filter/create | Automatic **prints** from printers appear as *Unlinked print* rows in Jobs; nobody creates them |
| Attempt lifecycle (accept, printing, complete, fail, cancel) | Read-only on Print detail (state, progress, times come from the printer); a manual run can be cancelled from Job detail |
| Link job to attempt | Print › *Link to job* (picker + comparison) or Job › *Link printer data*; linking replaces the manual run |
| Reconcile consumption report (accept/reject) | Reported material is applied when a print is linked (basis actual); no separate accept/reject step |
| Printer events | Print › *Printer events* accordion |
| Statistics, Inventory, Pricing settings | Unchanged |
| Spool `manufacturer` / `productName` free text | Kept as the snapshot of the chosen catalog product (Inventory › Products); empty `productId` for manual entries |
| **New exposure:** edit confirmed job facts/usage | Job detail *Edit job* / overflow *Edit material usage* |

## 5. Future improvements (proposals; items marked implemented are in the backend)
- **Maintenance log**: dated notes and reason when a machine enters/leaves maintenance (today the status has no
  enforced effect and no history).
- **Machine status message**: short operator-visible note ("Nozzle clogged, use #2").
- **Printer error history**: persist connector `runtimeErrorCode` changes per machine.
- **Automatic job creation from finished prints**: today a finished print waits until staff create a job from it or link it.
- **Dismiss an unlinked print** (e.g. test prints): create or link is the only exit in the prototype.
- **Slot observations applied to slots** (`slot_observation` events are stored but unused).
- Vendor connector adapters (the H2D and simulator adapters exist; other models only get the simulator).
- **Printer setup wizard needs backend support** (prototype only): a printer model on machines, `nozzle` on input units, `external_identifier` on slots, a "test connection" call returning the printer's reported units/trays (AMS `id`/tray `id`, external holders 254/255, colour, material, remain, RFID), and the last reported state per printer for the drift notice. Extruder 0 = Right nozzle, 1 = Left nozzle is to be validated against real printer data.
- **Filament product catalog** (**implemented**: `filament_products`, `/filament-products`, migration 00038; prototyped in Inventory › Products, spool registration and Change filament): needs a
  `filament_products` entity (manufacturer, name, material, net weight, default price, packaging `refill|spool`,
  notes, active), CRUD endpoints guarded by `inventory.manage` (reads by `inventory.read`), and a nullable
  `product_id` on spools and spool fills next to the existing `manufacturer` / `product_name` snapshot columns, so
  catalog edits never rewrite history. The product's material stays the single source for stock and job pricing.

## 6. Implementation notes (prototype → production)
1. **Routes/nav**: replace `/machine-logbook/review` and `/machine-logbook/print-submissions` with
   `/machine-logbook/jobs?status=unlinked` and `/machine-logbook/prints` (redirect to Jobs). Update `AppNavigation`
   Workshop items and `App.test.tsx` expectations.
2. **Data**: swap `useSimulatedQuery` for existing `queries.ts` options; mutations map 1:1 to generated client
   functions (`confirmMachineJob`, `updateMachineJob`, `replaceMachineJobUsages`, `overrideMachineJobPrice`,
   `createPrintAttempt`, `transitionPrintAttempt`, `linkPrintAttemptJob`, `reconcilePrinterEvent`, …) with
   `expectedVersion` taken from the loaded record.
3. **Machine availability** (implemented: `GET /machine-logbook/machine-activity`) needed per-machine "currently printing" data. Options without schema changes:
   list print submissions with `state=in_progress` (attempts embedded) and printer-connector assignments
   (requires `printer_connectors.read`). A small read-only endpoint/field (e.g. `currentAttempt` on Machine)
   would be cleaner — that is an API change and needs a separate decision.
4. **Overview attention counts** (implemented in `GET /machine-logbook/overview`) for follow-ups (unlinked finished attempts, pending reports) and incomplete
   prices are not in `GET /machine-logbook/overview` today; either extend that response or derive from lists.
5. **Billing state per job in lists** (implemented in `GET /machine-logbook/work-items`) required order association per job; today it is a separate
   per-job request. For the list column either add the order reference to the job list response or omit the
   billing tag in the table.
6. **Job picker for linking** uses `GET /machine-jobs?machineId=…` (already supported).
7. **Styles**: the prototype adds Carbon modules `contained-list`, `data-table/expandable`,
   `data-table/skeleton`, `skeleton-styles`, `toggletip`, `progress-bar` — add selectively to
   `src/styles/index.scss` only for components actually shipped, and re-run `pnpm build` (bundle budget).
8. **Tests**: port role-based gating to `MachineLogbookPages.test.tsx` / `ConfigurationAccess.test.tsx`
   (review, edit, override price, print management, printer slots), plus e2e for review and print workflows.

9. **Spool fills and spool deletion (implemented in migrations 00038/00039; original gap notes below)**: the backend has filament spools with identifiers, lifecycle and
   material spool-transfers, but **no fill history and no spool deletion**. The refill and cleanup workflows need
   (a) a *spool fill* entity and endpoint that closes the current fill (leftover outcome used up / returned to stock /
   disposed, with the correction, transfer or disposal ledger entries) and starts the next fill atomically, with the
   identifiers stored per fill, audited in the same database transaction; and (b) a hard-delete path for archived
   single-use spools that keeps ledger snapshots (spool display ID, fill number) so material history survives. This follows
   the repository rule to preserve genuine hard-deletion paths and to minimize retained audit data. Also needed:
   `kind` (reusable / single-use), optional `label` and `archivedAt` on spools, signed transfers (spool → loose stock)
   in the ledger, and an authorization decision for cleanup (`filament_spools.manage` is assumed in the prototype).

### Domain model change: automatic prints, manual runs, link and replace
**Status: implemented** (a-d below; see `docs/machine-logbook.md`). (a) running/cancel: derived status plus `POST /machine-jobs/{id}/run-cancellation`; (b) prints: observed runs extended in migration 00037, `/prints`; (c) `PUT`/`DELETE`/`POST /prints/{id}/job`; (d) `POST /machine-jobs/automatic` removed, legacy `needs_review` jobs are confirmed when an outcome is recorded. Original notes:
The prototype now follows this model: nobody creates prints; connectors create them; staff create a job when a
printer cannot report a print (manual run, simulated run while its end is in the future); a later automatic print
is linked to the job and replaces the manual run. Backend impact:
- **(a) Running state and cancel need no new fields.** "Running" is derived from `endsAt` in the future on a manual
  job; cancelling is `PATCH /machine-jobs/{id}` setting `endsAt` to now and `outcome` to `cancelled`; the price is
  recalculated by the existing pricing flow.
- **(b) Prints from printers without a submission need a backend change.** Today connectors update the attempts of a
  print submission and report observed runs; there is no first-class "print" created by a connector on its own. A
  print entity (or an equivalent read model over observed runs) with file name, state, progress, estimated end and
  reported usage is required.
- **(c) Link and replace has no endpoint.** Merging an automatic run into a manual job (replacing start, end and
  material usage, switching the run to automatic, repricing) needs a new operation that runs atomically in one
  transaction together with its audit event. Unlink needs the inverse.
- **(d) Removing the review queue changes the meaning of automatic ingest** (`POST /machine-jobs/automatic`): jobs
  would no longer be created unconfirmed from connector data. This needs a product decision before any backend work.



- **Price adjustments** (**implemented**: `PUT`/`DELETE /machine-jobs/{id}/price-adjustment`, migration 00036): previously the backend stores only a fixed `finalPrice` + reason (`PUT /machine-jobs/{id}/price-override`).
  Fixed price maps to that directly. Discount (%/€) and multiplier must stay relative when the calculated price is
  recalculated, so they need a stored adjustment kind + value (e.g. replace the override with
  `priceAdjustment {kind, value, reason}`), applied in the pricing service and audited like the override today.
- **Job name** (**implemented**: nullable `title`, migration 00036): machine jobs had no name field (only `notes`). Showing an optional job name needs a
  nullable `title` column on machine jobs, the field in the job create/update/read schemas in `api/openapi.yaml`,
  and regenerated clients. The print name is already the printer-reported value.

## 7. QA performed on the prototype
- `npx tsc -b`, `npx eslint . --max-warnings 0`: pass. `pnpm build`: pass, initial JS 202 kB / 225 kB gzip,
  CSS 72.8 kB / 80 kB; `dist/` contains no prototype code (production entry unchanged).
- `pnpm test`: 9 failures in production suites (App, Events, Machine logbook). The same files fail on a clean
  checkout of `HEAD` without the prototype, so they predate this work. One cause is visible: `App.test.tsx`
  expects the nav group "Machines & inventory", but `AppNavigation` labels it "Workshop".
- Browser walkthrough after the domain-model change (desktop): Jobs table with the new statuses, link a print to a
  manual running job with the replace comparison, cancel a manual run, job detail Run tile. Not re-run at 375 px or
  for the other role presets and data states since this change.
