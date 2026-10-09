# Orders, payments, and external invoicing

Makerspace-Core records internal charges. It does not issue legally binding invoices. wiRef issues invoices through the external accounting process.

```text
Machine Job / manual service → immutable Order Item → Order
                                                    ├→ cash/card Payment + allocations
                                                    └→ wiRef request → externally issued invoice
                                                                       → externally confirmed Payment
```

## Domain and lifecycle

The `internal/orders` feature owns charge, settlement, and external-invoicing services and sqlc persistence. It calls the Machine Logbook's concrete transaction-aware job methods for anonymous checkout. HTTP transport types, domain types, and generated persistence rows remain separate.

An Order has a UUIDv7, a stable sequence-backed reference (`O-2026-000001`), EUR currency, an optional Person/Organization payer, immediate/deferred fulfillment, and optimistic version. References use the UTC year and a global sequence; gaps, including rolled-back previews, are expected. The payer may differ from the Machine Job customer and operator.

Lifecycle is `draft → finalized → reversed` or `draft → cancelled`. Settlement is derived from charges, full-reversal adjustments, and signed immutable allocations: `unpaid`, `partially_paid`, `paid`, or `no_payment_due` for zero net charges (including reversed records). Draft items may be added, removed, refreshed, or replaced by new item rows. Removed rows remain visible to the API as history. Finalized payloads, item snapshots, payments, and financial evidence cannot be rewritten.

Manual items contain a description, positive quantity, unit, nonnegative unit price, and rounded line amount. Quantity and unit price have up to six decimal places; money has two. Go uses exact decimal arithmetic, PostgreSQL uses numeric, and the API uses decimal strings. Each manual line is rounded half-up to cents before summing Order totals.

Job items preserve machine/type labels, UTC interval and exact duration, outcome, typed material usages, pricing group/rate evidence, calculated/override/effective amounts, override reason/time, and capture time. The snapshot has an explicit schema version and excludes customer/operator names, operational notes, external ingest metadata, addresses, and contact information. Source links are nullable. Job claims prevent simultaneous active charges; replacement drafts may provisionally reuse their original Order's jobs. Finalization rejects a source version that changed after capture until the draft snapshot is refreshed.

Operational Machine Job corrections remain available after Order finalization, including compensating stock corrections. Order detail and Job detail show changed-source state. Correcting the financial charge requires explicit full reversal/replacement; it never recalculates the original Order silently.

## Replacement and payment allocation

V1 supports whole-Order reversal and linked replacement, and whole-payment reversals. It does not implement item-level credits, partial refunds, wallets, account credit, or overpayment. Creating a replacement copies active manual items and captures current source-job facts. Edit that draft, then commit through the original Order. One original has at most one committed successor; subsequent corrections replace the successor.

Replacement locks both Orders in UUID order and atomically releases original settlement, appends a full charge adjustment and its item evidence, releases job claims, finalizes the replacement, transfers remaining cash/card allocations, and records any explicitly supplied payment reversals/new receipts. Both versions must match. Transferring an allocation creates negative/positive immutable allocation entries with one operation identifier. It leaves the original Payment and cash/card journal totals unchanged.

If remaining receipts exceed the new charge, the operation fails. Explicitly reverse whole receipts and, where necessary, record a new receipt in the same replacement operation. No credit balance is created. Standalone reversal of an anonymous Order's payment must include a replacement receipt that preserves full settlement, or staff must reverse the whole Order instead.

Payments have stable `P-2026-000001` references suitable for writing into the physical cashbook. Cash, card, and externally confirmed settlement are distinct. Named Orders allow partial and multiple receipts; mixed cash/card is supported. Card receipts require a terminal/provider and unique confirmed transaction reference. Immutable reversals distinguish actual refunds, recording errors, and external accounting corrections. Recording-error reversals use the original effective occurrence time; an actual refund records its occurrence time. The digital journal reports recorded activity, not the complete physical cash balance. Its date bounds are inclusive `from`, exclusive `to` in UTC; method filters affect entries while totals show all methods in that period.

Commands use caller-generated UUIDv7 `operationKey`s. The service serializes retry keys before checking versions and persists only the fingerprint, actor, operation kind, and result identifiers. Reusing the same key/body/actor returns the existing result; different input returns `409 idempotency_conflict`. Authorization is checked again on retries. Cash/card reference uniqueness also protects against recording an already recorded terminal transaction with another key. Browser retry keys live only in memory; after navigation/reload reconcile against Payments and the terminal reference before recording again. No private query data is persisted in browser storage.

## Anonymous immediate sales

No fake Anonymous Person is created. Ordinary manual-job creation/review confirmation still requires an identified customer. Automatic `needs_review` jobs may omit customer/operator assignments. The `/counter-sales` command is the anonymous exception: new manual job or review confirmation, pricing capture, inventory consumption, Order/item creation, finalization, complete cash/card settlement, and audit events share one PostgreSQL transaction. A deferred/later-pickup sale or any remaining debt is rejected. Operator identity remains independently required.

