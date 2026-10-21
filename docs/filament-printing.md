# Filament spools and generic printer integration

The filament and printing features extend the existing machine logbook, inventory, pricing, Machine Job, and Order model for one makerspace. They do not introduce a second stock total, billing path, scheduler, slicer, remote-control service, or manufacturer-specific printer protocol.

## Filament inventory

A gram-denominated Material becomes spool-managed when it has a filament diameter. A Filament Spool identifies one physical spool and carries descriptive metadata, lifecycle, scan identifiers, and optimistic versioning. Its remaining quantity is derived from the immutable `inventory_transactions` ledger. The material balance remains authoritative and reports assigned and unassigned quantities.

Registering a new purchase writes the purchase directly to its spool. Registering an already-counted spool writes a zero-value `spool_transfer` that attributes existing unassigned material without changing material quantity or value. Transfers between unassigned stock and spools or between two spools preserve the same invariant. Ledger entries of sold articles (`order_sale`, `order_sale_reversal`) show their order reference in the Reference column, linked to the order for people with `orders.read`; the material's recent consumption (stock hints) counts such sales net of reversals. Consumption and physical corrections update the material balance, spool attribution, weighted-average valuation, ledger, spool version, and audit event in one transaction.

Spool scan identifiers support barcode, QR, and NFC values. Open assignments prevent one spool from being mounted in multiple printer slots. Archived or empty spools cannot be mounted. Inventory transactions are immutable after insertion, except that privacy-preserving account and machine-usage references may detach during genuine hard deletion.

Material usage on a machine run now distinguishes makerspace and external filament. Makerspace usage must reference a Material and may reference a Spool; it consumes inventory and participates in material pricing. External usage carries a description, never references a Spool, does not change inventory, and does not add a makerspace material charge. Every usage records whether its quantity is actual or estimated. Order snapshots use schema version 2 for these facts while readers remain compatible with version 1 snapshots.

## Spools, fills, and kinds

A **spool** is the physical holder; a **fill** is one load of filament on it. Every spool has numbered fills (fill 1, 2, ...) with their own material, manufacturer snapshot, initial net weight, identifiers, and, once closed, the leftover and its outcome (used up, returned to stock, or disposed). At most one fill is open. The ledger and job usages record the spool display ID and fill number as snapshots next to the foreign keys.

- **Kind:** **single_use** spools hold one fill and are archived when finished. **reusable** spools can be refilled and may optionally have a label. A reusable spool can be registered **empty** (no fill) and loaded later; single-use spools cannot.
- **Lifecycle:** **active** or **archived** (`archivedAt` is set exactly when archived; the former `retired` state became `archived` in migration 00038). Whether a spool is loaded follows from its open fill.
- **Stock split:** the material balance is the sum of filament **on spools** (open fills) and **loose** stock (the unassigned remainder). Signed `spool_transfer` entries move quantity between loose stock and a fill without changing material quantity or value.

All three operations below require `filament_spools.manage` and `inventory.manage`, check the spool's expected version, and commit ledger, spool, identifier, and audit changes in one transaction. The leftover is given as **system** (keep the recorded quantity), **weighed** (gross weight minus the tare; the difference is written as a correction), or **none** (write the remaining quantity off as used up). A remaining quantity above zero needs a disposition of returned to stock or disposed.

- **Change filament** (`POST /filament-spools/{id}/fills`): closes the open fill (correction when weighed or used up, then a transfer of the leftover to loose stock or a disposal), starts the next fill (transfer from loose stock, or a purchase), retires identifiers that are not kept, and adds new ones. Mount state is unchanged.
- **Finish** (`POST /filament-spools/{id}/finish`): closes the open fill with the same leftover entries, unmounts the spool, and archives it when it is single-use. A reusable spool stays active but empty.
- **Cleanup** (`POST /filament-spools/cleanup`): previews (`dryRun`) or hard-deletes archived single-use spools older than 1, 3, 6, or 12 months with no open fill. Only listed IDs that are still candidates are deleted. Fills, identifiers, and mount history cascade; ledger entries and job usages keep their spool display ID and fill number snapshots, so material history survives. This is a genuine hard-deletion path.

## Filament articles (no product catalog)

