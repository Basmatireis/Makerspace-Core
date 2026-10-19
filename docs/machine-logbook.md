# Machine logbook

The machine logbook records machine usage, material stock, pricing, charge-source traceability, and operational reporting for one makerspace. It is one backend feature package, **internal/machinelogbook**, so job confirmation, stock deduction, price capture, and audit events share a PostgreSQL transaction.

## Catalog and parties

Machine types and machines are versioned. A machine status is administrative only: **active**, **maintenance**, or **retired**. Availability is derived separately and never stored (see [Work items and machine activity](#work-items-and-machine-activity)). Printer connector state is shown separately. Referenced types and machines are retired instead of deleted.

### Processes

A machine type has a **process** (migration 00047 replaced the `printer` flag): `fdm_printing`, `embroidery`, `uv_printing`, `laser_cutting`, `vinyl_cutting` or `other`. The process decides what a run records, which materials fit and whether a printer setup exists. The migration maps `printer = true`, and every type that owns a machine with a printer profile, to `fdm_printing`, everything else to `other`.

| Process | Run measures | Typical material (unit) |
|---|---|---|
| `fdm_printing` | none | filament per material type (g), through spools |
| `embroidery` | `stitches` | stabilizer (m), thread optional |
| `uv_printing` | none | UV ink per colour (ml), DTF sticker paper (cm2), roll-to-film (m) |
| `laser_cutting` | none | sheet material (cm2), customer material is free text |
| `vinyl_cutting` | none | foil (cm2) |
| `other` | none | free |

Runtime is billable on every machine; a group that should not pay for time gets a 0 EUR/h rule. Only `fdm_printing` machines have a printer setup (printer profile, spool inputs, connector assignment): `PUT /machines/{id}/printer` and `PUT /machines/{id}/printer/setup` answer `409 machine_not_fdm_printing` for any other process. Everything FDM-specific (setup, wizard, connectors, spools, artifacts, live status, reported grams) is unchanged and gated on the process in the frontend as well. Changing a machine type's process is allowed; existing printer profiles and runs stay.

### Units

Material units are `g`, `m`, `ml`, `cm2`, `m2` and `piece` (`cm2` is new in 00047; `m2` stays for existing data). The frontend shows `cm2` as cm². Unit lists are validated in `machinelogbook.validUnit`, the OpenAPI `MaterialUnit` enum and the CHECK constraints of `material_types`, `materials`, `pricing_rules` and `machine_job_pricing_snapshot_rules`.

### Materials by process

`material_type_processes (material_type_id, process)` lists the processes a material type can be consumed on; new types need at least one (`POST /material-types` requires `processes`, `PUT` keeps them when omitted). The migration gives each existing type the process of every machine type its materials were consumed on, plus `fdm_printing` for gram types with a filament diameter, and `other` when there is no sign at all. For **new** makerspace usages (manual job, added run, usage replacement) the backend refuses material whose type does not include the machine's process: `422 material_process_mismatch`. Materials a run already uses stay allowed when its usage list is replaced, customer material (free text) is never checked, and recorded (connector) usages are not checked. The frontend picker lists only active materials of fitting types, plus the material of the row being edited.

### Run measures

`machine_run_measures (run_id, measure, value)` stores counted facts of a run; the only measure is `stitches` (exact whole number, `bigint`, at least 0). Runs and jobs expose `measures` (`{stitches?: integer}`; a job sums its runs that are not replaced). Manual run create/add (`measures` on the run input) and `PATCH /machine-runs/{id}` (manual runs; replaces the stored set when given) accept them; a measure the machine's process does not record answers `422 run_measure_unsupported`, an unknown or negative one `422 validation_failed`. Moving a job to a machine whose process cannot record its measures is refused the same way.

### Measure pricing

Pricing rule kind `machine_measure` prices a measure per machine type: `machineTypeId`, `measure`, the stored `blockSize` (1000 for stitches) and the rate per block, kept exactly (`numeric(20,6)`). The amount is `value x rate / blockSize` (multiplied first, so whole blocks are exact) and only the job total is rounded half-up to cents: 12,400 stitches at 0.50 per 1000 give 6.20. Rules are only accepted for machine types whose process records the measure, and one active rule per group, machine type and measure. A job's snapshot captures a `machine_measure` entry for every measure its machine's process records (rate, block size, unit `stitch`) plus any measure that already has a value. A value without a rate makes pricing **incomplete**; an explicit zero rate is free; a measure that first gets a value after the snapshot was taken (for example after a machine type changed its process) triggers a new snapshot of the same group.

### Printer setup

A printer profile holds the printing switch, an optional model (`bambu_h2d`, `bambu_x1c`, `prusa_core_one`, `generic`; the frontend keeps the unit and slot templates per model), spool input units and their slots. A unit may name the nozzle it feeds (`left` or `right`).

`PUT /machines/{machineId}/printer/setup` (`machines.manage`) saves all of it atomically. The body is the *desired state*, not a patch: `expectedVersion` (the profile version, `null` or `0` when the machine has no profile yet), `enabled`, `model` and the ordered `inputUnits`, each with its ordered `slots`. Entries with an `id` update the existing row, entries without one are created. In one transaction Core

- creates the profile when it is missing, otherwise requires `expectedVersion` to match (`409 stale_write` when it does not) and bumps the profile version;
- renumbers the active units and the active slots of each unit `0..n-1` in the given order;
- **retires** slots that are not listed (status `retired`, identifier cleared, moved behind the active ones) and **disables** units that are not listed (`enabled=false`, identifier cleared, their slots retired). Nothing is deleted, because mounts and print history reference these rows. A listed id that was retired or disabled earlier is revived;
- refuses to retire a slot with a mounted spool (`409 slot_occupied`) and rolls everything back;
- rejects two units, or two slots of one unit, with the same printer identifier up front (`422 duplicate_external_identifier`), rejects ids that do not belong to this machine (`422 validation_failed`), and returns `409 duplicate_external_identifier` should the unique index still fire;
- bumps the configuration revision of the connector assigned to the machine when `enabled` changes, because the printing switch is part of the connector configuration;
- writes one audit event `printer_profile.setup_saved` in the same transaction.

Requested slot statuses are `available` or `unavailable`; `retired` only results from omitting a slot. Unchanged rows keep their version. The existing single-row endpoints for units and slots keep working. `GET /machines/{machineId}/printer/live-status` (`machines.read`) returns the latest connector snapshot (see the [printer connector](printer-connector.md#live-status)).

Organizations are versioned billing parties with the type **company**, **institute**, **association**, or **other**. An identified job customer is either a Person or an Organization, represented by two mutually exclusive nullable foreign keys. Anonymous counter-sale jobs may omit both. Operators are People with enabled Accounts.

Organizations also carry an invoice address (address line, postal code, locality, ISO country code), an invoice contact name and an optional contact email; empty strings mean "not set". `PATCH /organizations/{id}` leaves omitted detail fields unchanged and clears a field when given an empty string. The purchase-order requirement stays in `organization_invoicing_requirements` (see [Orders](orders.md)) and is read and written through `/organizations/{id}/invoicing-requirements`; the organization page uses both endpoints. People can be associated with an organization (`organization_members`, unique per pair, removed with either side). Membership is informational: it never restricts who may bill an organization. It feeds the overview on the organization page and the job form, where choosing a person who belongs to exactly one active organization offers a one-click "Bill to <organization>" (the billing-party search returns `memberOrganizations` for people; nothing is switched automatically). Organizations are created, edited and assigned a pricing group on the **Directory › Organizations** pages (`/organizations`, `/organizations/:id`), not in Settings. Customer and operator searches return only identifiers and display names needed for assignment.

Person references use ON DELETE SET NULL. Hard-deleting a Person therefore removes their PII without deleting non-PII machine, timing, usage, price, or inventory facts. Jobs do not retain person-name snapshots. Organizations referenced by machine jobs (including deleted ones), orders or invoice requests are deactivated instead of deleted: `DELETE /organizations/{id}` (body `{expectedVersion}`, `organizations.manage`) answers 409 `organization_in_use` for them, because those foreign keys are ON DELETE SET NULL and would otherwise silently erase history. An unreferenced organization is hard-deleted together with its members, pricing group assignment and invoicing requirements (ON DELETE CASCADE) in one transaction with an `organization.deleted` audit event that carries no field values; a stale version answers 409 `stale_write`. The organization page offers this as a danger action with a confirmation dialog.

## Jobs and runs

A **job** is the billable record of work on one machine. Jobs have an application-generated UUIDv7 and a sequence-backed display identifier such as **J-2026-000001**; sequence gaps are expected. A job consists of one or more **runs**. A **run** is one period of work on the job's machine. It is either **manual** (entered by staff) or **recorded** (reported by a machine connector, such as a [printer connector](printer-connector.md)). Runs have display identifiers such as **R-2026-000001**. The model covers every machine type, including 3D printers, lasercutters, and embroidery machines. Former prints are recorded runs; prints no longer exist as a separate concept. Times are stored as UTC timestamptz.

**Name.** A job has an optional title (at most 200 characters). The display name is the title, else the job number. The J-number stays the stable identifier.

**Billing facts.** A job keeps its customer, operator, title, notes, pricing, and price adjustment. Start, end, and runtime are derived from the job's runs; runtime is the sum of the runs' runtimes. Material usage belongs to runs.

**Status and outcome.** A job is **running** while any of its runs runs: a manual run until its planned end, a recorded run as the connector reports it. Otherwise the job's outcome is derived from its runs' outcomes. If all runs are successful, cancelled, or failed, the job takes that outcome; a mix gives **partial_failure**; while a run has no outcome, the job is **unknown**. Staff can set an outcome override, which takes precedence. Outcomes do not decide whether material consumption is retained.

**Runs and material.** Staff add further runs with **Add run**, for example for reprints. Material usage is a set of typed material/quantity rows on a run. Supported units are **g**, **m**, **ml**, **m2**, and **piece**. Filament usage records makerspace or external ownership, optional physical Spool attribution, and an actual or estimated quantity basis. External filament does not consume stock or add a makerspace material charge. The module deliberately does not provide a generic metric/EAV store.

**Recorded runs.** A recorded run may stay unassigned to any job. Staff create a job from a recorded run, or attach it to an existing job on the same machine, also while it is still running. Attaching can replace the job's manual runs: they are kept as "replaced" for history, and their material is reversed. Detaching a run keeps the run's material with it. If it was the job's last run, the job gets a manual copy without material.

**Machine-reported material.** When a recorded run ends, its machine-reported material is consumed automatically, also without a job, and shown as "From machine". A later report revision replaces it without double counting. The outcome is set from the machine's final state ("From machine") until staff change it. Connector-driven changes reprice the job and are audited with the system actor, with the connector ID in the audit metadata. Running jobs cannot be added to orders. Machine-reported consumption uses the ledger kind `machine_run_consumption`; the schema change is migration 00041.

**Concurrency.** Operations lock the job before its runs. A rare conflict returns 409 `retry_conflict`, and the client retries.

Anonymous creation is permitted only through the Orders counter-sale transaction, which always creates a new manual job and must fully settle an immediately fulfilled cash/card charge. Pricing is captured, every material is consumed, and audit events are written in the same transaction.

Confirmed corrections use optimistic concurrency. Source and external identifiers remain immutable. Usage replacement creates compensating inventory transactions; immutable ledger history is never rewritten. A finalized Order does not lock operational job corrections: its immutable item snapshot remains unchanged and the UI/API reports source changes. Omitted customer on a factual correction preserves the current identity, including an anonymous job.

Legacy job billing fields and the billing endpoint were removed with migration 00028. The charge flow is **Machine Job → Order Item → Order → Payment or external wiRef invoicing**. [Orders](orders.md) describes frozen charge snapshots, full reversal/replacement, and atomic anonymous checkout.

## Pricing snapshots## Pricing snapshots

Pricing groups are independent of Roles. Resolution order is:

1. the explicit group on the create or reassignment request;
2. the billing party's default group;
3. the one active global default.

If none resolves, manual creation fails until a group is selected. A group contains exact-decimal machine-runtime rules per machine type/hour, measure rules per machine type (see [Measure pricing](#measure-pricing)) and material rules per **material type** (a rate per unit of the type; the rule keeps the type's unit). A job's pricing snapshot stores each material rule with its label, the type name as selector, the unit and a `material_type_id`; usages match snapshot rules by type, so renaming or recolouring never changes a captured price. Snapshots taken before migration 00046 keep their category text and were backfilled with the matching type. Missing matched rules make pricing **incomplete** and leave the calculated total unset. An explicit zero rate is intentionally free.

Every confirmed job receives an immutable snapshot revision containing the group name, EUR currency, capture time, matched rate and unit, missing-rule markers, and source rule IDs for traceability. Customer or machine-type correction creates a new revision and retains older revisions. Timing and usage corrections recalculate against the active snapshot. The exact component sum is rounded half-up to cents only at the final total.

The calculated amount and the price adjustment are separate. An adjustment (`PUT`/`DELETE /machine-jobs/{id}/price-adjustment`, migration 00036 replaced the former fixed override) has a kind, value, reason, actor, and time and never alters the calculation. Kinds: **fixed** (EUR), **discount_percent** (0-100], **discount_amount** (EUR), and **multiplier** (factor up to 100). Relative kinds are re-applied whenever the calculated price changes, for example after a run or usage correction or a connector-driven change. The **effective price** (stored, rounded half-up to cents) is the adjusted amount when an adjustment exists and otherwise the calculated amount. Adjustments need `machine_jobs.override_price`.

## Inventory and valuation

Materials are versioned catalog records with a **material type**, unit, optional colour (name and `#RRGGBB` code), active state, and optional low-stock threshold.

**Material types** (`/material-types`, migration 00046) are the level a price attaches to: PLA, PETG, TPU 95A and so on. A type has a name (unique ignoring case), a unit (`g`, `m`, `ml`, `cm2`, `m2`, `piece`), the processes it can be consumed on, an active flag and a version. Reads need `inventory.read`, writes `inventory.manage`; every write is audited in its transaction. A material's unit always equals its type's unit: the service refuses a different explicit unit (422 `material_unit_mismatch`) and composite foreign keys on materials and pricing rules enforce it in the database. A type's unit can change only while no material or pricing rule uses it (409 `material_type_unit_in_use`). Deleting is a hard delete that only works for an unused type; otherwise it answers 409 `material_type_in_use` and the type should be deactivated, which keeps existing materials and rules but refuses new ones.

**Colour** is captured only on the material: `colorName` (free text, up to 80 characters) and `colorHex` (`^#[0-9A-F]{6}$`, upper case). Spools, jobs and runs only display it. Colours from print files ("Detected in file") and from the printer's AMS ("Reported by printer") are detected values used for comparison only; the printer setup shows a hint when a mounted spool's material colour is clearly different (RGB distance above 80) from the reported tray colour, and the material form can take the reported colour with one click.

**Migration 00046.** Every distinct legacy (category, unit) of a material or material pricing rule becomes one type. A category of up to four characters is upper-cased ("pla" becomes "PLA"), longer ones use initcap ("filament" becomes "Filament"); a category used with several units gets the unit appended ("Sheet (m2)"). The old colour text becomes the colour name, the colour code stays empty and can be added later. Rates are unchanged. `materials.category` and `materials.color` and `pricing_rules.material_category` are dropped; the down migration restores category from the type name (lower case, without a unit suffix) and the colour from the colour name.

Order snapshots keep the JSON key `category` for a usage's material; it now carries the material type name. **inventory_transactions** is an immutable ledger with purchase, machine-job consumption, manual consumption, adjustment, and disposal entries. The material balance is maintained transactionally with quantity, inventory value, weighted-average unit cost, and an inventory version.

Gram-denominated filament Materials may define a diameter and contain physical Spools. Spool balances are derived from the same ledger through attributed transactions and zero-value transfers, while the Material exposes assigned and unassigned quantities. See [Filament spools and generic printer integration](filament-printing.md) for spools, fills, kinds, changing filament, and cleanup, and the product catalog.

Every balance mutation locks material rows in UUID order, checks **expectedInventoryVersion**, prevents negative stock, writes its ledger row, updates the balance, and writes audit data in the same transaction. Multi-material job consumption is all-or-nothing.

Purchases add their total acquisition price and recalculate weighted-average cost. Outgoing consumption and disposal record the current average cost. Positive corrections use the current average; when none exists, the correction requires an acquisition unit cost. Marking a material empty writes one negative adjustment for the locked current quantity. No correction edits historical transactions.

## Authorization and audit

The module registers:

- **machines.read**, **machines.manage**
- **machine_jobs.read**, **machine_jobs.create**, **machine_jobs.edit**, **machine_jobs.override_price** (price adjustments)
- **inventory.read**, **inventory.manage**
- **filament_spools.manage**, **printer_slots.assign**
- **organizations.read**, **organizations.manage** (read covers the organization, its address and contact, and its people list; manage covers create, update, delete and member changes)
- **pricing.read**, **pricing.manage**
- **statistics.read**

Frontend gates are presentation only. Services authorize every operation, including the minimal party/operator lookups used for create and Order payer selection. Minimal lookups also accept `orders.read`.

Catalog, organization (including member add/remove; audit names only the changed fields, never the member or address values), pricing, job, run attach/detach/create, reassignment, correction, price adjustment, purchase, consumption, adjustment, disposal, and mark-empty mutations write an audit event in the same transaction. Audit metadata contains changed field names and non-sensitive identifiers only. It does not duplicate names, free-text notes, search text, external metadata, or override reasons.

## Work items and machine activity

Work item lists carry a `consumption` summary per item (material summed per material type and unit, plus measures); the frontend writes it in each unit ("12,400 stitches · 0.4 m Stabilizer", "3.20 ml UV ink · 180 cm² DTF paper"). FDM runs and jobs that only used grams keep their per-material text.


`GET /machine-logbook/work-items` lists every job plus every recorded run not assigned to a job in one paginated table (`machine_jobs.read`). The unified status is **running**, **unassigned** (an ended recorded run without a job), **needs_outcome** (outcome still unknown), or the recorded outcome. The `run` filter separates **manual** from **recorded** items. Filters cover search, status, machine, material, billing state (jobs only), customer, operator, and a start-time range where `to` is exclusive. Billing states are on_order, order_outdated, not_on_order, price_incomplete, and pending.

`GET /machine-logbook/machine-activity` returns one entry per machine with derived availability, the current running job or running run, connector state, and the last job start. `current` is included only for callers with `machine_jobs.read`.

`GET /machine-logbook/overview` returns the existing counts plus running now (running jobs and running unassigned recorded runs), machine names, needs outcome, `unassignedRuns`, billing issues (incomplete pricing or outdated order), and up to six active items. The fields that expose jobs are null without `machine_jobs.read`.

`GET /machine-logbook/statistics` takes `from` and `to` dates, with `to` exclusive. It returns totals and `previousTotals` for the period of equal length ending the day before `from`, per-month charges, material cost and losses, runtime buckets (weekly up to 92 days, otherwise monthly), material usage and cost by material type (`materialUsageByType`, `materialCostByType`), and per-machine figures. Material cost is the inventory value consumed by jobs and manual consumption net of job corrections; losses are the inventory value removed by disposals and by negative stock corrections other than job corrections. Runtime of a running job counts until now.

## API and UI

The OpenAPI resource groups are:

- **/machine-types**, **/machines**
- **/organizations** (list with `search`, `active`, `kind`, `pricingGroupId` filters; `GET`/`PATCH`/`DELETE /organizations/{id}`; `GET`/`POST /organizations/{id}/members`; `DELETE /organizations/{id}/members/{personId}`), **/billing-parties**, **/machine-job-operators**
- **/pricing-groups**, **/pricing-rules**, **/billing-party-pricing-group**
- **/machine-jobs** with run creation (`POST /machine-jobs/{id}/runs`), price-adjustment, confirm, and Order-association subresources
- **/machine-runs** with list, detail, patch, delete, usages, cancellation, and job attach, detach, and create subresources
- **/material-types** (list, create, get, update, delete)
- **/materials** and purchase, consumption, correction, transaction, spool-transfer, and mark-empty subresources
- **/filament-spools** (fills, finish, cleanup) and **/filament-products**
- **/machine-logbook/overview**, **/machine-logbook/work-items**, **/machine-logbook/machine-activity**, **/machine-logbook/statistics**

The Carbon navigation is **Overview · Jobs · Machines · Inventory · Statistics**, plus a Settings configuration page. Job detail, material detail, and spool detail are sub-pages of Jobs and Inventory.  Former spool and printer URLs redirect into Inventory and Machines. Lists use URL-backed filters and bounded pagination. Charts have textual table equivalents.

## Verification

Backend coverage includes authorization for every permission, exact pricing and rounding, snapshot revision/immutability, job status and outcome derivation from runs, run attach/detach/create and replacement, machine-reported consumption on run end, price adjustment kinds and re-application, work-item and activity permissions, atomic confirmation and stock deduction, failed/cancelled consumption, weighted-average valuation, all manual inventory actions, stale and concurrent balance writes, deterministic locking, audit rollback, Person deletion, list filters, statistics, and CSRF/HTTP behavior.

Frontend tests cover permission-aware navigation, redirects of removed routes, filters and multi-usage display, job and run workflows, inventory confirmation, and accessible status/error behavior. Playwright visits every machine-logbook page with accessibility and browser-error checks at desktop and narrow widths. The real PostgreSQL vertical slice creates catalog, stock, party, pricing, job, print link, price adjustment, correction, and reporting data. `make test-integration` runs against the dedicated `makerspace_test` database, and `make seed-dev` adds repeatable demo data; see [development](development.md).

## Deleting jobs and runs

Deleting a job or a recorded run needs `machine_jobs.delete`; removing a manual run also works with `machine_jobs.edit` (migration 00044). Deletion is a tombstone (`deleted_at`, `deleted_by` on `machine_jobs` and `machine_runs`) because the inventory ledger is immutable and a connector would otherwise recreate a deleted recorded run with its next event. Display IDs are never reused. Deleted rows are excluded from lists, details (404), work items, overview, machine activity and metrics, statistics, the `machine_job_run_summaries` view, ledger job links and connector artifact targets. A deleted run is detached from its job (`job_id` is NULL).

- `DELETE /machine-jobs/{id}` with `{expectedVersion, reverseConsumption, deleteRecordedRuns}` returns 204. Manual runs are always deleted; recorded runs are deleted or detached into unassigned runs. A job with an order claim or an active order item answers 409 `job_on_order`.
- `DELETE /machine-runs/{id}` with `{expectedVersion, reverseConsumption}` deletes a run of any source and always returns 204 (clients refetch the job). The only remaining run of a job answers 409 `last_run`. A running recorded run may be deleted.
- `reverseConsumption` posts, per usage with net consumption in the ledger, a positive `adjustment` entry with reason `job_corrected` linked to the same run usage, at the consumption's unit cost: into the spool fill while it is still open, otherwise into loose stock (the note says so). The usages are deactivated. Without it the ledger and usages stay untouched. Statistics count these entries like other usage corrections.
- Locks follow job, then runs. Audit events `machine_job.deleted` and `machine_run.deleted` commit with the mutation; audit metadata only allows UUIDs, so the choices are recorded as changed fields (`usages`, `inventory`, `recordedRunsDeleted`, `recordedRunsDetached`).
- Connector events for a deleted recorded run are stored (idempotency) with application state `recorded` and reason `run_deleted`; they never change or resurrect the run and book no consumption.
