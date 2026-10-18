# Sales & payments redesign: design spec (Parts 1 and 2)

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

## Part 2 screens

Engine additions (all in `engine.ts`, with tests in `engine.test.ts`): wiRef commands (`updateRequestDetails` only while draft, `markRequestReady` with the readiness checklist, `markRequestSubmitted`, `recordRequestIssued` with matching amount, `cancelRequest` for draft/ready only, `requestCancellation`, `confirmRequestCancellation` with a reconciliation kind, `correctRequestReference`), `prepareInvoiceRequest` now links a successor to its cancelled predecessor, `closeDay`, `assignPricingGroup`, `setPurchaseOrderRequirement`, `savePricingGroup`, `setRate`. A closed cash day rejects new cash payments and backdated cash corrections (`day_closed`).

- **Payments** (`/sales/payments`): tabs Cashbook and Day close. Period presets in the app time zone (Today, Yesterday, This week from Monday, This month, Custom range), tiles per method with net takings and counts, table (time, payment, order and customer links, method, kind Receipt/Refund/Correction, signed amount, recorded by), search, filters (method, kind, customer type), pagination, filters and period in the URL. Export CSV builds a real file client-side from the filtered lines (`csv.ts`: comma separated, UTF-8 with BOM, formula-safe text). Cash lines of a closed day carry a "Day closed" tag.
- **Day close**: day picker (open cash days), expected cash (cash receipts minus cash refunds and corrections), counted cash plus a banknote and coin counter (Carbon NumberInputs), difference (a note is required when it is not zero), confirmation, list of closed days.
- **Payment detail** (`/sales/payments/:id`): facts, order and customer links, the life of the payment in plain words from its allocations, links between a receipt and its reversal. **Refund or correct** offers only the reasons that are valid for the method and state (refund and recording error for cash and card, accounting correction for wiRef payments once the request is cancelled), explains each, edits the time of a refund, requires the terminal reference for card, shows the closed-day block, and for a walk-in sale asks for the right replacement receipt in the same step.
- **Invoicing** (`/sales/invoicing`): list with search, customer and state filters, amount, next step, sorting and pagination; **New request** with an eligible-order picker and a list of orders that are not eligible with the reason. **Request detail**: progress indicator (Draft, Ready to submit, Submitted, Invoice issued, Paid; cancellation marks the last step reached), recipient form while draft, frozen details afterwards, readiness checklist (recipient, address, country, contact person for organizations, purchase order reference when the organization requires it, service period, description), primary action and menu per state with dialogs, humanized history with references and effective dates.
- **Customers** (`/sales/customers`): list of persons and organizations with type, pricing group, open balance, orders, last activity, search and filters. Detail: figures, pricing group assignment (or follow the default), purchase order requirement toggle for organizations (applies to requests marked ready from now on), tabs Orders, Unbilled jobs (with "Bill n jobs") and Payments.
- **Pricing** (`/sales/pricing`, moved here from Settings > Machines; the prototype had no older copy): tabs Rates (matrix of groups by machine runtime per machine type and material per category and unit, inline editing, "Missing" cells and a warning), Groups (default, active, description, new and edit, optional copy of another group's rates), Assignments (per customer), Price preview (machine type, duration, materials, group, itemized price and the same job in every group). Rates feed every quote in the prototype (counter sale, job forms); a missing rate leaves a job's price incomplete and blocks a counter sale.

## Proposed backend capabilities

1. Sale catalog with fixed prices (catalog items on orders and counter sales).
2. Order timeline/audit read endpoint with actor and readable text.
3. Receipt numbering and PDF export.
4. `createdBy` display name on orders and `recordedBy` on payments.
5. CSV export of payments (Payments > Export CSV).
6. Cash day close sessions: expected and counted cash, difference, note, lock on a closed day (Payments > Day close, "Day closed" tags, the `day_closed` rule).
7. Organization-level invoicing requirement is real; a customer list endpoint with open balance and last activity (Customers) is derived client-side today and would need aggregation on the server.
