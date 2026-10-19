# Sales & payments redesign: design spec

Frontend-only prototype in the same folder as the Machines & Jobs prototype. Open `http://localhost:5173/prototype.html#/sales`.
Prototype controls (beaker icon): role presets include **Front desk** and **Finance**; the data state (loading, error, empty) applies to every sales page.
Everything marked **Proposed** (small outline tag in the UI) needs new backend capability and is listed at the end.

## Structure

`sales/` holds everything new. Domain truth is the real backend (`docs/orders.md`).

| File | Role |
|---|---|
| `types.ts` | Order (always with a customer), item, job charge snapshot (with the pricing group and why), payment, signed allocation, adjustment, wiRef invoice request, organization, cash movement |
| `engine.ts` | Pure transitions that enforce the rules and throw a `SalesError` naming the rule. Nothing applies when one throws (atomic) |
| `logic.ts` | Derivations: settlement (never stored), order views, ready-to-bill groups, accepted payment methods, cash in register, cashbook lines, readiness checklist, invoice progress |
| `pricing.ts` | Rates, pricing groups, account roles with their priority, `resolveGroup` (group and reason) |
| `status.tsx`, `labels.ts` | The single status helper `orderStatus()` and all human wording; no raw enum is shown |
| `mockData.ts` | Seed replayed through the engine at past times: orders in every state, payments, invoice requests, cash movements, organizations |
| `pages/`, `components/`, `dialogs/` | Screens |

## Navigation

Group "Sales & payments": **Overview, Orders, Payments, Pricing.** Items hide when the role lacks the permission; pages show a no-access state. There is no counter sale, invoicing or customers area (old links redirect to Orders).
Permissions use the real names (`orders.read/write/finalize/reverse`, `payments.read/record/reverse`, `external_invoice_requests.read/manage/approve`, `pricing.read/manage`, `organizations.read/manage`).
Front desk: creates and finalizes orders, records payments and cash movements; no reversals, no pricing edits (no `machine_jobs.override_price`), no invoice requests. Finance: all sales, read-only workshop, no approval. **Management** and the workshop supervisor additionally hold `external_invoice_requests.approve` (**Proposed**).

## Rules

- Every order and every job has a customer: an account (person) or an organization. There are no anonymous or walk-in orders; the job form, "Create separate jobs" and "Create combined job" require a customer.
- Paying immediately is **Finalize and take payment** in the order (split, cash change calculator, card reference, editable time). Partial payments are fine. "Finalize without payment" is in the menu.
- References `O-/P-/W-/C-YYYY-NNNNNN`; jobs are claimed at finalization; a changed job version means "job changed since charged"; settlement is derived; card payments need terminal and a unique reference; reversals are whole receipts; replacement transfers allocations.
- **Pricing group resolution:** set on the job > group of the organization (organization customers) > group mapped to the account's highest-priority role > default group. Role priority: Staff, Student team member, Student, Makerspace member. The resolved group and the reason ("via role Student", "via the organization", "default group, the account has no role", "set on the job") show in the job form, the separate-jobs dialog, the ready-to-bill list, order items and the price preview.
- **Invoices are issued by wiRef** (Core hands the data over). **[Proposed]** An invoice can be requested whatever the payment:
  - Cash/card already received are carried on the request as "already paid" (follows payments while the request is a draft, frozen from awaiting approval on); the invoice is then marked paid for that part, and paid in full when nothing is outstanding.
  - The rest is paid by bank transfer to the HTU account, recorded as "Bank transfer (wiRef invoice)", only after the invoice is issued.
  - Cash/card and bank transfer may be mixed on one order. Once the request awaits approval, cash/card can no longer be added or refunded without cancelling the request first.
  - An order that charges nothing cannot be invoiced.
  - Cancellation, reconciliation kinds and invoice number corrections work as before; correcting a bank transfer needs the cancelled request.
- **Invoice request workflow [Proposed]** (shown with the Proposed tag next to the Invoice heading). States: **Draft, Awaiting approval, Issued**, then Cancellation requested and Cancelled.
  1. *Draft*: staff (`manage`) fill recipient and service details; the readiness checklist must be complete. **Submit for approval** moves it to *Awaiting approval*. The old "ready" and "submitted to wiRef" steps are gone.
  2. *Awaiting approval*: only holders of `external_invoice_requests.approve` can (a) **edit** the data inline with the same form as the draft (each save is an audit entry), (b) **Return for correction** with a required comment, which moves it back to the draft where the latest comment (who, when, text) is shown in a warning notification until it is submitted again, (c) **Copy for wiRef**: a modal with the data as plain text in a Carbon code snippet (order and request reference, recipient, contact, address, country, purchase order, service period and description, item lines, total, already paid, still to pay by bank transfer, a placeholder for the HTU bank-transfer note). Its primary action **Mark as forwarded to wiRef** sets the request to *Issued*. Everyone else sees the request read-only with "Waiting for approval by management".
  3. *Issued*: a bank transfer can be recorded (existing rule). The wiRef invoice number is optional: **Add wiRef invoice number** (section row or menu) records it later; with a number on record the same action becomes a correction that needs a reason.
  4. Cash and card are blocked from *Awaiting approval* on (the already-paid figure is frozen, as the old ready state did); a return to the draft makes them available again. Cancelling a request that awaits approval needs the approve permission; an issued request needs the external cancellation process.
  5. The engine enforces the permission (`Ctx.canApproveInvoices`, error `permission_denied`) next to the UI, and again checks the checklist when forwarding.
