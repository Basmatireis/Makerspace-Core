# Machines & Jobs redesign — design spec

Frontend-only prototype. Launch: `cd frontend && pnpm dev`, open `http://localhost:5173/prototype.html`.
Header beaker icon → prototype controls (role preset, data state: realistic / loading / error / empty, reset).

## 1. Information architecture

### Alternatives considered

| | A. Object hubs (chosen) | B. Workflow board | C. Machine-centric |
|---|---|---|---|
| Shape | Overview · Jobs · Machines · Inventory · Statistics (Inventory, Statistics unchanged; printer prints live inside Jobs) | "Now" board · Queue (prints+review) · Records · Setup | Machines list → everything nested per machine |
| Clarity | One noun per page; matches backend objects | Strong for supervisors, vague for occasional users ("Records"?) | Simple for single-machine tasks; history across machines is hard |
| Common workflows | Each ≤2 clicks from nav; Overview deep-links into filtered views | Fastest for live ops; slow for lookups | Looking up "Lena's job last week" needs to know the machine |
| Navigation depth | 2 levels (list → detail) | 2 levels but mixed object types per page | 3 levels (machines → machine → job) |
| Scalability | New machine types/connectors fit without new nav | Board saturates with many machines | Breaks for jobs not tied to one machine view |
| Carbon fit | Standard list (DataTable) + detail page + modal pattern | Needs custom dashboard composition | Deep tab nesting |
| Effort | Low: reuses current routes/queries | Medium–high | Medium |

