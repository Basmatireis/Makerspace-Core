# Orders, payments, and external invoicing

Makerspace-Core records internal charges. It does not issue legally binding invoices. wiRef issues invoices through the external accounting process.

```text
Machine Job / manual service → immutable Order Item → Order
                                                    ├→ cash/card Payment + allocations
                                                    └→ wiRef request → approval → forwarded to wiRef (issued)
                                                                       → settling external Payment
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

## Counter sales

There are no counter sales. Every Machine Job has a customer (Person or Organization) and every sale goes through an ordinary Order. The `/counter-sales` endpoints were removed; Orders that were created that way remain ordinary finalized Orders (the `anonymous` customer kind and its database checks stay for them). A terminal payment is an external fact. PostgreSQL rollback cannot undo it. If recording fails after a successful terminal payment, retry the same operation and reference without charging again; never assume a database failure refunded it.

## wiRef workflow

A separate ExternalInvoiceRequest has a `W-2026-000001` reference and the states `draft → submitted → issued`, plus `issued → cancellation_requested → cancelled`. `submitted` is shown as "Awaiting approval"; `issued` means "approved and forwarded to wiRef". The former `ready` state is gone.

- **Draft** (`external_invoice_requests.manage`): staff create the request for a finalized, named-customer Order that charges something, edit the recipient and service details, and **submit** it once the readiness checklist is complete (recipient name, billing address, country, ordered service period, description; organizations additionally a contact name and, when `organization_invoicing_requirements.require_purchase_order_reference` says so, a purchase order reference; the configuration is captured at submission). Staff may cancel a draft.
- **Awaiting approval** (`external_invoice_requests.approve`): only approvers edit the details (every save is audited), **return it for correction** (a comment is required and stored as a `returned` request event with its author, so the draft can show it), cancel it locally, or **mark it forwarded to wiRef**. Forwarding re-checks the checklist.
- **Issued**: the wiRef invoice number is optional. Forwarding may carry it; otherwise add it later with `reference-corrections` (event `reference_added`). A later change is a correction and needs a reason (`reference_corrected`).
- **Cancellation** of an issued request needs external evidence: `request-cancellation`, then `confirm-cancellation` with reconciliation kind, reference and date.

An invoice can be requested whatever the payment status. The request records `alreadyPaid`, the cash and card received for the Order; it follows the Order's cash/card payments and refunds while the request is a draft and is frozen from submission on. From `submitted` on (including `issued` and `cancellation_requested`) new cash/card payments and cash/card reversals on that Order are refused with `409 invoice_amount_frozen`; returning the request to the draft or cancelling it allows them again.

**Issued means paid.** In the same transaction as the forward transition, a payment of method `external` ("Invoice (wiRef)", source `wiRef`, reference = the request reference) is recorded and allocated to the Order for its open balance, so the Order is settled. If cash/card already covered the whole Order, no payment is created. Manually recording an `external` payment is refused with `409 invoice_settles_balance`; there is no bank-transfer recording. The settling payment is created on the strength of `external_invoice_requests.approve`.

Confirming the external cancellation reverses the settling payment (a reversal with reason kind `external_correction`, carrying the confirmation reference and date) in the same transaction and reopens the balance. Because that returns money, it additionally requires `payments.read` and `payments.reverse` when such a payment exists. Before Order reversal/replacement, cancel the request this way. Externally controlled payments are never transferred internally to a replacement. Core does not send requests to wiRef or issue documents; staff perform those actions through their normal process and record the facts here.

Recipient details are stored separately from the request header and stay editable while the request is a draft or awaiting approval (the item summary and `alreadyPaid` never change after submission); they freeze when it is issued. The UI exposes the purchase order configuration on the organization page (Directory › Organizations). Organization address and contact are stored on the organization (see [Machine logbook](machine-logbook.md)) and prefill the recipient details.

## Cash register and cash movements

The expected cash in the register counts **cash only**: cash receipts minus cash refunds and corrections, minus withdrawals, plus deposits, all recorded up to (excluding) the `to` instant of `GET /payments/cash-register`. Card and external (wiRef) payments, and their reversals, never change it.

Cash movements (`GET/POST /cash-movements`) are immutable withdrawals and deposits with amount, reason (`bank_deposit`, `safe`, `float`, `other`; `other` needs a note), note, occurrence time (not in the future), a `C-2026-000001` reference and the recording Person. Corrections are new movements. A withdrawal cannot exceed what the register should hold at its own time and now (`409 insufficient_cash`); writers are serialized with an advisory lock so retries (caller `operationKey`) and the limit see a stable register. Reading needs `cash_movements.read`; recording needs `cash_movements.record` plus read; the register figures need `payments.read` and `cash_movements.read`.

## Actor display names

Orders expose `createdBy`, payments `recordedBy`, cash movements `recordedBy` and request events `recordedBy` as `{id, displayName}` (the Person id and "first last"). Nothing else about the person is exposed. The value is null once the person is deleted.

## Integrity, privacy, and permissions

Migrations `00027`–`00029` add the domain (`00048` the approval states and `already_paid`, `00049` cash movements), remove disposable legacy `machine_jobs.billing_status`/`billing_reference`, and enforce deferred financial constraints. There is no migrated legacy billed/waived history. Database checks enforce distinct payer references, immutable payloads, unique active job claims/requests/receipts/replacements, fully allocated or fully reversed receipts, bounded settlement, full charge reversal, and anonymous completion. Deferred checks allow intermediate states inside an atomic checkout/correction but reject invalid commits. Nullable historical references may detach to NULL, never be reassigned on immutable records.

Financial mutations and minimal audit events commit together. Audit metadata contains identifiers/changed-field names, not copied names, addresses, contact channels, reasons, or service descriptions. Operations store no request/response bodies. Errors expose the stable application envelope rather than SQL diagnostics.

Permissions are `orders.read/write/finalize/reverse`, `payments.read/record/reverse`, `external_invoice_requests.read/manage/approve`, and `cash_movements.read/record`. Mutations require relevant read permission as well as the action permission; replacement also requires finalization and payment read/record, and supplied reversals require payment reverse. Organization requirements use `organizations.manage`. All are registered grants; no business role names authorize operations. Order readers see minimal active-request identifiers/state, but recipient/address details require external-request read permission.

Person/Account deletion detaches financial references without deleting Orders, Payments, allocations, adjustments, or external requests. Minimal Order customer-name snapshots and wiRef recipient snapshots remain separate retained data; deleting a Person does not erase those financial snapshots automatically. Owned child rows may cascade when their aggregate is deliberately purged; cross-aggregate financial references use SET NULL. There are no new financial deletion endpoints or retention scheduler.

Before implementing GDPR retention, define approved retention periods/legal bases independently for technical jobs, charge records, receipts, billing snapshots, audit, and idempotency evidence. Design coordinated snapshot erasure/anonymization and aggregate purges, preserved references/evidence, and actor attribution. Existing inventory consumption rows require a live usage link: a future job/usage purge must reconcile that constraint with its SET NULL foreign key. Jobs can retain technical facts while customer/operator links detach today. Test the resulting cleanup transactions against immutability/deferred constraints and populated downgrade protection. Do not treat the current immutable snapshots as permanently exempt from erasure.

## Verification

Run `make generate`, `make check-generated`, `make check-backend`, `make check-frontend`, `make test-integration`, `make test-migrations`, and `make test-e2e`. PostgreSQL tests use isolated schemas and cover authorization separation, exact decimals, optimistic/concurrent mutation, immutable snapshots, source corrections, stock compensation, Person deletion/source detachment, whole-receipt correction, carry-forward without money movement, wiRef requirements/evidence, and audit rollback. Frontend and full-stack browser tests cover accessible forms, permission-aware navigation, retries, replacement, wiRef lifecycle, narrow layouts, and browser errors. Keep the initial recursively loaded production JavaScript and entry CSS within repository budgets; all financial pages are route-lazy.