- No day close and no day locks. Cash movements replace them.

## Screens

- **Overview**: tiles for cash in register (expected), takings today, awaiting payment, **Invoices to approve** (count and total, only with the approve permission, links to Orders filtered to Awaiting approval), invoice requests to handle and jobs ready to bill; "Needs attention" (old drafts, unpaid orders, billable customers, invoices to approve, invoice steps) and recent orders.
- **Orders**: one row per order. Switcher Open and Paid (with counts). Columns Order (reference and customer), Status, Payment (paid or outstanding), Invoice (state and next step, or a dash), Total, Updated. Search by reference or customer, a filter popover (Status: Drafts, Awaiting payment, Reversed & cancelled; **Invoice**: No invoice, Draft, Awaiting approval, Issued, Cancelled, taken from the latest request, so the two categories do not overlap; customer type; created range), sorting, pagination, and a removable customer chip (`?customer=`). Customer names everywhere link to the Orders table filtered by that customer. A notification above the table ("12 finished jobs are ready to bill") opens a modal with the grouped jobs and the batch "Create order".
- **Order detail**: status-dependent primary action (Finalize and take payment, Finalize, Record payment or bank transfer, Print receipt, Commit replacement, Replace, Duplicate); menu with Request invoice, Correct order, Finalize without payment. Summary tiles, items (with pricing group and reason), payments, and an **Invoice** section once requested: progress indicator (Draft, Awaiting approval, Issued; cancellation marks the last step reached), the latest return comment on a returned draft, next step, amounts (invoice, already paid, still to pay), invoice number, readiness checklist, recipient form while draft (staff) or awaiting approval (management) and frozen details otherwise, history, and every action per state (submit for approval; return for correction, copy for wiRef and mark forwarded; add wiRef invoice number or correct it; request and confirm cancellation with reconciliation kind; cancel; record bank transfer; request again).
- **Request invoice** (modal): recipient prefilled from the organization or the account, service period, description, purchase order reference (required when the organization requires it), payment summary, inline readiness checklist.
- **Payments**: cashbook; the period (Today default, Yesterday, This week, This month, Custom range with From and Through) is the **Period** category of the filter panel (Reset returns to Today) and the active period is stated in plain text above the tiles; tiles per method (cash, card, invoice), a tile **Cash in register (expected)** (Toggletip: cash receipts − cash refunds − withdrawals + deposits, all time up to the period end; card and invoice payments don't go through the register), search, filters (period, method, kind including cash withdrawal and deposit, customer type), CSV export with movements (semicolons, decimal commas). Cash movements and the export are accepted features, no longer marked Proposed. **Record cash withdrawal** and **Record cash deposit** (amount, editable time, reason Bank deposit / Moved to safe / Change float / Other, note, recorded by). A withdrawal cannot exceed the cash the register should hold.
- **Payment detail**: facts, order and customer links, history, Refund or correct with only valid reasons.
- **Pricing**: Groups & rates (matrix, inline editing, groups), Role mapping (each account role to a group, plus the default group), Organizations (kind, pricing group, purchase order requirement, active, invoice address; add and edit), Price preview (optionally resolved for a customer).

## Proposed backend capabilities

1. Sale catalog with fixed prices (catalog items on orders).
2. Order timeline/audit read endpoint with actor and readable text.
3. Receipt numbering and PDF export.
4. `createdBy` display name on orders and `recordedBy` on payments.
5. CSV export of payments and cash movements (Payments > Export CSV): accepted. Semicolon separated with decimal commas and a UTF-8 byte order mark, for German and Austrian spreadsheets.
6. **Cash movements** (withdrawals and deposits with reason and note) and the expected cash in the register: accepted. Only cash counts; card and invoice payments never go through the register.
7. **Invoice request approval**: request state `submitted` (Awaiting approval), the permission `external_invoice_requests.approve`, a return-for-correction transition with a comment, and a forward-to-wiRef transition that issues the request without an invoice number (the number becomes optional and can be added later).
7a. **Invoice request regardless of payment**: "already paid" cash/card amount on the request, bank transfer payments only after issue, mixing cash/card with a bank transfer. The backend currently blocks an invoice request once a cash or card payment exists.
8. **Role mapping**: account role to pricing group, with a priority order and a default group.
9. **Organization pricing group** and organization admin (kind, active, invoice address) on the Pricing page; organization invoicing requirements already exist.