**Decision: A.** It keeps one mental model per page, maps 1:1 onto existing endpoints, removes the two
pages that existed only as workflow fragments (Review, Print detail's raw ID inputs), and puts
the live, workflow-oriented view on the Overview instead of spreading it across pages.

### Navigation (Workshop group)

| Current (7) | Proposed (6) |
|---|---|
| Overview | **Overview** — "what needs me now" + live machine board |
| Machines | **Machines** — list → detail with tabs |
| Jobs | **Jobs** — one table for jobs and unlinked printer prints; "Unlinked print" is a status filter |
| Review | Removed: no job is created unconfirmed any more, so there is nothing to review |
| Print submissions | Replaced by automatic **prints** reported by printer connectors, shown inside **Jobs**. Nobody creates or starts a print by hand. |
| Inventory | Inventory (unchanged, out of scope) |
| Statistics | Statistics (unchanged, out of scope) |
| (Settings › Machine logbook) | unchanged; machine *types* move into Machines › Machine types tab |
| Settings › Printer connectors | moved into **Machines › Connectors** tab; printers are assigned from the printer (Connection) |

## Domain model

- **Print** = an automatic run reported by a printer connector (file name, state printing / finished / failed /
  cancelled, start, end or estimated end, progress, reported material, printer events). Read-only; nobody creates
  prints manually.
- **Job** = the logbook record (customer, operator, outcome, material, price). A job's `run` is either
  **manual** or **automatic**.
- If a printer cannot create a print (system problem or not connected), staff simply **create a job**; its run is
  manual. If the job's defined end lies in the future, a **simulated run** is running: it ends at that time, or
  earlier when staff **cancel the run**.
- When an automatic print later shows up for that work, staff either **create a job from the print** (the job is
  linked at once) or **link the print to the existing job**. Linking **replaces the manual run**: the job takes
  the print's start, end and reported material (basis actual), becomes `automatic`, and the price is recalculated.
  **Unlink** keeps the job's values and turns its run back to manual.

The UI never shows raw UUIDs or version numbers.

### Outcome rule
The outcome is only asked for once a run has ended. The job form hides **Outcome** while the computed end is in
the future and saves it as not recorded (`unknown`). A finished job without an outcome shows **Needs outcome**:
job detail offers an inline "Record the outcome" prompt (machine_jobs.edit), the Overview has a "Needs outcome"
tile, and the Jobs status filter has the same value. Linking a finished printer print fills the outcome from the
print (finished → Successful, failed → Failed, cancelled → Cancelled); Cancel run sets Cancelled. When editing a
job that has no outcome yet, the field starts empty and must be chosen; new jobs with a past end default to
Successful. Backend: `unknown` is an existing outcome value and a later PATCH sets the real one — no API change.

### Naming rule
Only the **job** has an editable name (optional). A **print** keeps the name its printer reported (file name,
read-only), because it is the printer's record and must match its events. Display name of a job: its own name →
else the linked print's file name, made readable (`gearbox_housing_v3.gcode` → "Gearbox housing v3") → else the
job number. A manual run has no separate print, so there is nothing second to name. Creating a job from a print
prefills the name from the file name. Lists show the name first and the job number / file name underneath; the
J-number stays the stable identifier. Not chosen: auto-generated job names only (would force renaming slicer
files) and editable print names (would diverge from printer data).

## 2. Screens

All pages use `PageShell` (breadcrumbs, title, description, actions) from `src/app`. Width `wide`.
One primary button per page header; everything else is secondary/ghost or in an `OverflowMenu`.

### Overview `/`
Fits one laptop viewport without scrolling; every block sits on a solid layer background.
- Header: description "4 jobs today · 3 running · 3 unlinked"; plain primary **New job** (machine_jobs.create).
- **Key figures**: three `ClickableTile`s (auto-fit grid) — Running now (manual running jobs + printing prints,
  machine names listed), Unlinked prints (finished/failed prints without a job → `/jobs?status=unlinked`),
  Billing issues (missing price rule or changed order). Zero counts stay visible in secondary colour.
- **Active jobs** (`ContainedList`, left, 3/5): running → printing → unlinked rows, max 6 with "N more" link;
  row = title, "machine · customer · ends ~HH:MM", status tag; header link "All jobs".
- **Machines** (`ContainedList`, right, 2/5): one line per non-retired machine with current item (print file or
  running job and its end time) / last job, connector issue tag and availability tag.
- Narrow screens: figures become a 2-column grid, panels stack.
### Print detail `/jobs/prints/:printId`
Read-only data from the printer. No lifecycle buttons.
- Header: title = file name, adornment status tag, description "PR-… · machine · via <connector>".
- While printing: Carbon `ProgressBar` with percent and "ends ~HH:MM".
- Facts: Machine, Started, Ended / Estimated end, Runtime, Reported material.
- **Unlinked** (finished/failed/cancelled): warning notification, primary **Create job** (machine_jobs.create →
  `JobFormModal` create, prefilled with machine, start, end, outcome from the print state and the reported
  material; on save the print is linked) and secondary **Link to job** (machine_jobs.edit → `LinkJobModal`).
- **Linked**: section "Linked to J-…" with link to the job; overflow **Unlink** (`DestructiveActionDialog`).
- Printer events in a collapsed `Accordion`.

### Jobs `/jobs`
- One table for jobs and unlinked prints, styled exactly like the production Directory table
  (`TableContainer` → `TableToolbar` + `TableToolbarContent`, `Pagination` footer inside the container; CSS copied as
  `mj-table-container` / `mj-filter-panel*`). No row selection and no batch actions.
- Toolbar: expandable `TableToolbarSearch`; icon-only **Filter** button toggling an inline filter region with
  `MultiSelect`s Status, Machine, Run (Manual / Printer), Material, Billing state, `ComboBox`es Customer and Operator,
  `DateInput`s From / Through and **Clear filters**. All filters live in the URL (`status`, `machine`, `run`,
  `material`, `billing` comma-separated; `customer`, `operator`, `from`, `to`, `q`). `?status=unlinked` and
  `?status=running,printing` are the deep links.
- Primary: plain Carbon **New job** `Button` (machine_jobs.create), hidden without permission.
- Rows (`buildJobRows`): every job (a linked print is attached: title = job id, file name below); every print
  without a job (title = file name, "PR-… · Unlinked" below, link `/jobs/prints/:id`). Columns: Job, Machine,
  Customer (+ operator), Status (`JobRowStatusTag`), Started, Price. All but Status sortable; client-side pagination.
- Statuses: **Running** (manual run whose end is in the future and not cancelled, or a linked print that is still
  printing) · **Printing (unlinked)** · **Unlinked print** · outcomes Successful / Partial failure / Failed /
  Cancelled / Unknown outcome.
- Empty states inside the container. Narrow (<42rem): Machine, Customer and Started columns hide and the toolbar wraps.

### Job detail `/jobs/:id`
- Header: title = display ID, adornment status tag, description "Machine · start time". Primary **Edit job**
  (machine_jobs.edit). Overflow: Edit material usage (machine_jobs.edit), Override price / Clear override
  (machine_jobs.override_price).
- Facts strip: Customer (+ pricing group), Operator, Start, Runtime (+ end), Source.
- **Run** tile:
  - manual and running: tag "Running · manual", `ProgressBar` (elapsed share of the defined runtime), "Ends HH:MM",
    **Cancel run** (`DestructiveActionDialog`; the run ends now, outcome cancelled, price recalculated) and
    **Link printer data** (`LinkPrintModal`: picker of unlinked prints on the machine, same comparison as below).
  - manual and finished: "Manual run" and **Link printer data** when unlinked prints exist on the machine.
  - automatic: "From printer", print link, file name and connector.
- Main column: **Material usage** table, **Notes**. Side column: **Price & billing** tile (as before).
- Warnings at top when relevant: price incomplete.

#### Link and replace
`LinkJobModal` (from a print) and `LinkPrintModal` (from a job) share one comparison: a `StructuredList` with
Field | Manual entry | From printer for Start, Runtime and Material, and a warning `InlineNotification` "The manual
run is replaced with the printer's data. Price is recalculated." Primary action **Link and replace** (**Link print**
when nothing changes). Jobs already linked to another print are not offered. Success shows a toast.