Pricing resolves from an explicit selected group or the active global default. Anonymous identity does not supply an arbitrary price. Missing pricing prevents completion. `/counter-sales/preview` computes the exact charge through the same transaction-aware path and always rolls back its temporary rows, inventory changes, and audit data. The UI requires a current preview before recording payment; completion recalculates and verifies full settlement.

A terminal payment is an external fact. PostgreSQL rollback cannot undo it. If recording fails after successful terminal payment, retry the same operation and reference without charging again. If facts or price changed, reconcile the terminal transaction explicitly; never assume a database failure refunded it. Anonymous checkout APIs support multiple cash/card receipts atomically; the dedicated counter-sale form records one full receipt, while identified Orders can record subsequent receipts separately.

## wiRef workflow

A separate ExternalInvoiceRequest has a `W-2026-000001` reference and `draft → ready → submitted → issued` states. Draft/ready requests may be cancelled locally. Submitted/issued requests require `cancellation_requested → cancelled` with external correction evidence. Issued means wiRef issued the invoice; it does not mean paid. An external Payment is recorded only after separate confirmation with a reference.

Starting a request requires a finalized identified Order without allocated payments. An active request blocks internal cash/card receipts. A cancelled request may have a linked successor. The header captures the Order reference/amount, and separately stored recipient details capture service period/description, address, organization contact, bounded invoicing requirements, and an immutable item summary. Recipient details remain editable until ready, then freeze. Ordinary cash/card Orders require none of these fields.

Ready validation requires recipient name, billing address, country, complete ordered service period, and description. Organization recipients additionally require a contact name. `organization_invoicing_requirements.require_purchase_order_reference` controls the purchase-order requirement; no organization-name special case exists. Current configuration is checked and captured at ready time. The UI exposes this configuration to staff with organization read/manage and Order read permissions.

External issue/reference corrections and cancellation/reconciliation facts append immutable events. Accepted procedures are cancellation, credit note, corrected invoice, reallocation, or other external accounting procedures, each with evidence/reference and effective date. Before Order reversal/replacement, cancel/reconcile the active request and explicitly correct any external payment. Externally controlled payments are never transferred internally to a replacement. Core does not send requests to wiRef, issue documents, or implement external accounting; staff perform those actions through their normal process and record the facts here.

## Integrity, privacy, and permissions

Migrations `00027`–`00029` add the domain, remove disposable legacy `machine_jobs.billing_status`/`billing_reference`, and enforce deferred financial constraints. There is no migrated legacy billed/waived history. Database checks enforce distinct payer references, immutable payloads, unique active job claims/requests/receipts/replacements, fully allocated or fully reversed receipts, bounded settlement, full charge reversal, and anonymous completion. Deferred checks allow intermediate states inside an atomic checkout/correction but reject invalid commits. Nullable historical references may detach to NULL, never be reassigned on immutable records.

Financial mutations and minimal audit events commit together. Audit metadata contains identifiers/changed-field names, not copied names, addresses, contact channels, reasons, or service descriptions. Operations store no request/response bodies. Errors expose the stable application envelope rather than SQL diagnostics.

Permissions are `orders.read/write/finalize/reverse`, `payments.read/record/reverse`, and `external_invoice_requests.read/manage`. Mutations require relevant read permission as well as the action permission; replacement also requires finalization and payment read/record, and supplied reversals require payment reverse. Creating/confirming counter-sale jobs additionally requires the ordinary job create/review permission. Organization requirements use `organizations.manage`. All are registered grants; no business role names authorize operations. Order readers see minimal active-request identifiers/state, but recipient/address details require external-request read permission.

Person/Account deletion detaches financial references without deleting Orders, Payments, allocations, adjustments, or external requests. Minimal Order customer-name snapshots and wiRef recipient snapshots remain separate retained data; deleting a Person does not erase those financial snapshots automatically. Owned child rows may cascade when their aggregate is deliberately purged; cross-aggregate financial references use SET NULL. There are no new financial deletion endpoints or retention scheduler.

Before implementing GDPR retention, define approved retention periods/legal bases independently for technical jobs, charge records, receipts, billing snapshots, audit, and idempotency evidence. Design coordinated snapshot erasure/anonymization and aggregate purges, preserved references/evidence, and actor attribution. Existing inventory consumption rows require a live usage link: a future job/usage purge must reconcile that constraint with its SET NULL foreign key. Jobs can retain technical facts while customer/operator links detach today. Test the resulting cleanup transactions against immutability/deferred constraints and populated downgrade protection. Do not treat the current immutable snapshots as permanently exempt from erasure.

## Verification

Run `make generate`, `make check-generated`, `make check-backend`, `make check-frontend`, `make test-integration`, `make test-migrations`, and `make test-e2e`. PostgreSQL tests use isolated schemas and cover authorization separation, exact decimals, optimistic/concurrent mutation, immutable snapshots, source corrections, stock compensation, anonymous preview/completion rollback, Person deletion/source detachment, whole-receipt correction, carry-forward without money movement, wiRef requirements/evidence, and audit rollback. Frontend and full-stack browser tests cover accessible forms, permission-aware navigation, retries, counter-sale review, replacement, wiRef lifecycle, narrow layouts, and browser errors. Keep the initial recursively loaded production JavaScript and entry CSS within repository budgets; all financial pages are route-lazy.
