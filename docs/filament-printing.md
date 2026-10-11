# Filament spools and generic printer integration

The filament and printing features extend the existing machine logbook, inventory, pricing, Machine Job, and Order model for one makerspace. They do not introduce a second stock total, billing path, scheduler, slicer, remote-control service, or manufacturer-specific printer protocol.

## Filament inventory

A gram-denominated Material becomes spool-managed when it has a filament diameter. A Filament Spool identifies one physical spool and carries descriptive metadata, lifecycle, scan identifiers, and optimistic versioning. Its remaining quantity is derived from the immutable `inventory_transactions` ledger. The material balance remains authoritative and reports assigned and unassigned quantities.

Registering a new purchase writes the purchase directly to its spool. Registering an already-counted spool writes a zero-value `spool_transfer` that attributes existing unassigned material without changing material quantity or value. Transfers between unassigned stock and spools or between two spools preserve the same invariant. Consumption and physical corrections update the material balance, spool attribution, weighted-average valuation, ledger, spool version, and audit event in one transaction.

Spool scan identifiers support barcode, QR, and NFC values. Open assignments prevent one spool from being mounted in multiple printer slots. Retired, missing, or empty spools cannot be mounted. Inventory transactions are immutable after insertion, except that privacy-preserving account and machine-usage references may detach during genuine hard deletion.

Machine Job usages now distinguish makerspace and external filament. Makerspace usage must reference a Material and may reference a Spool; it consumes inventory and participates in material pricing. External usage carries a description, never references a Spool, does not change inventory, and does not add a makerspace material charge. Every usage records whether its quantity is actual or estimated. Order snapshots use schema version 2 for these facts while readers remain compatible with version 1 snapshots.

## Generic printer topology

A printer profile attaches to an existing Machine. It contains ordered input units and slots, such as a direct feed or multi-material unit. Staff explicitly mount and unmount spools. The assignment table retains mount history and enforces one open assignment per slot and spool.

The topology is intentionally generic. It stores stable external identifiers for a future connector but contains no Bambu-specific semantics and performs no printer discovery, slicing, scheduling, file transfer, start, pause, or stop operation.

## Print submissions and attempts

Staff with `print_submissions.manage` create a Print Submission for a configured printer and may declare makerspace or external filament estimates. Starting or retrying creates a numbered Print Attempt and copies the declarations as an attempt snapshot. Attempt transitions are explicit and version-checked: queued, accepted, printing, then completed, failed, or cancelled. An attempt may link to one existing Machine Job for operational and charge traceability.

Normalized connector events use a versioned source ID and event key. Repeating identical facts is idempotent; reusing the key for different facts is rejected. Consumption reports remain pending until staff accepts or rejects them. Acceptance replaces the linked confirmed Machine Job usages. The event decision, compensating and new inventory entries, pricing recalculation, source-event references, operation idempotency record, and audits commit in one database transaction.

No public connector ingestion route is exposed yet. `printing.Service.IngestEvent` is the internal boundary for a future authenticated connector. Adding one requires a deliberate service/device identity and protocol design without weakening the staff session endpoints.

## Permissions and routes

The feature adds `filament_spools.manage`, `printer_slots.assign`, `print_submissions.read`, and `print_submissions.manage`. Services enforce these permissions; frontend gating is only presentation.

OpenAPI defines `/filament-spools`, material spool transfers, printer profiles/input units/slots, `/print-submissions`, attempts, job links, and printer-event reconciliation. The Carbon UI exposes spool list/detail flows under Inventory, printer topology from Machines, and staff submissions under Machines. All pages remain route-lazy-loaded.

Migrations `00032_filament_spools.sql` and `00033_printing.sql` contain downgrade guards. A downgrade stops when spool, printing, or version-2 financial snapshot history exists rather than silently discarding it.