### Machines `/machines`
Contained `Tabs` **Machines** · **Connectors** (printer_connectors.read) · **Machine types**; the tab is in the URL
(`?tab=connectors`, `?tab=types`; default machines) and the existing filter params keep working.
- **Machines tab**: `DataTable`: Machine (name link + type below), Availability (`AvailabilityTag`), Activity
  (current print or running job, or "Last job …"), Jobs (count), Failure rate, Last data. Toolbar: search, filter toggle
  (status, type, collection, connector state), primary **Add machine** (machines.manage) which opens the setup wizard.
- **Connectors tab**: `DataTable` Connector (name + location), Status `Tag` (Pending / Healthy / Degraded / Offline /
  Disabled / Revoked), Last heartbeat, Printers (links to the assigned machines), Software, Event queue
  ("3 pending · 0 quarantined"). Row `OverflowMenu`: Diagnostics, Enroll (pending; printer_connectors.credentials.manage),
  Enable / Disable (printer_connectors.manage), Revoke (`DestructiveActionDialog`, credentials.manage). Toolbar
  **Add connector** (name, location) → second modal with the enrollment secret in a `CodeSnippet`, warning "Copy this
  enrollment secret now. It expires after 15 minutes and can't be shown again." and **I have stored the secret**.
  Diagnostics (large modal): health notification when degraded, assigned printers with runtime state and a link
  "Open printer setup", recent events in an `Accordion` with the JSON collapsed in a `CodeSnippet`. There is no printer
  assignment form here; assignments are made from the printer.
- **Machine types tab**: `DataTable` Name, Status `Tag`, Machines (count). Toolbar **Add type** (modal, unique name),
  row overflow Rename / Activate / Deactivate (machines.manage; read-only otherwise). Helper: inactive types stay on
  existing machines but can't be chosen for new ones.

### Machine setup wizard (`dialogs/MachineSetupWizard.tsx`)
`ComposedModal` (lg) with `ProgressIndicator` and footer Back / Next / Create machine (Cancel on step 1).
1. **Machine**: name, type `Select` (active types; **New type** inline creates the type at once), status radios, and for
   FDM / 3D-printer types a **Model** `RadioTile` group (H2D, X1C, CORE One, Other). Other types skip steps 2 and 3.
2. **Connection**: tiles *Connect a connector now* / *Set up later*; connector `Select` (active hosts), adapter from the
   model (only the H2D has a live LAN adapter; other models offer the Simulator), IPv4, serial number (upper-case,
   `[A-Z0-9_-]`), LAN access code (`PasswordInput`, optional when editing: blank keeps the code) and the RFID auto-mount
   `Checkbox`. **Test connection** (`InlineLoading`) reads what the printer reports (firmware, nozzles, AMS units, external
   holders) or fails with an actionable message (unreachable / wrong code; chosen in the prototype controls). Skipping
   the test shows a warning that slot mapping uses the model template only.
