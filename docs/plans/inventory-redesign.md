# Inventory redesign

Branch `worktree-feat-inventory-redesign`. Status: phases 1–4 and follow-ups implemented (migrations 00056, 00057); awaiting review and merge into main.

## Problem

Registering one filament spool today takes four to five forms (material type → material → product → spool → identifiers). Unit, weight, price, supplier, manufacturer and the material are entered again in several of them. There is no place for ordinary stock (screws, heat-set inserts, bike chains, brake calipers), and nothing from stock can be sold in an Order.

## Model

One concept for everything that is counted: the **article** (the existing `materials` table, extended; renaming the table would churn every query for no gain). Every article has a **kind**:

| Kind | Examples | Material type | Unit | Used by |
|---|---|---|---|---|
| `filament` | PLA Basic Black, Bambu Lab | required, process FDM | g | runs on FDM printers, spools |
| `consumable` | Acrylic 3 mm clear, Vinyl foil matte red, embroidery thread | required, its processes (laser, vinyl, UV, embroidery, other) | type's unit | runs on those machines |
| `part` | M3 heat-set insert, 8-speed chain, Shimano brake caliper | none | piece, m, … | orders, stock only |

Fields on the article:

- **Material type** (PLA, PETG, ABS, Acrylic, Vinyl foil …): kept, still the level material prices attach to. Created inline from the article form (combo box) instead of in a separate tab first.
- **Variant** (new, free text with suggestions per type): Basic, Matte, Silk, High Flow, CF, GF, 3 mm, 40 wt …
- **Colour** name + hex (existing).
- **Manufacturer** (new; moves here from products/fills).
- **Category** (parts): the material type of a part article. Material types get a `kind` (filament, consumable, part); part types (Fasteners, Bike, Electronics …) have a unit but no processes, so they can never be used in a machine run, and are shown as "Category" in the UI. This keeps `material_type_id` mandatory on every article.
- **Sale price** per unit (new, optional): default unit price when the article is sold in an Order.
- **Default package size** (new, optional): e.g. 1000 g per roll, 100 pieces per bag; prefills receiving stock.
- **Storage location** (new, optional), low-stock threshold (existing), filament diameter (existing, filament only), notes, active.
- **Name**: generated from type · variant · colour · manufacturer for filament and consumables ("PLA Basic · Black · Bambu Lab"), entered for parts. Unique ignoring case, so the generated name also prevents duplicates: entering the same combination finds the existing article.

**Removed:** the filament product catalog (`filament_products`, `/filament-products`, Products tab). Manufacturer, package size and price live on the article; fills keep their manufacturer snapshot. Existing products are folded into their material during migration (manufacturer/package size/price copied where a material has exactly one product; otherwise left for staff).

**Kept (backend), simplified (UI):** spools and fills. A spool is the physical carrier (reusable, or single-use = came with the roll); a fill is what is on it. The UI talks about "on spool S-2026-000012" or "in storage" and "load filament onto spool", not about fills.

**Purchases** stay ledger entries (`purchase`) with supplier ("where"), total price ("how much"), date and an optional reference (order no.). Weighted-average valuation is unchanged.

## One form: Receive stock

`POST /inventory/receipts` — one transaction, one audit event:

1. **What**: pick an existing article, or describe it (kind, type, variant, colour, manufacturer …); an existing match is shown and reused.
2. **How much**: count × package size (e.g. 3 rolls × 1000 g, 2 bags × 100 pcs), or a total quantity.
3. **Bought where, for how much**: supplier (suggestions from earlier purchases), total price, date, reference.
4. **Where it goes** (filament only): in storage (loose), each roll on its own new single-use spool, or one roll loaded onto an empty reusable spool. Optional NFC/barcode per new spool.

Stock moves on the article page stay (consume, correct, dispose, mark empty) and spool pages keep change filament, finish and cleanup.

## Inventory page

Tabs **Filament · Consumables · Parts · Spools**, each a Carbon DataTable with search and filters (type, variant, colour, manufacturer, process, category, low stock). Primary action "Receive stock"; "New article" only for describing an article without stock. Material types stay manageable in a small settings dialog (rename, unit, processes, delete when unused) instead of a top-level tab.

## Selling from stock (Orders)

New order item kind `inventory_item`: article, quantity, unit, unit price (prefilled from the sale price, editable by `orders.write`), amount rounded like manual items. The item snapshots the article name and unit. Stock is consumed with a new ledger kind `order_sale` (at average cost) and returned with `order_sale_reversal` when the Order is reversed. Adding the item needs `orders.write` and `inventory.read`; the consumption itself is part of the Order operation, so no `inventory.manage` is needed.

## Phases (commit per phase)

1. Migration + backend: article kind/variant/manufacturer/category/sale price/package size/location, products folded in and removed, receipts endpoint, OpenAPI, integration tests.
2. Orders backend: `inventory_item` lines, stock consumption and reversal, tests incl. authorization.
3. Inventory frontend: new tabs, receive-stock flow, article and spool pages, type settings dialog.
4. Orders frontend item picker, docs (`filament-printing.md`, `machine-logbook.md`, `orders.md`), e2e, bundle budget check.

## Decisions

Taken 2026-10-21:

- I1: Material prices stay per material type; the variant is descriptive only. A differently priced material (e.g. PLA-CF) is its own type.
- I2: Selling from stock consumes on Order finalization; reversal returns the stock. Finalization is refused with `409 insufficient_stock` when the balance does not cover the line.
- I3: The filament product catalog is removed; its data folds into the article where unambiguous.
- I4: Built directly (no prototype), phase by phase, commit per phase, ask before each next phase.
