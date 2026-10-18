# Sales & payments redesign: design spec (Part 1)

Frontend-only prototype in the same folder as the Machines & Jobs prototype. Open `http://localhost:5173/prototype.html#/sales`.
Prototype controls (beaker icon): role presets now include **Front desk** and **Finance**; the data state (loading, error, empty) applies to every sales page.
Everything marked **Proposed** (small outline tag in the UI) needs new backend capability and is listed at the end.

## Structure

`sales/` holds everything new. Domain truth is the real backend (`docs/orders.md`).

| File | Role |
|---|---|
| `types.ts` | Order, item (manual / machine_job), job charge snapshot, payment, signed allocation, adjustment, wiRef request |
| `engine.ts` | Pure transitions that enforce the backend rules and throw a `SalesError` naming the rule. Nothing applies when one throws (atomic) |
| `logic.ts` | Derivations: settlement (never stored), order views, ready-to-bill groups, eligible jobs, takings |
| `status.tsx`, `labels.ts` | The single status helper `orderStatus()` and all human wording; no raw enum is shown |
| `format.ts` | de-AT money, Vienna dates, tolerant money input |
| `mockData.ts` | Seed replayed through the engine at past times: 31 orders in every state, 40+ payments, wiRef requests |
| `pages/`, `components/`, `dialogs/` | Screens |

Store (`store.tsx`) adds orders, payments, allocations, adjustments, requests and the engine actions: create draft, add/remove/edit/refresh items, add job snapshots (with claims at finalization), finalize, checkout, record payments (split), cancel draft, reverse payment, reverse order, replace with payment carry-over/refund, counter sale (job, stock consumption, order and payment in one step), duplicate, batch drafts, prepare wiRef request.

Rules mirrored from the backend: references `O-/P-/W-YYYY-NNNNNN`; draft, finalized, cancelled, reversed; jobs are claimed at finalization and a changed job version means "job changed since charged"; settlement is derived from charge, reversals and allocations; card payments need terminal and unique reference; cash/card and wiRef payments cannot mix; an active wiRef request blocks cash/card; walk-in sales are immediate and fully settled; reversals are whole receipts (refund, recording error); replacement transfers allocations and cannot carry more than the new total.

## Navigation

Group "Sales & payments": Overview, Counter sale, Orders, Payments, Invoicing, Customers, Pricing. Items hide when the role lacks the permission; pages show a no-access state. Permissions use the real names (`orders.read/write/finalize/reverse`, `payments.read/record/reverse`, `external_invoice_requests.read/manage`, `pricing.read/manage`, `organizations.read/manage`).
Front desk: counter sale, orders, record payments, price override for free sales; no reversal, no wiRef. Finance: all sales, read-only workshop.

## Screens

- **Overview**: takings today and this week by method, awaiting payment (count and sum), ready to bill; "Needs attention" (drafts older than 7 days, unpaid orders, billable customers, open wiRef steps) and recent sales.
- **Counter sale**: source "From a run" (unassigned finished runs of the last 24 h with preview) or "Manual" (machine search, 15/30/60/custom minutes); material from the printer's mounted spools first, else stock search, customer-owned toggle; extra items (catalog is Proposed, custom exists); sticky live price panel with pricing group and adjustment (bottom bar on narrow screens); payment tiles Cash / Card / Split with change calculator and card reference; explicit "Free of charge" with reason (price adjustment to 0); completion screen with printable receipt.
- **Orders**: tabs All orders / Ready to bill. Search by reference or customer, Filters popover (status, customer type, created range, outstanding, wiRef), sorting, pagination. Ready to bill groups finished jobs per customer, shows blocked jobs with the reason, creates one draft per customer.
- **Order detail**: status-dependent primary action (Finalize, Check out, Record payment, Print receipt, Commit replacement, Replace, Duplicate); summary tiles; items with thumbnail, "job changed" and Refresh in drafts; Add items menu (eligible jobs only, catalog, custom); payments including carried-over ones; timeline (Proposed); Correct order wizard (intent, payments with only valid options, reason and review); Prepare wiRef request; receipt view.
- **Jobs**: job detail shows its order (or draft); mass edit has "Add to order" (same customer, finished, priced).

## Part 2 (placeholders, labelled in `Part2Pages.tsx`)

Payments cashbook and payment detail with Refund or correct, Invoicing (wiRef list and detail), Customers, Pricing (moved from Settings). Engine support for standalone `reversePayment` and request preparation exists already.

## Proposed backend capabilities

1. Sale catalog with fixed prices (catalog items on orders and counter sales).
2. Order timeline/audit read endpoint with actor and readable text.
3. Receipt numbering and PDF export.
4. `createdBy` display name on orders and `recordedBy` on payments.
5. Part 2: CSV export of payments, cash day close sessions.