3. **Spool inputs**: units and slots prefilled from the model template (or the existing profile), grouped by nozzle for
   two-nozzle models. Each unit has a name, nozzle and slots; each slot a name, a **Printer slot** `Dropdown` of detected
   slots not used elsewhere (or the template's expected slots before a test) and a **Detected** cell (swatch, material,
   remaining %, RFID tag). **Match automatically** maps by printer id, then by position; reported units missing from the
   setup raise an `ActionableNotification` ("Add as input unit"); a per-slot overflow offers a custom identifier.
   Duplicate mappings are blocked.
4. **Review**: `StructuredList` of machine, connection (access code only "Set" / "Not set") and mapping.
Edit mode opens the same component on one step (no progress indicator, footer Cancel / Save).

### Machine detail `/machines/:id`
- Header: name, adornment `AvailabilityTag`, description = type. Primary: **New job** (machine prefilled,
  machine_jobs.create). Overflow: Edit machine (machines.manage) → wizard step *Machine*.
- Connector issue `InlineNotification` (warning) when degraded/disconnected.
- `Tabs`: **Overview** · **Jobs** · **Printer setup** (only when a printer profile exists, or machines.manage on a printer type).
  - Overview: facts (status, type, model, serial number, collection, last ingest), activity numbers
    (jobs, runtime, failure rate) as a 3-up tile row, current item (print file or running job, with end time) if in use, last 5 jobs.
  - Jobs: `JobsTable` filtered to this machine (+ link "Open in Jobs" with `?machine=`).
  - Printer setup: **Printing** `Toggle` tile (disable → `DestructiveActionDialog`); **Connection** tile (connector link to
    Machines › Connectors, adapter, IP, serial, access code Set, auto-mount, runtime state, last heartbeat; **Edit
    connection**, or an empty state with **Connect printer**); **Spool inputs** tiles grouped by nozzle with columns
    Slot · Printer slot · Detected · Mounted spool · Actions (Mount/Unmount; printer_slots.assign + inventory.read),
    **Edit spool inputs** (opens wizard step 3; also **Create profile** when none exists) and the drift notification
    "The printer reports AMS HT (128), which isn't set up" with **Add as input unit**.

### Table pattern (all lists)
Every list uses the production Directory table: `<TableContainer className="mj-table-container">`, toolbar with
expandable search, icon-only filter toggle (primary when filters are active) opening an inline filter panel with
"Clear filters", optional overflow menu, primary action last; sortable headers over the whole filtered list;
empty state and `Pagination` footer inside the container; filters, search and page in the URL; narrow screens
keep the table and hide secondary columns. Shared CSS lives in `prototype.scss`; Inventory adds a reusable
`components/DirectoryTable.tsx`.

### Inventory `/inventory`
Contained tabs **Materials** · **Spools** · **Products**, each one table (no page-header action).

**Spool vs. fill.** A *spool* is the physical (mostly reusable) carrier; a *fill* is one filling of it with one filament.
The spool's material, remaining, initial weight, manufacturer, product and identifiers describe the **current fill**.
Closing a fill moves it into the spool's **fill history** (material, used, leftover and its outcome, tags that belonged
to it). Fill numbers are 1-based. Reusable spools are *Loaded* / *Needs refill* (no current fill) / *Archived*;
single-use spools are *Active* / *Archived*. Empty reusable spools never appear as consumable stock (mount list, job
usage spool select) but stay listed with status "Needs refill".

**Stock split.** Material stock = filament on spools + loose stock. Filling from loose stock (Transfer) only moves
attribution and never changes the material total (backend `spool-transfers`). The UI shows the split: Materials table
"In stock" has a second line "x g on spools · y g loose", material facts have On spools and Loose stock, and source
helper text states the effect ("Moves 1,000 g from loose stock to this spool. The material total stays 6,107 g." /
"Adds 1,000 g to PLA Black stock (new total 7,107 g) and records the purchase."). Transfers are validated against
loose stock. Ledger transfers read "1,000 g → SP-0141" or "37 g: SP-0141 → loose" with "Total unchanged".

