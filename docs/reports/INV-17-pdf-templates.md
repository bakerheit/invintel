# INV-17: custom PDFs with templates (letterhead, logo, four documents, per-customer look)

Owner: Eli. Branch: `inv-17/pdf-templates` (on main with INV-16). Scope per Gus: all four documents, settings per type (logo, colours, address, columns, terms), live preview, per-customer override, PDFs attached by the email bridge, strict logo limits (png/jpg only, small, no SVG). Andrew raised the need; he hasn't picked the order of documents, so this covers all four; adjust if he does.

## What it does

- **Letterhead and templates** (`Settings > Documents`): company name, address (up to 5 lines), phone, email, website, tax/registration number, paper (A4 or US Letter); invoices: tax name and rate (hundredths of a percent) and days to pay. Per document kind: title, accent colour (six presets or any `#RRGGBB`), show the logo, which columns, terms, a footer on every page. Members can read, admins change; every save is audited ("Changed the letterhead, the invoice template").
- **Live preview.** `POST /documents/preview` draws a sample (fictional) document with the values on the screen, saved or not; the page redraws it a moment after typing stops and changes nothing until Save.
- **Per-customer (or supplier) look.** A trading partner can override title, colour, show-logo, columns, terms and footer for each kind (UI: title, colour, terms). Precedence: kind defaults < organization template < partner override. Checked like the organization's.
- **Four documents** (pure builders in `doc-render.ts`, one layout engine in `doc-pdf.ts`): purchase order, order confirmation, packing slip, invoice. Long tables continue with the header repeated, "Page n of N" on every page, long descriptions wrap (3 lines max), long titles shrink or wrap beside the letterhead, a long contact line wraps. Hostile text (parentheses, backslashes, control characters, emoji) can't break the file.
- **Logo** (`image.ts`): PNG or JPEG only, <= 300 KB, <= 1500 px each way, decided by the bytes. PNGs are fully decoded (CRCs, chunk order, size and inflate caps) and rewritten as plain RGB or grey pixels with transparency flattened onto white; 8-bit only; palettes of 1/2/4/8 bits; interlaced and 16-bit are refused with a reason. JPEGs are structure-checked and embedded as they are (8-bit grey or RGB; CMYK, 12-bit, lossless/arithmetic refused). Served back as an inert image.
- **Invoices from shipments.** `GET /sales/orders/:id/shipments/:n/invoice.pdf` (admin) makes the invoice the first time (INV-0001.., one per shipment, from the order's prices, tax per the letterhead, due date per terms) and stores it exactly as issued; later requests and emails use that stored invoice, so a later tax-rate change can't alter it. Racing requests get the same invoice. Tax is integer math (BigInt).
- **Sales order screen.** Order confirmation (PDF) and "Email it to <customer>"; per shipment: Packing slip, Invoice (or Make invoice) and "Email invoice" where the customer's partner can receive them (`sendDocs`).
- **Email bridge attachments.** Purchase order (now drawn with the letterhead/templates), the **packing slip on every ship notice**, and on request an **order confirmation** and an **invoice**, each with a plain-text body. An X12 customer gets the invoice as an 810 (same numbers). Each document is sent once (the same one twice is the same message; a changed order is a new confirmation).
- **PO preview** in the order dialog is the same document the supplier gets.
- **Demo**: Demo Corrugated Co. has a letterhead, a small logo and blue invoice/slate PO templates.

## How to try it

`pnpm --filter @invintel/api seed:demo`, sign in, **Settings > Documents** (change the title or colour: the preview redraws; pick another document tab). **Sales > SO-0002**: Order confirmation, Packing slip, Make invoice, Email invoice (Bluebird is an email test partner; the email lands in the outbox folder `INVINTEL_OUTBOX_DIR`). **Documents > Partners > Bluebird > Document look** to give one customer their own title and terms.

## Decisions I made

- **Settings, not a template language.** Safe by construction (no code, no markup), covers what small businesses ask for. HTML or visual editors can come later behind the same `DocSpec` layout.
- **PNG is re-encoded, JPEG passes through.** Re-encoding PNG takes the attacker's bytes out of the PDF; there is no JPEG encoder in Node's standard library, so a JPEG is validated and embedded as it is (the viewer decodes it).
- **Helvetica only.** Latin-1 text (accents, euro) works; other scripts print as "?" until a font is embedded (needs a font with a licence we can ship).
- **Invoice = a document, not a ledger.** Numbered per shipment from the order's own prices. Payment tracking, credit notes, multiple currencies and tax per line belong with accounting (Will's INV-11 is the supplier side).
- **Bridges ask for their context** through a loader the app registers (bridges can't reach the database): a bare test with no app falls back to the plain look.

## Tests

`documents.test.ts` (28): logos (every PNG colour type and filter decoded exactly, transparency, palettes, a colour key, the damage and unsafe cases each with its reason, a 50 MB inflate bomb refused in under 2 s, JPEG structure cases, SVG/GIF/script/empty/too big, 600 random mutations that never throw); the PDF writer (valid cross-reference offsets for A4 and Letter, colours, images, WinAnsi, real widths, wrapping and breaking, ellipsis); layout (120-row table across pages with header repeated and page numbers, every row once; the template applied; columns; logo on/off; paper size; long contact and long titles; hostile text); settings (defaults, roles, validation of every field, audit, logo upload/replace/remove and serving headers, refusal reasons, the preview for all four kinds with unsaved values and no side effects, other organizations); sales documents (letterhead, taxes, packing slip quantities, an invoice kept as issued after a tax change, numbering, concurrent requests, exact tax arithmetic); per-customer override; email attachments (PO, packing slip, confirmation, invoice with the customer's title and terms, never twice, the X12 810, nothing for a name-only customer or an inbox-only partner). Whole API suite 436, web 20, typecheck and build green. Clicked through in a browser at desktop and 375 px: Settings > Documents with logo and live preview, changing title and colour, Sales documents, emailing an invoice (PDF in the outbox), the partner override, and each PDF opened in the browser's viewer (found and fixed a long title running over the logo and a truncated contact line).

## Known limits

- Not in the data archive: the letterhead, templates and logo are not exported/restored yet (they are organization settings and a logo file).
- Customers have no address in Invintel yet, so confirmations, packing slips and invoices show only the customer's name (an address on the trading partner would fix that).
- Partner overrides in the UI cover title, colour and terms (the API also takes columns, footer and show-logo).
- One logo per organization (not per document kind); one currency; no per-line tax.
