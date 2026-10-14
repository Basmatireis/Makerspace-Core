# Filament spools and generic printer integration

The filament and printing features extend the existing machine logbook, inventory, pricing, Machine Job, and Order model for one makerspace. They do not introduce a second stock total, billing path, scheduler, slicer, remote-control service, or manufacturer-specific printer protocol.

## Filament inventory

A gram-denominated Material becomes spool-managed when it has a filament diameter. A Filament Spool identifies one physical spool and carries descriptive metadata, lifecycle, scan identifiers, and optimistic versioning. Its remaining quantity is derived from the immutable `inventory_transactions` ledger. The material balance remains authoritative and reports assigned and unassigned quantities.

Registering a new purchase writes the purchase directly to its spool. Registering an already-counted spool writes a zero-value `spool_transfer` that attributes existing unassigned material without changing material quantity or value. Transfers between unassigned stock and spools or between two spools preserve the same invariant. Consumption and physical corrections update the material balance, spool attribution, weighted-average valuation, ledger, spool version, and audit event in one transaction.

Spool scan identifiers support barcode, QR, and NFC values. Open assignments prevent one spool from being mounted in multiple printer slots. Archived or empty spools cannot be mounted. Inventory transactions are immutable after insertion, except that privacy-preserving account and machine-usage references may detach during genuine hard deletion.

Material usage on a machine run now distinguishes makerspace and external filament. Makerspace usage must reference a Material and may reference a Spool; it consumes inventory and participates in material pricing. External usage carries a description, never references a Spool, does not change inventory, and does not add a makerspace material charge. Every usage records whether its quantity is actual or estimated. Order snapshots use schema version 2 for these facts while readers remain compatible with version 1 snapshots.

## Spools, fills, and kinds

A **spool** is the physical holder; a **fill** is one load of filament on it. Every spool has numbered fills (fill 1, 2, ...) with their own material, product snapshot, initial net weight, identifiers, and, once closed, the leftover and its outcome (used up, returned to stock, or disposed). At most one fill is open. The ledger and job usages record the spool display ID and fill number as snapshots next to the foreign keys.

- **Kind:** **single_use** spools hold one fill and are archived when finished. **reusable** spools can be refilled and may optionally have a label. A reusable spool can be registered **empty** (no fill) and loaded later; single-use spools cannot.
- **Lifecycle:** **active** or **archived** (`archivedAt` is set exactly when archived; the former `retired` state became `archived` in migration 00038). Whether a spool is loaded follows from its open fill.
- **Stock split:** the material balance is the sum of filament **on spools** (open fills) and **loose** stock (the unassigned remainder). Signed `spool_transfer` entries move quantity between loose stock and a fill without changing material quantity or value.

All three operations below require `filament_spools.manage` and `inventory.manage`, check the spool's expected version, and commit ledger, spool, identifier, and audit changes in one transaction. The leftover is given as **system** (keep the recorded quantity), **weighed** (gross weight minus the tare; the difference is written as a correction), or **none** (write the remaining quantity off as used up). A remaining quantity above zero needs a disposition of returned to stock or disposed.

- **Change filament** (`POST /filament-spools/{id}/fills`): closes the open fill (correction when weighed or used up, then a transfer of the leftover to loose stock or a disposal), starts the next fill (transfer from loose stock, or a purchase), retires identifiers that are not kept, and adds new ones. Mount state is unchanged.
- **Finish** (`POST /filament-spools/{id}/finish`): closes the open fill with the same leftover entries, unmounts the spool, and archives it when it is single-use. A reusable spool stays active but empty.
- **Cleanup** (`POST /filament-spools/cleanup`): previews (`dryRun`) or hard-deletes archived single-use spools older than 1, 3, 6, or 12 months with no open fill. Only listed IDs that are still candidates are deleted. Fills, identifiers, and mount history cascade; ledger entries and job usages keep their spool display ID and fill number snapshots, so material history survives. This is a genuine hard-deletion path.

## Filament product catalog

`/filament-products` holds manufacturer, name, material, net weight, default price, packaging (**refill** or **spool**), notes, and an active flag. Reads need `inventory.read`; writes need `inventory.manage`. Manufacturer and name are unique ignoring case. Products can be edited or deactivated. **Snapshot rule:** a fill copies manufacturer and product name when it starts and keeps an optional product reference that is cleared if the product is removed, so catalog edits never rewrite history. The product's material remains the single source for stock and job pricing.

## Generic printer topology

A printer profile attaches to an existing Machine. It contains ordered input units and slots, such as a direct feed or multi-material unit. Staff explicitly mount and unmount spools. The assignment table retains mount history and enforces one open assignment per slot and spool.

The topology is intentionally generic. It stores stable external identifiers for a future connector but contains no Bambu-specific semantics and performs no printer discovery, slicing, scheduling, file transfer, start, pause, or stop operation.

## Print submissions and attempts removed

Print submissions, print attempts, filament declarations, printer-event reconciliation, and the printing-operation idempotency records were removed with their tables and `/print-submissions` and `/print-attempts` endpoints. Printer connectors report recorded runs, which staff attach to or create [jobs](machine-logbook.md#jobs-and-runs) from.

Normalized connector events use a versioned source ID and event key. Repeating identical facts is idempotent; reusing the key for different facts is rejected. A consumption report becomes the run's reported usage and is consumed when the run ends; a later revision replaces it without double counting, keeping the source-event reference on the usage. The inventory entries, pricing recalculation, and audits commit in one database transaction.

## Permissions and routes

The feature adds `filament_spools.manage` and `printer_slots.assign`. Services enforce these permissions; frontend gating is only presentation.

OpenAPI defines `/filament-spools`, material spool transfers, printer profiles/input units/slots. The Carbon UI exposes spools, products, change filament, finish, and cleanup under Inventory and printer topology from Machines. All pages remain route-lazy-loaded.

Migrations `00032_filament_spools.sql` and `00033_printing.sql` contain downgrade guards. A downgrade stops when spool, printing, or version-2 financial snapshot history exists rather than silently discarding it. The downgrade of `00038_spool_fills_products.sql` restores the single-material spool model from each spool's latest fill; older fills with another material cannot be represented.