**Product catalog** (`?tab=products`; FUTURE backend capability, no catalog entity exists in the API today, see REDESIGN.md).
A *product* is something the makerspace buys: manufacturer, name, material, net weight, default price (€ per unit bought),
**packaging** and notes. Packaging is *Refill* (filament only, for reusable spools, e.g. Bambu Lab refills with RFID
tags) or *Spool* (comes on its own single-use spool). The product's **material** is the inventory material whose stock the
grams count towards and whose category drives job pricing, so choosing a product never changes pricing logic.
- Products table (`components/ProductsTable.tsx`, `DirectoryTable`): Product (name opens the edit dialog, manufacturer
  secondary; row click does the same), Material (link), Net weight, Default price, Packaging tag, In use (non-archived
  spools whose current fill uses the product), Status tag only when inactive. Filters: manufacturer, material, packaging,
  show inactive. Toolbar primary **Add product**; both add and edit need `inventory.manage` (others see plain names).
  Add/edit is `dialogs/ProductFormModal.tsx` (manufacturer `ComboBox` with custom value, name, material, net weight,
  default price, packaging radios, notes, Active toggle on edit). There is no product detail page.
- **Selection flow.** Register spool and the *New filament* step of Change filament start with a **Product** `ComboBox`
  (active products, label "Bambu Lab · PLA Basic Black · 1,000 g", searchable by manufacturer, name and material). Choosing a
  product sets material (read-only then), net weight, the manufacturer/product snapshot and, prefilled for a new purchase,
  the price (all editable except material). Register spool defaults Type from packaging (Spool: single-use, Refill:
  reusable). Change filament shows a non-blocking info notification when a *Spool* product goes onto a reusable spool.
  Checkbox **Not in catalog** disables the ComboBox and shows the manual material, manufacturer and product fields.
  Change filament preselects the spool's current product when it is still active.
- **Snapshot rule.** Spools and fills keep `productId` (nullable) plus the `manufacturer` / `productName` text as a
  snapshot taken at selection time. Later catalog edits or deactivation never rewrite them, and manual entries have
  `productId = null`. Tables and history show the snapshot text.
- Material detail has a compact **Products** table for its catalog products with **Add product** in the toolbar.

- Materials: Material, In stock (+ spools/loose line for filament), Stock tag, Low-stock threshold, Avg. cost, Spools.
  Filters: category, stock state, show inactive. Toolbar `MenuButton` **New** (Add material, Register spool).
- Spools: Spool (ID, label; manufacturer · product on narrow screens), Product (name, manufacturer secondary), Type (Reusable / Single-use), Material, Remaining ("Needs refill"
  for empty reusable), Location, Mounted on, Status. Filters: material, type, status, mounted, **Show archived**
  (archived hidden by default), product, manufacturer. Toolbar overflow (`TableToolbarMenu`) **Clean up archived spools**; `MenuButton`
  **New** (Register spool, Change filament).
- Material detail `/inventory/materials/:id`: primary **Add stock**; overflow Record consumption, Correct stock,
  Record disposal, Mark as empty, Edit material. Facts (stock, on spools, loose, threshold, avg. cost, stock value,
  category, unit, colour/diameter), **Ledger** and the material's **Spools** table.
- Spool detail `/inventory/spools/:id`: header adornment kind + status. Primary: reusable **Change filament** (Needs
  refill: **Fill spool**), single-use **Record consumption**. Overflow: **Finish spool** (single-use) / **Empty spool**
  (reusable), Correct stock, Add identifier, Edit spool, Archive / Restore. Facts include Product and "Fill 4 · since 02.10.2026".
  Sections: Identifiers, **Fill history** (Fill #, Product, Material, Filled, Closed, Used, Leftover → outcome tag, Tags with
  a toggletip list) and Ledger (rows name their fill and material).

**Change filament** (`dialogs/ChangeFilamentModal.tsx`, `ComposedModal` lg, horizontal `ProgressIndicator`, vertical on
narrow screens; one React Hook Form across steps, validation per step):
1. *Spool*: `ComboBox` of reusable, non-archived spools; finds by ID, label, material and identifier values (type or
   scan an NFC UID). Preselected and skipped when opened from a spool.
