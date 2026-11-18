# PDF templates

The three PDFs of the system are rendered from editable templates: the **wiRef invoice request** (mail attachment and settings preview), the **cashbook** (the HTU Kassabuch sheet of the cashbook export) and the **receipt** of an order. Without a published template each export uses a built-in default that reproduces the PDFs of release 0.19 (the receipt is new). The editor is under Settings › PDF templates; the contract is the tag "PDF Templates" in `api/openapi.yaml`.

## Concepts

- **Document.** A template is a JSON document (`schemaVersion` 1): page set-up, document styles (colours, text styles, sizes), fixed-position layers and the header, body and footer block lists. It is decoded strictly (unknown properties, wrong types and out-of-range values are `422 pdf_template_invalid` with the violations); the model, expression language and renderer are the pure package `backend/internal/pdftemplates/engine`.
- **Versions.** Per export there is at most one **draft** and one **published** version; older published versions are **archived**. Saving replaces the draft (`PUT .../draft`, `expectedRevision` guards against concurrent saves, `409 stale_write`), publishing turns the draft into the published version and archives the previous one, restoring copies any version into the draft, discarding deletes the draft. No stored version means the built-in default is in effect ("reset to default" is discarding the draft and publishing the built-in document).
- **Problems.** `engine.Check` reports `error` and `warning` problems per node (unknown variable or filter, dangling style reference …). A draft may be saved with problems; publishing is refused with `422 pdf_template_has_problems` while an error exists.
- **Effective template.** `pdftemplates.Service.Effective` returns the published document, else the built-in one (the wiRef default takes the branding primary colour as its `accent` colour). `RenderEffective` renders data with it; the real exports call it: `invoicing` for the mail attachment and the settings preview, `orders.ExportCashbook` for the PDF and `orders.ReceiptPDF`. A stored document the engine can no longer read falls back to the built-in default (logged without content).
- **Images.** PNG, JPEG and SVG (paths only) up to 2 MiB, at most 100 images, stored in the database. The type is sniffed from the content. An image used by the draft or the published version cannot be deleted (`409 pdf_template_asset_in_use`).

## Permissions and audit

Every operation needs `pdf_templates.manage`; the role holder is a deliberate choice, no role has it by default (master holds every permission). A preview with a real record additionally needs the permission of the export: wiRef `external_invoice_requests.read`, cashbook `payments.read` and `cash_movements.read`, receipt `orders.read`. The renderer receives the caller's permissions: a variable that needs a permission the reader lacks (`lines[].customer`, `lines[].orderSummary`: `orders.read`; `order.customer.matriculationNumber`: `people.read.matriculation`) renders empty and is listed in `redacted`. Sample previews show every field. The wiRef mail is a system rendering: its schema has no sensitive fields. The receipt PDF endpoint needs `orders.read` and leaves the matriculation number out without its permission.

Audit events (same transaction as the change): `pdf_template.draft_saved`, `.draft_discarded`, `.published`, `.restored`, `pdf_template_asset.uploaded`, `.deleted`. Details are the export kind, the version number and an asset id, never document content.

## Security model

Template text is data: values are inserted as plain text and never interpreted again; the expression language is closed (no arithmetic, no calls except the filters). Size limits: document 256 KiB, 500 nodes, nesting 16, text 4000 characters per field, 300 pages, 10 s render deadline, 20 MiB output (`pdf_template_too_large`, `pdf_render_limit`). Uploaded SVGs are reduced to their path outlines; asset downloads carry `Content-Security-Policy: default-src 'none'; sandbox` and `nosniff`. Template text, data values and rendered output are never logged.

## Data per export

The authoritative list, with descriptions and examples, is `engine.Schema(kind)` (returned by `GET /pdf-templates/{export}` as `schema`); tests assert that the data built by the owning packages matches it exactly (`pdftest.AssertData`). Always available: `makerspace.name|displayName|address|logo`, `generatedAt`, `page`, `pages` and the form-table locals `sheet.*`.

- **wiref** (built by `invoicing.Document.PDFData`): `request.*` (number, orderNumber, approvedAt, approver, servicePeriod.from/to, serviceDescription), `recipient.*`, `amounts.total|alreadyPaid|toInvoice`, `texts.title|intro|closing` (the PDF texts of the wiRef settings with their `{{placeholders}}` already filled in), `show.*` ("true" or empty for the optional parts the settings switch on), lists `items[]` and `payments[]`. The settings page keeps these texts; its PDF section links to the editor.
- **cashbook** (built by `orders.cashbook.pdfData`): `period.*`, `organization.*`, `totals.*` (opening and closing empty for an export of all payments), list `lines[]` with `text` (the German description as on the paper form), `orderSummary` and `customer` (only with `orders.read`), `in`, `out`, `balance`. The default file name is `cashbook-<from>-<to>.pdf`.
- **receipt** (built by `orders.receiptData`): `order.*` (number, createdAt, customer.name, customer.matriculationNumber, total, paid, open), `payment.*` (only for the receipt of one payment), lists `items[]` and `payments[]`.

Previews of real records offer the last 10 approved wiRef requests, the last 3 calendar months of the cash register and the last 10 finalized orders with a receipt.

## Receipt PDF

`GET /orders/{orderId}/receipt.pdf?paymentId=` (`orders.read`) renders the effective receipt template for a finalized order with a settled amount (`409 receipt_not_available` otherwise); `paymentId` must be a payment that still counts towards the order (404 otherwise). The receipt page offers it as "Download PDF" next to Print.