The former `/filament-products` catalog was removed in migration 00056. A filament **article** (a material whose type has kind `filament`) carries the manufacturer, variant, package size (for example 1000 g per roll), sale price and storage location itself; filament articles always have a filament diameter (1.75 mm by default), and only they can be put on spools (409 `material_not_filament` otherwise). **Snapshot rule:** a fill copies the manufacturer when it starts (the explicit value, else the article's) and the optional product name, so later edits never rewrite history. The migration folded the old products into their article where unambiguous: manufacturer from the products (else from the fills) when exactly one distinct value exists, package size when all products share one net weight. Job pricing uses the material's type (`/material-types`), and the material's colour is the only colour staff enter. Spools display their material's colour and never hold their own.

### Receiving filament

`POST /inventory/receipts` (see [machine-logbook.md](machine-logbook.md#receiving-stock)) places filament in one of three ways: `storage` (loose stock), `new_spools` (one new single-use spool per package, fill 1 bought directly onto it, the total price split in whole cents with the remainder on the last spool), or `reusable_spool` (one package onto an active reusable spool without an open fill; 409 `spool_already_loaded` when it holds a fill). Spool placements also need `filament_spools.manage`. Identifiers (barcode, QR, NFC) are only accepted when exactly one spool is created or loaded.

### Inventory UI

The Inventory page (`/machine-logbook/inventory?tab=filament|consumables|parts|spools`) has one Carbon data table per article kind. The page header offers **Receive stock** (`inventory.manage`) and an overflow menu with **New article** (describe an article without stock) and **Types & categories** (material types of filament and consumables, categories of parts). **Receive stock** is one dialog: pick an existing article or describe a new one (a missing material type can be created from the type combo box), enter packages and package size, price, supplier, date and reference, and for filament choose *In storage*, *On new spools (one per package)* or *Load onto a reusable spool*; the spool options need `filament_spools.manage`. On an article page the same dialog opens with the article preselected. **Register spool** (spools tab or article page) only registers a physical spool from loose stock or as an empty reusable spool; **Change filament** stays on the spool.

## Gated by process

Everything on this page exists for machines whose machine type has the **FDM printing** process (`fdm_printing`, see [Processes](machine-logbook.md#processes)): the printer setup and wizard, connector assignments, spool inputs and mounting, artifacts, live status and reported grams. Other processes (embroidery, UV printing, cutting, other) have no printer setup; the backend answers `409 machine_not_fdm_printing` when one is requested, and the frontend neither shows the printer tab nor the wizard steps for them. Spool logic stays filament-only (grams).

## Generic printer topology

A printer profile attaches to an existing Machine. It contains ordered input units and slots, such as a direct feed or multi-material unit. Staff can explicitly mount and unmount spools. The assignment table retains mount history and enforces one open assignment per slot and spool.

The topology remains intentionally generic. It stores stable external identifiers without putting Bambu-specific semantics into Core. The H2D and X1C connectors map observational AMS unit/tray identifiers onto this topology. Exact-RFID auto-detection is disabled by default; when enabled on an assignment, an exact configured unit/tray plus an existing active NFC identifier may create or move only a connector-reconciled mount. Two consecutive tag-absent observations may close that connector-created mount. It never changes a manual mount or creates a spool/tag from telemetry, and material, color, `tray_uuid`, and remaining percentage are never identity or stock authority. Core performs no printer discovery, slicing, scheduling, or physical start/pause/stop operation.

Artifact filament quantities remain plans until a recorded run reaches a terminal outcome. The active run page can present `~used / planned` from parsed planned grams and live printer progress, but that approximation is display-only and never reaches the ledger. Successful runs may use complete slicer-estimated grams. Interrupted runs use the latest conservative parsed G-code checkpoint consistent with reliable layer/progress evidence; they never multiply total weight by MQTT percentage for inventory. Model, purge/loading, and unclassified extrusion remain separate provenance while inventory uses their defensible total. Missing density/diameter and missing slicer normalization data produce an unresolved estimate for staff correction rather than invented stock use. A later connector revision compensates once, while a staff correction remains authoritative.

## Print submissions and attempts removed

Print submissions, print attempts, filament declarations, printer-event reconciliation, and the printing-operation idempotency records were removed with their tables and `/print-submissions` and `/print-attempts` endpoints. Printer connectors report recorded runs, which staff attach to or create [jobs](machine-logbook.md#jobs-and-runs) from.

Normalized connector events use a versioned source ID and event key. Repeating identical facts is idempotent; reusing the key for different facts is rejected. A consumption report becomes the run's reported usage and is consumed when the run ends; a later revision replaces it without double counting, keeping the source-event reference on the usage. The inventory entries, pricing recalculation, and audits commit in one database transaction.

## Permissions and routes

The feature adds `filament_spools.manage` and `printer_slots.assign`. Services enforce these permissions; frontend gating is only presentation.

OpenAPI defines `/filament-spools`, material spool transfers, printer profiles/input units/slots. The Carbon UI exposes spools, change filament, finish, and cleanup under Inventory and printer topology from Machines. All pages remain route-lazy-loaded.

Migrations `00032_filament_spools.sql` and `00033_printing.sql` contain downgrade guards. A downgrade stops when spool, printing, or version-2 financial snapshot history exists rather than silently discarding it. The downgrade of `00038_spool_fills_products.sql` restores the single-material spool model from each spool's latest fill; older fills with another material cannot be represented. The downgrade of `00056_inventory_articles.sql` refuses while part types, article variants, sale prices or purchase references exist and otherwise rebuilds one product per filament article that has a manufacturer and package size.