2. *Leftover* (skipped when the spool needs refill): how much is left (system value / weigh the spool with live tare
   subtraction and "Leftover 37 g (system expected 52 g, difference −15 g recorded as correction)" / nothing, used up)
   and, above zero, what happens to it (return to loose stock = Transfer out of the spool, or dispose = Disposal).
   A difference to the system value is a Correction.
3. *New filament*: Product `ComboBox` (or Not in catalog: material, manufacturer, product), net weight (from the
   product, 1,000 g otherwise), source loose stock / new purchase (total price prefilled with the product's default
   price, needs `inventory.manage`).
4. *Tags*: "Keep on this spool" checkboxes (NFC unchecked, barcode/QR checked by default), repeatable new-identifier
   rows (no duplicates across spools), and a `StructuredList` review of every change and ledger entry.
Saving is one simulated mutation: close fill (history + ledger), start fill n+1, identifiers = kept + new. Mount state is
unchanged. Permission `filament_spools.manage`.

**Finish spool** (`dialogs/FinishSpoolModal.tsx`): the Leftover step alone. Single-use: fill closed, spool archived and
unmounted. Reusable ("Empty spool"): fill closed, status Needs refill, unmounted.

**Cleanup**: "Clean up archived spools" (older than 1 / 3 / 6 / 12 months, default 3) hard-deletes archived
**single-use** spools only, after a danger confirmation that lists the matches. **History rule**: usage history stays on
materials and jobs — ledger entries keep `spoolDisplayId` and `fillNumber` snapshots, job usages keep the spool ID, and any
reference to a missing spool renders as plain text "SP-0155 (deleted)"; a deleted spool's page explains this. Reusable
spools are never deleted automatically.

### Statistics `/statistics`
Header `ContentSwitcher` 30 days · 6 months · 12 months · Custom (date range). Five key figures with change vs.
the previous period of equal length (Jobs, Machine runtime, Customer charges, Material cost, Failure rate in pp).
Charts (lazy-loaded via `React.lazy`, Carbon Charts stay behind the async boundary): Charges vs. material cost
(monthly line, full width), Machine runtime per machine, Material cost by category (€ because units differ),
Losses from corrections and disposal. Each chart has a visually hidden data table. **Per machine** table (jobs,
runtime, failure rate, charges, share of runtime) replaces the separate jobs-per-machine and failure-rate charts.

## 3. Shared contracts (for implementers)

- Data & actions: `useStore()` from `store.tsx`; reads go through `useSimulatedQuery(select, empty)`;
  writes through `useSimulatedMutation(fn)` then `notify({ kind: 'success', title })`.
- Status/format helpers: `derived.tsx`. Loading/error: `components/QueryBoundary.tsx`.
- Permissions: `store.can('machine_jobs.edit')` etc. Hide actions the role cannot perform; never disable
  without explanation.
- Dialog components (named exports):
  - `dialogs/JobFormModal.tsx`: `JobFormModal({ open, onClose, mode: 'create' | 'edit', job?, initialValues?: JobInitialValues, onSaved?: (job: Job) => void })`. `initialValues.usages` prefills material rows (used for prints). Create navigates to the new job unless `onSaved` is given. When the computed end is in the future the form says the job shows as running until then.
  - `dialogs/UsageFormModal.tsx`: `UsageFormModal({ open, onClose, job })`.
  - `dialogs/OverridePriceModal.tsx`: `OverridePriceModal({ open, onClose, job })`.
  - `dialogs/LinkJobModal.tsx`: `LinkJobModal({ open, onClose, print })`; `dialogs/LinkPrintModal.tsx`: `LinkPrintModal({ open, onClose, job })`.
  - `dialogs/MachineFormModal.tsx`: `MachineFormModal({ open, onClose, machine? })`.
  - `dialogs/MachineTypesModal.tsx`: `MachineTypesModal({ open, onClose })`.
- `components/JobsTable.tsx`: `JobsTable({ jobs, hideMachine?: boolean, size?: 'sm' | 'md' | 'lg', title?, emptyState?: ReactNode })`
  — plain sortable DataTable of jobs (columns as in Jobs), row links to detail, responsive.
- Forms: React Hook Form; Carbon inputs only; `useUnsavedChanges` + `UnsavedChangesDialog` from `src/app`
  for larger forms.
