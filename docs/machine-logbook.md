# Machine logbook

The machine logbook records machine usage, material stock, pricing, charge-source traceability, and operational reporting for one makerspace. It is one backend feature package, **internal/machinelogbook**, so job confirmation, stock deduction, price capture, and audit events share a PostgreSQL transaction.

## Catalog and parties

Machine types and machines are versioned. A machine status is administrative only: **active**, **maintenance**, or **retired**. Availability is derived separately and never stored (see [Work items and machine activity](#work-items-and-machine-activity)). Printer connector state is shown separately. Referenced types and machines are retired instead of deleted.

Organizations are versioned billing parties with the type **company**, **institute**, **association**, or **other**. An identified job customer is either a Person or an Organization, represented by two mutually exclusive nullable foreign keys. Anonymous automatic review jobs and atomic immediate counter-sale jobs may omit both. Operators are People with enabled Accounts. Customer and operator searches return only identifiers and display names needed for assignment.

Person references use ON DELETE SET NULL. Hard-deleting a Person therefore removes their PII without deleting non-PII machine, timing, usage, price, or inventory facts. Jobs do not retain person-name snapshots. Referenced Organizations are deactivated instead of deleted.

## Jobs

Jobs have an application-generated UUIDv7 and a sequence-backed display identifier such as **J-2026-000001**; sequence gaps are expected. Times are stored as UTC timestamptz. Sources are **manual** and **automatic**; outcomes are **successful**, **partial_failure**, **failed**, **cancelled**, and **unknown**. Outcome does not decide whether material consumption is retained.

**Name.** A job has an optional title (at most 200 characters). The display name is the title, else the linked print's file name made readable (`gearbox_housing_v3.gcode` becomes "Gearbox housing v3"), else the job number. The J-number stays the stable identifier. Prints keep the printer-reported file name read-only.

**Run and status.** A job is a start plus a runtime (the end is start plus runtime). The status is derived at read time and there is no scheduler: **running** while the end lies in the future and the run was not cancelled, **needs_outcome** once the run has ended and the outcome is still **unknown**, otherwise the recorded outcome. **Outcome guard:** a concrete outcome cannot be recorded before the run has ended (422 `outcome_before_run_end`). **Cancel run** (`POST /machine-jobs/{id}/run-cancellation`) ends a running run now, records **cancelled**, and recalculates the price.

Material usage is a set of typed material/quantity rows. Supported units are **g**, **m**, **ml**, **m2**, and **piece**. Filament usage also records makerspace/external ownership, optional physical Spool attribution, and actual/estimated quantity basis. External filament does not consume stock or add a makerspace material charge. Runtime is derived from the job interval. The module deliberately does not provide a generic metric/EAV store.

Job creation requires a machine, customer, enabled-account operator, interval, outcome, and valid usages, and is confirmed atomically. Anonymous creation is permitted only through the Orders counter-sale transaction, which must fully settle an immediately fulfilled cash/card charge. Pricing is captured, every material is consumed, and audit events are written in the same transaction.

**Automatic ingest removed.** `POST /machine-jobs/automatic` and the review UI no longer exist; connector data creates [prints](#prints), not jobs. Staff create a job from a print or link a print to a job. Print submissions, print attempts, printer-event reconciliation, and the review queue were removed; every job is a normal job.

Confirmed corrections use optimistic concurrency. Source and external identifiers remain immutable. Usage replacement creates compensating inventory transactions; immutable ledger history is never rewritten. A finalized Order does not lock operational job corrections: its immutable item snapshot remains unchanged and the UI/API reports source changes. Omitted customer on a factual correction preserves the current identity, including an anonymous job.

Legacy job billing fields and the billing endpoint were removed with migration 00028. The charge flow is **Machine Job → Order Item → Order → Payment or external wiRef invoicing**. [Orders](orders.md) describes frozen charge snapshots, full reversal/replacement, and atomic anonymous checkout.

## Prints

A print is a physical printer run reported by a [printer connector](printer-connector.md) (an observed run, with display ID such as **PR-2026-000001**). It carries the file name, start and end, progress, estimated end, state, and the filament usage the printer reported. Nobody creates prints in the UI. Staff create a job when a printer cannot report a run (a manual run); a later print is linked to that job.

- **Link and replace** (`PUT /prints/{id}/job`): atomically sets the job's start and end to the print's, replaces the material usage with the reported usage when the report names a resolvable spool (compensating inventory transactions), records the outcome from the print state when the job has none, and recalculates the price. The job's run becomes automatic. Only ended prints can be linked; a print that is still printing cannot be linked yet (409).
- **Unlink** (`DELETE /prints/{id}/job`) is the inverse and keeps the job's current facts.
- **Create job from print** (`POST /prints/{id}/job`) takes machine, start, and end from the print and prefills the title from the file name. An omitted outcome follows the print state.

Link, unlink, and create write their audit event in the same transaction. Permissions: reading prints needs `machine_jobs.read`; link and unlink need `machine_jobs.edit`; create-job-from-print needs `machine_jobs.create`.

Print submissions and attempts no longer exist (see [Filament spools and generic printer integration](filament-printing.md)).

## Pricing snapshots

Pricing groups are independent of Roles. Resolution order is:

1. the explicit group on the create or reassignment request;
2. the billing party's default group;
3. the one active global default.

If none resolves, manual creation fails until a group is selected. A group contains exact-decimal machine-runtime rules per machine type/hour and material rules per normalized category/material unit. Missing matched rules make pricing **incomplete** and leave the calculated total unset. An explicit zero rate is intentionally free.

Every confirmed job receives an immutable snapshot revision containing the group name, EUR currency, capture time, matched rate and unit, missing-rule markers, and source rule IDs for traceability. Customer or machine-type correction creates a new revision and retains older revisions. Timing and usage corrections recalculate against the active snapshot. The exact component sum is rounded half-up to cents only at the final total.

The calculated amount and the price adjustment are separate. An adjustment (`PUT`/`DELETE /machine-jobs/{id}/price-adjustment`, migration 00036 replaced the former fixed override) has a kind, value, reason, actor, and time and never alters the calculation. Kinds: **fixed** (EUR), **discount_percent** (0-100], **discount_amount** (EUR), and **multiplier** (factor up to 100). Relative kinds are re-applied whenever the calculated price changes, for example after a timing or usage correction, cancel run, or print link. The **effective price** (stored, rounded half-up to cents) is the adjusted amount when an adjustment exists and otherwise the calculated amount. Adjustments need `machine_jobs.override_price`.

## Inventory and valuation

Materials are versioned catalog records with a normalized category, unit, optional color, active state, and optional low-stock threshold. **inventory_transactions** is an immutable ledger with purchase, machine-job consumption, manual consumption, adjustment, and disposal entries. The material balance is maintained transactionally with quantity, inventory value, weighted-average unit cost, and an inventory version.

Gram-denominated filament Materials may define a diameter and contain physical Spools. Spool balances are derived from the same ledger through attributed transactions and zero-value transfers, while the Material exposes assigned and unassigned quantities. See [Filament spools and generic printer integration](filament-printing.md) for spools, fills, kinds, changing filament, and cleanup, and the product catalog.

Every balance mutation locks material rows in UUID order, checks **expectedInventoryVersion**, prevents negative stock, writes its ledger row, updates the balance, and writes audit data in the same transaction. Multi-material job consumption is all-or-nothing.

Purchases add their total acquisition price and recalculate weighted-average cost. Outgoing consumption and disposal record the current average cost. Positive corrections use the current average; when none exists, the correction requires an acquisition unit cost. Marking a material empty writes one negative adjustment for the locked current quantity. No correction edits historical transactions.

## Authorization and audit

The module registers:

- **machines.read**, **machines.manage**
- **machine_jobs.read**, **machine_jobs.create**, **machine_jobs.edit**, **machine_jobs.override_price** (price adjustments)
- **inventory.read**, **inventory.manage**
- **filament_spools.manage**, **printer_slots.assign**
- **organizations.read**, **organizations.manage**
- **pricing.read**, **pricing.manage**
- **statistics.read**

Frontend gates are presentation only. Services authorize every operation, including the minimal party/operator lookups used for create and Order payer selection. Minimal lookups also accept `orders.read`.

Catalog, organization, pricing, job/cancel/link/unlink/reassignment/correction, price adjustment, purchase, consumption, adjustment, disposal, and mark-empty mutations write an audit event in the same transaction. Audit metadata contains changed field names and non-sensitive identifiers only. It does not duplicate names, free-text notes, search text, external metadata, or override reasons.

## Work items and machine activity

`GET /machine-logbook/work-items` lists every job plus every print not linked to a job in one paginated table (`machine_jobs.read`). The unified status is **running**, **printing** (unlinked print still running), **unlinked** (ended print without a job), **needs_outcome**, or the recorded outcome. The `run` filter separates **manual** from **printer** items (a job with a linked print, or an unlinked print). Filters cover search, status, machine, material, billing state (jobs only), customer, operator, and a start-time range where `to` is exclusive. Billing states are on_order, order_outdated, not_on_order, price_incomplete, and pending.

`GET /machine-logbook/machine-activity` returns one entry per machine with derived availability, the current running job or printing print, connector state, and the last job start. `current` is included only for callers with `machine_jobs.read`.

`GET /machine-logbook/overview` returns the existing counts plus running now (running jobs and printing unlinked prints), machine names, needs outcome, unlinked prints, billing issues (incomplete pricing or outdated order), and up to six active items. The fields that expose jobs are null without `machine_jobs.read`.

`GET /machine-logbook/statistics` takes `from` and `to` dates, with `to` exclusive. It returns totals and `previousTotals` for the period of equal length ending the day before `from`, per-month charges, material cost and losses, runtime buckets (weekly up to 92 days, otherwise monthly), material cost by category, and per-machine figures. Material cost is the inventory value consumed by jobs and manual consumption net of job corrections; losses are the inventory value removed by disposals and by negative stock corrections other than job corrections. Runtime of a running job counts until now.

## API and UI

The OpenAPI resource groups are:

- **/machine-types**, **/machines**
- **/organizations**, **/billing-parties**, **/machine-job-operators**
- **/pricing-groups**, **/pricing-rules**, **/billing-party-pricing-group**
- **/machine-jobs** with usage, run-cancellation, price-adjustment, confirm, and Order-association subresources
- **/prints** and its job subresource
- **/materials** and purchase, consumption, correction, transaction, spool-transfer, and mark-empty subresources
- **/filament-spools** (fills, finish, cleanup) and **/filament-products**
- **/machine-logbook/overview**, **/machine-logbook/work-items**, **/machine-logbook/machine-activity**, **/machine-logbook/statistics**

The Carbon navigation is **Overview · Jobs · Machines · Inventory · Statistics**, plus a Settings configuration page. Job detail, material detail, and spool detail are sub-pages of Jobs and Inventory.  Former spool and printer URLs redirect into Inventory and Machines. Lists use URL-backed filters and bounded pagination. Charts have textual table equivalents.

## Verification

Backend coverage includes authorization for every permission, exact pricing and rounding, snapshot revision/immutability, run status derivation and the outcome guard, cancel run, price adjustment kinds and re-application, print link/unlink/create-job, work-item and activity permissions, atomic confirmation and stock deduction, failed/cancelled consumption, weighted-average valuation, all manual inventory actions, stale and concurrent balance writes, deterministic locking, audit rollback, Person deletion, list filters, statistics, and CSRF/HTTP behavior.

Frontend tests cover permission-aware navigation, redirects of removed routes, filters and multi-usage display, job and print workflows, inventory confirmation, and accessible status/error behavior. Playwright visits every machine-logbook page with accessibility and browser-error checks at desktop and narrow widths. The real PostgreSQL vertical slice creates catalog, stock, party, pricing, job, print link, price adjustment, correction, and reporting data. `make test-integration` runs against the dedicated `makerspace_test` database, and `make seed-dev` fills an empty development database with demo data; see [development](development.md).
