# Machine logbook

The machine logbook records machine usage, material stock, pricing, billing state, and operational reporting for one makerspace. It is one backend feature package, **internal/machinelogbook**, so job confirmation, stock deduction, price capture, and audit events share a PostgreSQL transaction.

## Catalog and parties

Machine types and machines are versioned. A machine status is administrative only: **active**, **maintenance**, or **retired**. The application does not infer or display live running, idle, or offline state. Automatic collection configuration and the last successful ingest time are shown separately. Referenced types and machines are retired instead of deleted.

Organizations are versioned billing parties with the type **company**, **institute**, **association**, or **other**. A job customer is either a Person or an Organization, represented by two nullable foreign keys and an exclusive-or service invariant. Operators are People with enabled Accounts. Customer and operator searches return only identifiers and display names needed for assignment.

Person references use ON DELETE SET NULL. Hard-deleting a Person therefore removes their PII without deleting non-PII machine, timing, usage, price, or inventory facts. Jobs do not retain person-name snapshots. Referenced Organizations are deactivated instead of deleted.

## Jobs and review

Jobs have an application-generated UUIDv7 and a sequence-backed display identifier such as **J-2026-000001**; sequence gaps are expected. Times are stored as UTC timestamptz. Sources are **manual** and **automatic**; outcomes are **successful**, **partial_failure**, **failed**, **cancelled**, and **unknown**. Outcome does not decide whether material consumption is retained.

Material usage is a set of typed material/quantity rows. Supported units are **g**, **m**, **ml**, **m2**, and **piece**. Runtime is derived from the job interval. The module deliberately does not provide a generic metric/EAV store.

A manual job requires a machine, customer, enabled-account operator, interval, outcome, and valid usages and is confirmed atomically. Automatic ingestion creates a **needs_review** job and proposed usages without touching inventory. Confirmation supplies the missing assignments and outcome, captures pricing, consumes every material, confirms the job, and writes audit events in one transaction.

Automatic ingestion requires an authenticated user session, CSRF, and **machine_jobs.create**; a managed-device token may narrow an existing grant but never authenticates a collector by itself. The machine/external-job pair is unique. Repeating a semantically identical JSON payload returns the existing job, while conflicting facts return **409 external_job_mismatch**. A future unattended collector must use a deliberately designed device/service identity rather than weakening this endpoint.

Confirmed corrections use optimistic concurrency. Source and external identifiers remain immutable. Usage replacement creates compensating inventory transactions; immutable ledger history is never rewritten. A billed job rejects factual, usage, customer, and price changes until explicitly returned to **unbilled**.

Billing states are **unbilled**, **billed**, and **waived**. Billed requires an external reference. Waiving a job records a zero final override and a reason atomically.

## Pricing snapshots

Pricing groups are independent of Roles. Resolution order is:

1. the explicit group on the create, review, or reassignment request;
2. the billing party's default group;
3. the one active global default.

If none resolves, manual creation or review fails until a group is selected. A group contains exact-decimal machine-runtime rules per machine type/hour and material rules per normalized category/material unit. Missing matched rules make pricing **incomplete** and leave the calculated total unset. An explicit zero rate is intentionally free.

Every confirmed job receives an immutable snapshot revision containing the group name, EUR currency, capture time, matched rate and unit, missing-rule markers, and source rule IDs for traceability. Customer or machine-type correction creates a new revision and retains older revisions. Timing and usage corrections recalculate against the active snapshot. The exact component sum is rounded half-up to cents only at the final total.

The calculated amount and final override are separate. An override records amount, reason, actor, and time without altering the calculation. The effective amount is the override when present and otherwise the calculated amount.

## Inventory and valuation

Materials are versioned catalog records with a normalized category, unit, optional color, active state, and optional low-stock threshold. **inventory_transactions** is an immutable ledger with purchase, machine-job consumption, manual consumption, adjustment, and disposal entries. The material balance is maintained transactionally with quantity, inventory value, weighted-average unit cost, and an inventory version.

Every balance mutation locks material rows in UUID order, checks **expectedInventoryVersion**, prevents negative stock, writes its ledger row, updates the balance, and writes audit data in the same transaction. Multi-material job consumption is all-or-nothing.

Purchases add their total acquisition price and recalculate weighted-average cost. Outgoing consumption and disposal record the current average cost. Positive corrections use the current average; when none exists, the correction requires an acquisition unit cost. Marking a material empty writes one negative adjustment for the locked current quantity. No correction edits historical transactions.

## Authorization and audit

The module registers:

- **machines.read**, **machines.manage**
- **machine_jobs.read**, **machine_jobs.create**, **machine_jobs.edit**, **machine_jobs.review**, **machine_jobs.override_price**
- **inventory.read**, **inventory.manage**
- **organizations.read**, **organizations.manage**
- **pricing.read**, **pricing.manage**
- **statistics.read**

Frontend gates are presentation only. Services authorize every operation, including the minimal party/operator lookups used for create and review.

Catalog, organization, pricing, job/review/reassignment/correction, billing/override, purchase, consumption, adjustment, disposal, and mark-empty mutations write an audit event in the same transaction. Audit metadata contains changed field names and non-sensitive identifiers only. It does not duplicate names, free-text notes, search text, external metadata, or override reasons.

## API and UI

The OpenAPI resource groups are:

- **/machine-types**, **/machines**
- **/organizations**, **/billing-parties**, **/machine-job-operators**
- **/pricing-groups**, **/pricing-rules**, **/billing-party-pricing-group**
- **/machine-jobs**, **/machine-jobs/automatic**, review, usage, price, and billing subresources
- **/materials** and purchase, consumption, correction, transaction, and mark-empty subresources
- **/machine-logbook/overview**, **/machine-logbook/statistics**

The Carbon UI provides Overview, Jobs, Job detail, Review, Inventory, Material detail, Machines, Statistics, and a Settings configuration page. Lists use URL-backed filters and bounded pagination. Charts have textual table equivalents. The review queue supports keyboard-accessible customer/operator selection, validation, confirm-and-advance, and stale/insufficient-stock recovery.

## Verification

Backend coverage includes authorization for every permission, exact pricing and rounding, snapshot revision/immutability, ingestion idempotency, atomic review and stock deduction, failed/cancelled consumption, weighted-average valuation, all manual inventory actions, stale and concurrent balance writes, deterministic locking, audit rollback, Person deletion, list filters, statistics, and CSRF/HTTP behavior.

Frontend tests cover permission-aware navigation, filters and multi-usage display, review validation/advance/conflict states, inventory confirmation, and accessible status/error behavior. Playwright visits every machine-logbook page with accessibility and browser-error checks and verifies the responsive review layout. The real PostgreSQL vertical slice creates catalog, stock, party, pricing, ingestion, confirmation, pricing/override, correction, and reporting data.
