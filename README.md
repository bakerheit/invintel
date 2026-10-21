# Invintel

Open source inventory management, built by Bakerheit Technologies.

**Status: early (0.x) software.** It is built and tested in a demo setting, with no production customers yet. Invintel makes no compliance or certification claims (no SOC 2, ISO, GDPR, FDA/FSMA or EDI conformance claims); the "known limits" sections below say what is and isn't done. See [SECURITY.md](SECURITY.md) for reporting problems, [CONTRIBUTING.md](CONTRIBUTING.md) for how to take part, and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the licences of what it builds on.

## Stack

| Layer    | Tech |
| -------- | ---- |
| Frontend | Vite, React 19, TypeScript, Zustand, shadcn/ui (Tailwind v4), TanStack Table, TanStack Query |
| Backend  | Hono, MongoDB (official driver), argon2 password hashing, Zod |
| Shared   | `@invintel/shared`: Zod schemas and types used by both sides |

pnpm workspace layout:

```
apps/api         Hono REST API + MongoDB
apps/web         Vite React app
packages/shared  Zod schemas + shared types
```

## Getting started

```bash
cp .env.example .env     # optional, defaults work for local dev
docker compose up -d     # MongoDB on localhost:27017
pnpm install
pnpm dev                 # api on :3001, web on :5173 (proxies /api)
```

Open http://localhost:5173 and create an account. At sign-up you either **create an organization** or **join one with a code** (a radio toggle swaps the organization name field for a join code field). Indexes are created on API startup.

### Organizations, locations and stock

- A user can belong to several organizations and switch between them from the header. "Create or join another…" adds more.
- Everything is scoped to an organization: items, locations, stock and history live under `/api/orgs/:orgId/…`. Non-members get a 404, and the same SKU can exist in two organizations.
- Roles: **owner** (whoever created it), **admin**, **member**. Joining by code makes you a member. Admins and owners can add, rename and delete locations, see and rotate the join code, and rename the organization. Members can manage inventory and read everything else. The owner can make a member an admin (and back) from Settings > Members, admins can remove members, the owner can remove admins, and anyone can leave. The owner can't be demoted or removed, and ownership isn't transferable yet.
- Every new organization starts with one location called "Main".
- Stock is tracked per item per location. An item's quantity is the sum across locations. You can adjust stock at a location, move stock between locations, and filter the inventory table by location.
- A location can't be deleted while it still holds stock.
- Join codes are 8 characters (no look-alike letters), shown as `ABCD-EFGH`. Rotating one invalidates the old code. Wrong guesses are rate limited.
- Stock history records who made each change.

### Overview

The landing page (`/o/:orgId`) answers "what needs attention?": items out of stock or at their reorder level, units still sitting in receiving (waiting to be put away), stock by kind of place (receiving, storage, at the machines, finished goods...), and the latest ledger entries. It comes from one call, `GET /api/orgs/:orgId/overview`. The item list moved to `/o/:orgId/inventory`.

### Ledger, locations and floor mode

- **Activity** is the stock ledger. Every receipt, move and adjustment is an immutable entry with who, when and why. Nothing is edited: mistakes are **reversed**, which adds a matching entry and marks the original. Admins can reverse any entry; members can reverse their own for 15 minutes. A reversal that would take stock below zero is refused. Reversing one half of a move reverses both.
- **Locations** nest (up to 6 levels) and have a **type** (receiving, storage, work in progress, production, finished goods, shipping) and an optional scannable **code**. Filtering by a location includes everything inside it.
- **Floor mode** (`/o/:orgId/floor`, also in the sidebar) is a full-screen, big-target UI for the plant floor: **Receive**, **Move**, and **Look up**. A scanner types the code and presses Enter; the scan field stays focused and suppresses the on-screen keyboard unless you tap the keyboard button. Items resolve by SKU, locations by code or name. Each flow ends with a result screen and a one-tap **Undo**.
- To use real scanners, print SKUs and location codes as Code 128 (or QR) labels. Most handheld scanners work as a keyboard ("wedge") with Enter as the suffix.

### Features on and off

**Settings > Features** (admins) hides Purchasing and Production for organizations that don't use them: the sidebar entries, the Cmd-K results and the Floor tile all disappear, so a small shop sees inventory and nothing else. No data is touched, and turning one back on brings everything back. While it is off its API answers 403 too, so scripts can't use it either. Changes are in the audit log.

### Counts

**Counts** (sidebar, and **Floor mode > Count**) are cycle counts for one place at a time:

- Anyone can count. On the floor you scan the shelf, scan each item and say how many are there. It is a **blind count**: the floor screen never shows what the system expects, so people count what they see.
- Nothing changes while counting. An admin opens the count on the desk, sees *System says / Counted / Difference / Value* per item (biggest money differences first), can fix a number, and **posts** it. Each difference becomes an ordinary adjustment ("Count CNT-0003") in the ledger, so a wrong one can be reversed in Activity.
- Items in the place that nobody counted are listed; the admin can leave them alone or treat them as zero.
- One open count per place: starting where one is open continues it, so two people at one rack share a sheet. Only an admin or whoever started it can cancel.
- Counts are by quantity. Roll and pallet items are counted by their labels, which isn't built yet.

API under `/api/orgs/:orgId/counts`: `GET /`, `POST /` (`{locationId}`), `GET /:id`, `PUT /:id/lines`, `DELETE /:id/lines/:itemId`, `POST /:id/post`, `POST /:id/cancel`.

### Reports

**Reports** (sidebar) are read-only views of what the ledger and counts already record. New reports register in `apps/web/src/lib/reports.ts`.

- **Stock aging** (`GET /reports/aging`, `/reports/aging.csv`, optional `?locationId=`): days since stock last moved at each place, value tied up, which items sit on an active BOM, buckets from 0-30 days to over a year, and the value idle over 180 days.
- **Counting** (`GET /reports/count-accuracy`, `/reports/count-schedule`): accuracy of posted counts by place, month and item, and an ABC count schedule (A items every 30 days, B every 90, C every 180; a place follows its most important class) with overdue and due-soon flags and a Start count button.

### Approvals

Some actions can need a second person's OK. **Settings > Approvals** (admins) switches on rules for **stock adjustments** and **purchase orders** from a dollar amount up, for members only or for everyone. An action that crosses a rule waits as a request (`APR-0007`) on the **Approvals** page; another admin approves it (it then runs once, as the person who asked, naming the approver) or rejects it with a reason. The asker can't approve their own request unless they are the only admin. Everything is in the audit log. This is a second-person check, not an e-signature system.

API under `/api/orgs/:orgId/approvals`: `GET /rules`, `PUT /rules`, `GET /`, `GET /pending-count`, `POST /:id/approve|reject|cancel`. A gated endpoint answers `202 { approvalRequired, approval }`.

### Downtime and OEE-lite

**Floor mode > Downtime** lets an operator say a machine is down (tap a reason from a short list) and when it is back. **Reports > Downtime and availability** shows, per machine and window (7/30/90 days), minutes down, stops, the biggest reason, a "down now" tag, and a rough **availability** = (scheduled hours - downtime) / scheduled hours. It ignores speed and quality, so it is OEE-lite, not OEE. Admins set the reason list and the scheduled hours per day. One open stop per machine; everything is audited. It lives under the Production feature switch.

API under `/api/orgs/:orgId/production/downtime`: `GET /settings`, `PUT /settings`, `POST /start`, `POST /:id/end`, `GET /` (`?open=1`, `?workCenterId=`), `GET /summary?days=`.

### Alerts and digests

**Alerts** (sidebar, with a count badge) lists what needs attention right now, computed fresh each time from stock, purchase orders, the count schedule and downtime: out of stock, low stock, "runs out in N days" at the last 30 days' production usage, late purchase orders, places overdue for a count, and machines down too long. Anyone can acknowledge (shared, with their name), snooze for 1 or 7 days, or reopen. An acknowledgement belongs to the problem: fix it and it disappears, and if it happens again it is a new alert. The page also shows a **daily digest preview**, the exact text an email or chat message would carry (nothing is sent: that needs an outside account). Admins set the days-of-supply and machine-down thresholds.

API under `/api/orgs/:orgId/alerts`: `GET /`, `GET /digest`, `GET|PUT /settings`, `POST /acknowledge|snooze|reopen` (`{ key }`, snooze also `{ days }`). Every change is in the audit log.

### Colours

The sidebar (and the frame around the page) uses the same gradient as the sign-in page. The account menu (bottom of the sidebar) has a **Colour** choice: Pink (default), Ocean, Forest, Sunset, Grape and Graphite. A colour recolours the sidebar gradient, buttons and highlights; the main area stays a neutral dark (or white in light mode). The choice is remembered per browser. To add a colour, add an entry to `PALETTES` in `apps/web/src/lib/theme.tsx` and a matching `:root[data-palette="..."]` pair at the bottom of `apps/web/src/index.css`.

### Exchange (trading with other Invintel businesses)

**Exchange** (sidebar) lets two Invintel businesses trade signed documents directly: purchase orders, the supplier's answer (accept with a promised date, or reject), ship notices with tracking, and questions ("do you have this item?", "where is my order?"). Each organization has an exchange id and an Ed25519 signing key; you connect by pasting a partner's invitation and checking its fingerprint with them. A partner may only ask what you have switched on for them (nothing by default), and answers never include your cost. Messages are signed, can't be replayed, and go through the B2B message log (INV-12) with acknowledgements and an audit trail. Partners on the same server are delivered to in process; others over HTTPS at `<their address>/api/exchange/inbox` (set your public address on the Exchange page). Set `EXCHANGE_KEY_SECRET` to store private keys sealed.

API under `/api/orgs/:orgId/exchange`: `identity`, `invitation`, `connect`, `partners`, `partners/:id/permissions`, `purchase-orders/:id/send`, `purchase-orders/:id/timeline`, `orders`, `orders/:id/respond|ship`, `ask`, `answers`; deliveries arrive at the unauthenticated `POST /api/exchange/inbox`, where the signature is what is checked.

### Purchasing

**Purchasing** (sidebar) covers suppliers and purchase orders:

- **Running low** lists items at or under their reorder level with a suggested quantity (enough to get back to twice the reorder level, minus what is already on open orders). Tick the ones you want, pick a supplier, and it drafts an order.
- Orders go **draft > ordered > partly received > received** (or cancelled). Admins write, place and cancel orders; any member can receive against one, so the dock can do it. Placed orders can't have their lines changed: cancel and write a new one.
- **Receiving** puts stock into a location of your choice through the ledger ("Received: PO-0007") and ties each receipt to the order. What has arrived is *read from the ledger*, so reversing a receipt in Activity takes it off the order automatically. Suppliers over-ship: receiving more than ordered is allowed and flagged.
- **Close short** finishes a partly received order without waiting for the rest. **Cancel** is only for orders where nothing has arrived.
- Every supplier and order change is in the audit log.

API under `/api/orgs/:orgId/purchasing`: `GET/POST /suppliers`, `PATCH /suppliers/:id`, `GET /suggestions`, `GET/POST /orders`, `POST /orders/from-suggestions`, `GET/PATCH /orders/:id`, `POST /orders/:id/place|cancel|close|receive`.

### Sales orders and reservations

A customer's order (INV-15), with stock **reserved** for it, shipped through the ledger, and released if it is cancelled. **Sales** in the menu (switch it off in Settings > Features; the API refuses too).

- **Reserved and available.** `available = on hand - on quality hold - reserved`. Reserved is *derived*, never stored: for every confirmed order, what is ordered minus what has shipped (shipment lines in the ledger that haven't been undone). So a cancel, a close, a shipment and an Activity undo all change availability by themselves, and the numbers can't drift. Items now carry `reserved` and `available` (Inventory shows "N promised · M free", the item page an Available card, a partner asking about stock on the Exchange is told what can still be promised).
- **Draft > Confirmed > Part shipped > Shipped.** An admin writes a draft (customer = a customer trading partner, or just a name; their order number; wanted-by date; lines at a price). **Confirm** reserves; if the stock isn't there it is refused with what is short and the order stays a draft, unless the admin confirms as a **back-order** on purpose (shows as short, and the item as over-promised). A draft can be edited; a confirmed order can't (cancel it, or close it). **Cancel** (nothing shipped) and **Close short** (part shipped: the rest is released) are admin actions.
- **Pick and ship.** Anyone can ship. The ship dialog suggests where to take each line from (places with stock, labelled units oldest first; **nothing on quality hold is offered or accepted**). Plain items go out from a place; rolls and pallets go out as whole labelled units (with their lot). Over-shipping, a unit on hold, another item's unit, an unknown place and two people shipping at once are all refused, and a shipment is checked completely before anything is posted. Each shipment is a ledger entry of type "ship" pointing at the order (Activity shows it; a plain shipment can be undone there, which returns the stock and the reservation; roll and pallet entries can't be undone, as everywhere else).
- **Approvals (INV-7).** Settings > Approval rules has "Sales orders": confirming an order worth at least $X waits for a second admin before anything is reserved, then it is carried out as the person who asked.
- **Exchange.** Accepting a customer's order (Exchange > Orders from customers) makes a sales order from it (their SKUs mapped exactly onto ours: an unknown SKU, a different unit or too many decimals is refused, never guessed), reserves the stock, and only then sends the answer. Not enough stock: the answer isn't sent, the order stays a draft, and "Accept anyway (back-order)" is offered. A rule can hold the acceptance for approval (the customer hears nothing until it is approved). Rejecting releases the stock. **Shipping from Sales sends the ship notice**, one per shipment with what really went (the old "send a ship notice" on its own is closed for an order tracked in Sales, so stock can't stay in the books after the customer was told it shipped). A notice that can't be delivered doesn't undo the shipment: it says so and can be sent again from the order.
- **Recall.** Lot trace (Reports) now follows a labelled roll or pallet to the customer it was shipped to ("Shipped to ..."), and lists the customers in the summary.
- **Code.** `packages/shared/src/sales.ts`; `apps/api/src/sales-core.ts` (reservation math, create/confirm/cancel/close, pick list, shipping), `sales.ts` (routes under `/api/orgs/:orgId/sales`), `sales-exchange.ts` (answering an incoming order), `exchange.ts` (`sendOrderResponse`, `sendShipNotice` shared with the old routes).
- **Demo.** Bluebird Packaging has three orders: one reserved, one part shipped, one draft (Sales). Send an order from another organization over the Exchange to see accept/back-order.

### Low stock on what is available, ship notices to customers, and changing a confirmed order

INV-16, small follow-ups to Sales.

- **Reorder levels judge what is available.** Out means nothing is physically in stock. Low means what is *free to promise* (on hand - on quality hold - promised on sales orders) is at or under the reorder level; a level of 0 still flags an item that is promised more than there is. This is one rule (`stockStatusOf` in `packages/shared/src/sales.ts`) used by the Inventory status and "needs attention" filter, the Overview list, Alerts (low, out and days of supply, which now counts free stock), Purchasing suggestions and the draft order made from them. A suggestion gets you back to twice the level on *free* stock, less what is already on order; an over-promised item with no level is suggested for exactly what covers the promise. The item page says why: "124 on hand, 85 promised, 39 free, reorder at 50".
- **The customer is told when a shipment goes, however you trade with them.** An Invintel customer gets the signed Exchange ship notice (as before); an X12 customer gets an **856** (their own order number in PRF, ours if they gave none; the shipment's own number; exactly what went); an email customer gets a plain email with the lines, carrier and tracking; any other bridge that can carry a ship notice gets the canonical document; a customer who is just a name, or whose bridge can't carry one, hears nothing. The order's ship dialog says which. A notice that can't go (smtp down, a wrong address, a unit with no X12 code, a PO number too long) leaves the shipment standing, says why, and can be sent again from the order: a failure that may pass is retried as the same message, one that retrying won't fix goes out as a new message once the cause is fixed. The same shipment is never sent twice.
- **Changing a confirmed order.** "Change lines" on a confirmed order that hasn't shipped cancels it (its stock is released) and makes a draft copy that opens for editing; confirm the copy to reserve again (an approval rule applies again). Drafts can now be edited in the Sales screen. Not offered once something has shipped (close it and write a new order) .
- **Code.** `sales-notices.ts` (which way a notice goes, retries), `sales-core.ts` (`rewriteOrder`), `x12-bridge`/`b2b-orders.ts` (the 856 and the email). The demo's Bluebird Packaging is now an email customer (the notice lands in the outbox folder).

### Document templates: letterhead, logo and PDFs

INV-17. Every document we produce is drawn from your **letterhead** and a **template** for that kind of document: **purchase order**, **sales order confirmation**, **packing slip** and **invoice**. Settings > Documents has the letterhead (company name, address, phone, email, website, tax number, paper size A4 or US Letter, and for invoices the tax name and rate and days to pay), a logo, and per kind: title, colour, show the logo, which columns, terms, a footer on every page, with a **live preview** that redraws a sample (made-up data) from what is on the screen before you save. A customer or supplier can have their own title, colour and terms (Documents > Partners > edit > "Document look"); the order of precedence is the kind's defaults, then the organization's template, then the partner's.

- **No template language.** A template is settings, not code, so it can never do more than change how a document looks. (An HTML or drag-and-drop editor is a later step if people ask.)
- **Logo.** PNG or JPEG only, at most 300 KB and 1500 pixels each way; SVG and everything else is refused (by what the bytes are, not the file name). A PNG is decoded and rewritten as plain pixels, with every length and checksum checked and the amount it may inflate to capped, so nothing from the uploaded file reaches a PDF but the pixels; transparency is flattened onto white. A JPEG is structure-checked (8-bit, grey or RGB, no CMYK) and embedded as it is. It is served back with `nosniff` and a CSP that allows nothing.
- **What each document says.** Purchase order (to the supplier, requested date, the supplier page link); order confirmation (to the customer, their order number, prices, total); packing slip (what shipped now, what was ordered, what has shipped to date; no prices); invoice (what shipped at the order's prices, subtotal, tax, total due, due date). Long tables continue on more pages with the header repeated and "Page 2 of 3".
- **Invoices.** Made per shipment, on request, by an admin: numbered INV-0001... the first time and then kept exactly as issued (so changing the tax rate or terms later can't rewrite an invoice that went out). Tax is worked out to the cent with no floating point. This is a printable and sendable invoice, not an accounts ledger: nothing tracks payment.
- **Where they appear.** Sales > an order: Order confirmation, per shipment Packing slip and Invoice (PDF), and email buttons for customers whose partner can receive them. The email bridge now attaches PDFs: the purchase order, the packing slip on a ship notice, and, on request, an order confirmation and an invoice (an X12 customer gets the invoice as an 810 instead). Each is sent once.
- **Code.** `pdf.ts` (writer: colour, boxes, images, paper sizes, real Helvetica widths), `image.ts` (logo checks), `doc-pdf.ts` (layout), `doc-render.ts` (what each document says, sample data), `doc-context.ts` (letterhead + template + partner override + logo), `doc-settings.ts` (routes), `sales-docs.ts` (confirmation, packing slip, invoice and their delivery), shared types in `packages/shared/src/templates.ts`.

### Addresses, and a complete archive

INV-18. **Suppliers** and **customers** have an address. A customer's is kept on their trading partner as a **bill-to** and a **ship-to** (Documents > a partner > Addresses; "Ship to the same address" is a tick). A supplier's is on the supplier (Purchasing > Suppliers > Edit). An address is a place name (optional, e.g. "Plant 2, dock 4"), street, second street line, city, state or province, postal code and country.

- **Orders keep what they were made with.** A new sales order copies its customer's bill-to and ship-to (ship-to falls back to bill-to); you can change both on the order. Changing the customer later does not change an order that already exists, and a confirmed order keeps its addresses when it is rewritten.
- **On the documents.** Purchase order: the supplier's address and a "Deliver to" block (the letterhead address). Order confirmation, packing slip and invoice: Bill to and Ship to (one "Customer" block when they are the same place; the packing slip shows only Ship to). An invoice that was already issued keeps the addresses it was issued with. The letterhead address is now structured too; the older free-text lines still print for letterheads that have only those.
- **In EDI.** X12 850 writes the buyer, supplier and ship-to as N1/N3/N4 (and reads them back); 856 writes the ship-to; 810 writes the bill-to and ship-to. X12 is strict: a state must be a code (IL, not Illinois), the country a two-letter code (or a name on a short list that we can turn into one), a city is needed if there is any city/state/postal code, and nothing is shortened to fit the 55/30/15-character limits: such an order is refused with what to fix, before anything is sent. Documents without addresses come out exactly as before. The email documents carry the addresses in their canonical form.
- **Older records need nothing.** Suppliers, partners and orders without an address show none, and every document still renders; no migration is run.
- **Archive is complete.** Settings > Your data now also exports and restores trading partners (their bridge settings, bill-to/ship-to and per-customer document looks), the **document logo** (re-checked from its bytes on restore, never trusted), the **letterhead and document templates**, the **issued invoices** (with their numbers; the next invoice continues after the highest restored) and the **X12 control-number counters** per partner (so a restored organization doesn't reuse an interchange number). A test exports an organization, restores it into a second database and exports again: the two files match record for record once ids are renamed. Not archived: Invintel-exchange partners (they are tied to this organization's identity and have to be set up again), the B2B message log, captured invoices and the exchange identity.
- **Code.** `packages/shared/src/address.ts`; `x12-maps.ts` (`partySegments`); `doc-render.ts` (`customerParties`); `archive.ts` (partners, logo, counters, `documentProfile` setting); tests in `addresses.test.ts`, goldens `golden/x12/*-addresses.x12`.

### Search everywhere

**Ctrl/Cmd+K** (or the Search button in the top bar) opens a palette: type to jump to a page, an item (by name, SKU or any barcode) or a location. Arrow keys and Enter; Esc closes. Admin-only pages stay hidden from members.

### Import and export

**Inventory > Export** downloads every item as CSV, one row per item and location (`sku, name, category, description, reorder_level, unit_cost, barcodes, location, quantity, unit, decimals`; quantities are written as people read them, `12.500`). Text cells that start with `=`, `+`, `-` or `@` get a leading apostrophe so a spreadsheet can't run them as formulas.

**Inventory > Import** (admins) is a short wizard. Nothing is written until the last button:

1. **Which column is which?** Common header names are matched for you (`Part number`, `Qty`, `On hand`, `UPC`, `Bin`...); anything else you assign from a dropdown next to an example value. Needs a SKU, and a name when creating.
2. **What should it do?** *Add new items* (the default: a SKU that already exists is left alone, so running the same file twice can't double anything), *Update existing items*, or *Add and update*. Updates change only what the file fills in, blank cells change nothing, and **stock of items that already exist is never changed by import**. Unit and decimal places can't be changed this way. You can also choose to **import the good rows and skip the problem ones**.
3. **What would happen:** a line per row with what it will do, and for updates each change as `reorder level: 100 → 150`. Problem rows can be downloaded as a CSV (your original cells plus a `problem` column) to fix and upload again.

Each applied import is a numbered **batch** (`IMP-0001`) in Recent imports, and can be **undone** while nothing has built on it: new items are removed (their opening stock is written off through the ledger) and updated items go back to how they were. Undo refuses, naming the items, if stock has moved, an item is on an order, recipe, count or roll, or an updated field was changed again. It is all or nothing. Opening stock goes through the ledger as receipts ("Imported from CSV"), and every new or changed item and each import and undo is in the audit log. Limits: 1000 rows per file, about 2 MB. Unit costs are rounded to the cent.

API: `GET /data/items.csv`; `POST /data/items/import` with `{ csv, dryRun, mode, mapping, onErrors, filename }`; `GET /data/imports`; `POST /data/imports/:id/undo`.

### Your data: full archive

**Settings > Your data** (admins) downloads **everything the organization has as one JSON file** (`GET /data/archive.json`): locations, items (with units of measure and barcodes), stock levels, rolls and pallets, the whole ledger, suppliers, purchase orders, work centers, recipes, work orders, counts, quality holds, recall drills, downtime, import history and settings (features, pick-lists, approval rules). It does **not** include the audit log (it has its own export and hash chain), people, or open approval requests.

The **owner** can restore an archive into an organization that has no data (a new one): choose the file, see what is in it, confirm. `POST /data/archive/restore` with `{ archive, dryRun }`.

- Every record gets a **new id**; links between records (transfers, reversals, order lines, recipes, work orders) are rewritten to match. Anything in the file that points outside it gets a throwaway id, so a crafted file can't reach another organization's records. The join code, owner and members are never taken from the file.
- The file is **checked completely before anything is written**: version, unknown collections, field names starting with `$` or containing `.`, missing or wrong-typed fields, repeated ids, settings against an allowlist. A refused file says why.
- If the database refuses part way (for example a repeated SKU), everything written is **rolled back** and the organization is as it was. Restoring over data that is already there is refused.
- Numbering carries on: the next purchase order, work order, count, NCR, import or roll label continues after the highest restored.
- Dates, whole-number quantities and units survive exactly. The restore is written to the audit log.

### API keys and webhooks

**Settings > API keys** (admins) makes keys for other software. A key is `ivk_` plus 256 random bits, **shown once** when it is made; only a SHA-256 hash is kept, so a database leak doesn't leak keys. Send it as `Authorization: Bearer ivk_...` to `/api/orgs/:orgId/...`.

- **Two kinds.** *Read only* looks things up: items, locations, ledger entries, overview, rolls, purchase orders and suppliers, counts, scan lookup. *Read and write* also creates and edits items, adjusts and transfers stock, receives and moves (`/receipts`, `/moves`), receives rolls and moves or adjusts them, and receives against a purchase order. Nothing else: **no deletes, no imports or archive, no members, settings, approvals, audit log, other keys or webhooks, and no listing or creating organizations.** Anything outside answers `403`.
- A key belongs to **one organization** (any other answers `404`) and acts like a **member** named "API key: <name>", so the ledger and audit log say which key did something and approval rules still apply (an over-limit adjustment answers `202 { approvalRequired }`).
- **Expiry:** a key lasts a year unless you choose otherwise (30 days to two years, or "never", which the list flags); **revoke** stops it straight away (the record stays so the log still makes sense). Each key is limited to 600 requests a minute (`429` with `Retry-After`), and an address that sends 20 wrong keys is locked out for 15 minutes. "Address" means the real visitor: behind a reverse proxy on the same machine the proxy's `X-Real-IP` is believed (and only then), so one bad actor can't lock everyone out. The same address is used for the wrong-join-code limit and a sign-in limit across emails (30 wrong passwords per address, besides the 10 per email). Only `Authorization: Bearer ivk_...` is treated as a key: other `Authorization` headers (a proxy's Basic auth) leave the cookie session alone. A wrong key looks exactly like no key (`401`). The key is never written to a log or the audit trail.

**Settings > Webhooks** (admins) tells another system when something happens. Pick the events (or everything): `item.created/updated/deleted`, `stock.received/adjusted/moved/reversed`, `purchase_order.created/ordered/received/cancelled/closed`, `count.posted`, `work_order.created/released/completed`, `approval.requested/approved/rejected`, `import.applied/undone`. Each is a POST of JSON:

```json
{ "id": "6ad4…", "type": "stock.adjusted", "createdAt": "2026-10-18T14:40:54.466Z", "organizationId": "6ad4…", "seq": 29,
  "actor": { "name": "Ada" }, "entity": { "type": "item", "id": "6ad4…", "label": "Bolt M8 (BOLT-M8)" },
  "summary": "Adjusted Bolt M8: -3 (Used)", "changes": [ … ], "refs": { "movementIds": ["…"] } }
```

Headers: `X-Invintel-Event`, `X-Invintel-Event-Id` (the same on every retry and for every webhook, so a receiver can ignore repeats), `X-Invintel-Delivery`, and **`X-Invintel-Signature: t=<unix seconds>,v1=<hex>`** where `v1` is the HMAC-SHA256 of `"<t>.<raw body>"` with the webhook's secret (`whsec_...`, shown once; "New secret" replaces it). Check it, and reject a `t` that is more than a few minutes old:

```js
import { createHmac, timingSafeEqual } from "node:crypto";
function verify(secret, rawBody, header) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;
  const want = createHmac("sha256", secret).update(`${m[1]}.${rawBody}`).digest();
  return timingSafeEqual(want, Buffer.from(m[2], "hex"));
}
```

- **Delivery:** answer any 2xx. Anything else (4xx, 5xx, a redirect, a timeout of 8 seconds) is retried after 1 min, 5 min, 30 min, 2 h and 6 h, then it gives up and shows in the log with a "Try again" button. After 10 deliveries in a row give up, the webhook **switches itself off** and says why. *Send test* sends a `webhook.test` event right now, even to a switched-off webhook.
- **Private networks are blocked.** Only `https://` addresses on the public internet are accepted: no `localhost`, private, link-local (including cloud metadata `169.254.169.254`), carrier-NAT, loopback or reserved ranges, IPv4 hidden inside IPv6, or odd number forms of an IP. The check runs when the address is saved **and again on every connection** against what the name really resolves to, redirects are never followed, and only a few kilobytes of an answer are read. For local development only, `INVINTEL_WEBHOOKS_ALLOW_PRIVATE=true` allows http and private addresses (never set it in production); `INVINTEL_WEBHOOK_TIMEOUT_MS` changes the timeout.
- **Also:** only ports 443 and 8443 are allowed (unless the development switch is on), every delivery has a **hard 8-second limit** for the whole exchange (a receiver that trickles bytes can't hold a worker), and webhook **secrets are encrypted at rest** (AES-256-GCM) when the server has `WEBHOOK_SECRET_KEY` set; without it they are stored as they are (demo only). Secrets from before the key was set are encrypted the next time they are used. If the key is missing or wrong, deliveries fail with a clear message (not blamed on the receiver) and nothing is sent.
- The worker that sends deliveries runs inside the API process (every 5 seconds); two API processes are safe, a delivery is claimed atomically. Delivery logs clear after 30 days. Webhook secrets are stored in the database (an HMAC key has to be recoverable), unlike API keys.

API: `GET/POST /api-keys`, `POST /api-keys/:id/revoke`; `GET/POST /webhooks`, `PATCH/DELETE /webhooks/:id`, `POST /webhooks/:id/test`, `POST /webhooks/:id/rotate-secret`, `GET /webhooks/:id/deliveries`, `POST /webhooks/:id/deliveries/:deliveryId/retry`. All need an admin signed in as a person; a key can't call them.

### Payables: invoices, shipments and payments

**Payables** (sidebar, with Purchasing on) is where supplier paperwork meets what you ordered and what actually arrived. No money moves anywhere: a payment is a record you make, and everything exports as CSV for your accounting system.

**Supplier invoices** (admins). Enter one against a purchase order (or none): the supplier's own invoice number, dates, currency, lines (an item in its own unit, or a free line for freight and fees), per-line tax and freight. Totals are always worked out by the server from the lines, in the item's units (12.500 kg x $1.20 is $15.00), and an optional "their total" is checked against them. **Fill from what arrived** takes the quantities received and the order's prices.

- **Three-way match.** Matching compares the invoice with the **order's price and quantity** and with **what was actually received** (ledger receipts against the order that haven't been reversed), including what other approved invoices for the same order already billed. A problem is one of: `price_higher` (above the order by more than the tolerance; a lower price is only noted), `not_received`, `over_billed` (more billed than received, across invoices), `over_ordered`, `not_on_po`, `duplicate` (same supplier invoice number already entered), `currency`, `total_differs`, `po_not_open` or `po_supplier`; an invoice with no order is `no_po`. Receipts made after the invoice was entered count the next time it is looked at.
- **Rules** (Matching rules): the currency of your books, how far a price may be above the order (default 1%), how far billed may exceed received (default 0%) and how far their total may differ (default $0.05).
- **Flow.** Enter (draft) > **Match it** > a clean match goes straight to *Ready to pay*; anything else is *Needs review*. An admin approves a flagged invoice by saying **why** it is fine ("price confirmed by phone"), which is kept with the invoice and the audit log; the person who entered it can't override its problems unless they are the only approver. Editing sends it back to draft. An invoice can be voided (with a reason) until something is paid against it.
- **Second person's OK** (INV-7). Settings > Approvals now has two more rules: *Supplier invoices* from $X, and *Changes to how a supplier is paid*. A matching invoice at or over the line, or a payment-details change, waits as an approval request; the second person's approval re-runs the match first, so it can't be approved on stale information.

**Captured invoices.** An invoice that arrived by email or upload (Documents) shows as a banner on the Invoices tab with **Enter as invoice**: the invoice form opens filled in from the capture (supplier, order, number, dates, lines in stored units, their total), and saving closes the capture. A capture never becomes a payable by itself: it still goes through the same matching and approval.

**How a supplier is paid.** Method, account name, bank and the **last four digits**, and instructions. A full account or card number is refused on purpose. Changing it is audited, and can require a second person's OK (changing where money goes is how invoice fraud works).

**Incoming shipments** (an advance ship notice, anyone on the dock; a shipment you send to a customer lives on the sales order). Record what the supplier says is coming: their reference (unique per supplier), carrier, tracking, expected date and lines with their lot, optionally against a purchase order. Warnings say what doesn't match the order (not on it, more than ordered). **Receive** puts stock in through the ledger like any receipt, tagged with the shipment and the order (so the order, the match and the lot trail all see it), in full or in part, optionally held for inspection. A shipment never changes stock by itself, and can be cancelled until something arrives.

**Payments** (admins). Pay one or several approved invoices of one supplier: method, date (not in the future), reference, note. Each invoice's balance is kept exact with an atomic guard, so two people paying the same invoice can't pay it past its total. Voiding a payment (with a reason) puts the balance back. **Remittance advice** prints a page for the supplier.

**Exports**: `GET /invoices/export/bills.csv` (one row per line of approved and paid invoices, plus a freight row) and `/invoices/export/payments.csv`. The column layout is generic; mapping it to a particular accounting system's import format is not done (unverified).

API (admins, signed in as a person; API keys can't reach these): `/invoices` (list, create, `GET/PATCH /:id`, `POST /:id/submit|approve|void`), `GET/PUT /invoices/settings`, `GET/PUT /invoices/suppliers/:id/payment-details`, `/payments` (list, create, `/:id/void`, `/:id/remittance`), `/shipments` (list, create, `/:id/receive`, `/:id/cancel`; members can record and receive). Invoices, shipments, payments and the rules travel in the full archive.

### Units of measure

Every item says what it is counted in. Set **Unit** and **Decimal places** in the item form (presets for kg, g, lb, m, m², L, ft, or any text up to 16 characters), and optionally **Also bought or counted in**: `1 bag = 25 kg`. Receiving and counting then take `12.5` for a 3-decimal kg item, and the unit picker next to a quantity box converts bags to kilograms as you type (`2 bag = 50.000 kg`) and refuses anything that wouldn't come out as a whole number of the smallest unit.

- **Storage doesn't change.** The API, the ledger, the audit log and every total still deal in whole numbers: a count of the item's smallest unit. 12.5 kg with 3 decimals is stored as `12500`. Items with 0 decimals (everything that existed before) read exactly as they did. No floating point is used anywhere: text is parsed and printed digit by digit and conversions use BigInt.
- **Shared helpers** in `packages/shared/src/units.ts`: `formatQty(stored, item)`, `parseQty(text, decimals)`, `toStored`, `convertQty(text, factor, decimals)`, `lineValueCents(stored, unitCostCents, decimals)`, `uomOf(item)`. Anything that shows a quantity should go through `formatQty`; anything that multiplies a quantity by a cost through `lineValueCents`.
- **Unit cost means the price of one display unit** (one kg). Value = quantity x cost / 10^decimals, rounded to the cent. Overview, aging, ABC counting, count variance, approvals and purchase order totals all use `lineValueCents`.
- **Decimal places lock** once an item has any stock, ledger history, rolls, purchase order lines, recipes, work orders, counts or waiting approvals (the server answers 409). Renaming the unit or editing "also counted in" is always allowed. To change the decimals of an item with history, create a new item.
- **Totals across items** ("Units on hand", location totals, net count change) add display units, so 12.5 kg counts as 12.5, not 12,500. They mix units by nature; they are for scale, not accounting.

### Rolls and pallets (unit tracking)

Some stock isn't a pile of identical things: a paper roll has a weight that shrinks as it's used, and you need to know *which* roll is where. Set an item's **How is it counted?** to **By roll or pallet** and each physical roll or pallet becomes its own **unit**: its own label code (`U-000123`, or a pre-printed one), lot, remaining quantity, location and status (available, quarantined, consumed).

- **Receive** (Floor mode > Receive, or `POST /units`): say how much is on each, how many arrived and the lot, and each gets a label. The result screen has a **Print these labels** button.
- **Move**: scan the roll's label, then the destination. It moves with whatever is left on it. Scanning a unit-tracked *item* instead lists its rolls to pick from.
- **Use some**: Look up a label, then "Take N from this one". At zero the unit is marked consumed and can't be moved or used again.
- Everything writes ledger lines that carry the unit (Activity shows the code), updates the per-location stock rows, and is audited. Item totals, the overview and counts keep working because a location's stock for a unit-tracked item is always the sum of its units.
- Unit-tracked items refuse quantity-style receipts, moves and adjustments (they'd bypass the units), and can't switch tracking while they have stock. A unit label can't equal any SKU or barcode, and vice versa.
- Not built yet: reversing a unit's ledger entry (it's refused with a message), quarantine controls in the UI, and unit-level counts.
- For other modules: `receiveUnits`, `moveUnit` and `adjustUnit` in `apps/api/src/units.ts` take `{ type, workOrderId, transferId }` so production can tag the ledger lines it causes and have them reversed together.

### Labels

**Labels** (sidebar, under Tools) prints barcode labels for items (the SKU), locations (the code, else the name) and rolls/pallets (their label). Pick what to print, choose **Code 128** or **QR**, a label size, and how many copies of each, then Print. Barcodes are drawn as SVG so they stay sharp at any size, and the page prints only the label sheet. The codes come straight from the data, so what's on the label is exactly what a scan will look up. Use the browser's print dialog to choose the printer and set margins to "None" or "Default" and scale to 100%.

### Audit log

Every change is recorded in a single **audit log** (admins and owners only, under "Audit log" in the sidebar): who did it, when, a one-line summary, and for edits the exact before and after of each field.

What's recorded: items (created, edited, deleted), locations (created, edited, deleted), the organization (created, renamed, join code changed), members joining, and every stock receipt, adjustment, move and reversal (linked to its ledger entries). Join codes and passwords are never written to the log.

How it's protected:

- **Append-only.** There is no endpoint that edits or deletes an audit event.
- **Hash-chained.** Each event stores a SHA-256 over its own contents plus the hash of the event before it. Edit or remove an event and every hash after it stops matching. **Verify integrity** on the audit page (or `GET /api/orgs/:orgId/audit/verify`) walks the chain and tells you where it first breaks. It also counts ledger entries that no audit event refers to.
- **History outlives deletes.** Deleting an item writes any remaining stock off through the ledger and keeps every movement; deleted items and locations keep their names in Activity, taken from the audit snapshot. Entries for a deleted item can't be reversed.
- **Exportable.** *Export CSV* streams the log (honouring the current filters) with the hashes, for auditors.

Limits, so nobody over-trusts it:

- It is **tamper-evident, not tamper-proof**. Someone with write access to the database could rewrite the whole chain consistently, and deleting only the *newest* events can't be seen from inside the chain. The verify panel shows the head hash: record it somewhere outside the system (an email, a document, a ticket) and compare later.
- Audit events are written right after the change they describe, not in the same database transaction. If an audit write ever fails, the full event is logged to the server console for manual recovery and the user's action still succeeds. Closing that gap means running MongoDB as a replica set and wrapping each change in a transaction.
- Sign-ins, failed logins and password changes are not in the log yet, and there is no UI yet for changing a member's role.

### Barcode scanning

Every scan field in Floor mode accepts three kinds of input, and they all behave the same:

1. **A hardware scanner** (the usual choice on a plant floor). Most work as a keyboard ("wedge"): set the suffix to Enter and the field takes it.
2. **The camera** (button next to the scan field). It reads one code, then closes (on the multi-scan Receive and Move screens it stays open until Done).
3. **Typing** (keyboard button), for labels that won't scan.

How the camera works: it uses the browser's own `BarcodeDetector` when the device has one and it can read Code 128 (Chrome on Android, and Chrome on macOS). Otherwise it falls back to [ZXing-C++ compiled to WebAssembly](https://github.com/Sec-ant/barcode-detector) (iOS Safari, Firefox, Windows and Linux Chrome). The WASM binary (about 1 MB) is served from our own origin, not a CDN, and only downloads the first time someone opens the camera, so it works on a plant network with no internet. To force the WASM path on a device whose native detector misbehaves, run `localStorage.setItem("invintel.scanner", "wasm")` in that browser.

Formats read: Code 128, Code 39, ITF, EAN-13, EAN-8, UPC-A, UPC-E, QR and Data Matrix (the list is in `apps/web/src/lib/scan-formats.ts`). Print SKUs as Code 128 and location codes as QR or Code 128.

### Floor speed: scan the place once, then the items; GS1 labels

INV-20. **Floor mode > Receive** and **Move** are one document with many lines: **scan the place once, then scan each item**. Every scan of a counted item adds one; the same item (and lot, expiry, pallet) merges into one line of a running list you can nudge (+/-), type over (tap the number) or remove; **Undo** next to the last scan steps back; **one button at the end** posts the whole list as one document, and **one Undo** takes all of it back (same rule as a single entry: your own, within 15 minutes, or an admin; a receipt put on hold is decided from Quality). Things measured in kilos, metres or litres ask for a quantity instead of adding one. Rolls and pallets (tracked by unit) still go through their own label flow, from the same screen. The phone camera stays open in this mode and reads each new code (the same label held in view counts once).

- **Receive a PO** (new tile, Purchasing feature switch): pick the open order or type its number, scan where the delivery goes once, then scan what is on the truck. Each scan counts against that order's line; it shows "5 of 20 (3 came before)", flags anything over what was ordered, refuses an item that isn't on the order, and **All arrived** counts everything still owed. One receipt, one Undo.
- **GS1-128 labels** (also GS1 Data Matrix and QR): scan a pallet or carton label and the item (by GTIN), **lot (10)**, **expiry (17)**, **count (37/30)** and **pallet number (00)** fill themselves in; the expiry is stored on the receipt line next to the lot (`expiresOn`, shown in Activity and lot traces). Check digits (GTIN, SSCC), dates, field lengths and the GS1 character set are all checked; a label that doesn't read is **refused with the reason** (e.g. "GTIN (01) has a wrong check digit"), never half-read. A pallet label with no product (an SSCC alone) is remembered and attached to the next item scanned; the same pallet twice is refused. Plain SKUs, EANs and location codes work exactly as before; digits that happen to look like a label are looked up as typed first.
- **Scanner settings that matter:** set a hardware scanner to send the GS1 symbology identifier (`]C1`) and the group separator (ASCII 29), or have it print the bracketed form `(01)...(10)...`. If a scanner drops the separators, a lot in the middle of a label can't be told apart from the fields after it (see the report).
- **Code.** `packages/shared/src/gs1.ts` (parser; no dependencies), `apps/api/src/floor.ts` (`/receipts/batch`, `/moves/batch`, `/batches/:id/undo`), `activity.ts` (`reverseGroup`), web `lib/scan-session.ts` (the list rules), `lib/scan-resolve.ts`, `pages/floor/{receive,move,receive-po}.tsx`; tests in `gs1.test.ts`, `floor-batch.test.ts`, `scan-session.test.ts`, `scan-resolve.test.ts`.

### Barcodes on items

An item's **SKU** is your own code. Its **barcodes** are the codes printed on the product or its packaging (UPC/EAN on the unit, a different code on the case). An item can have up to 20, and a scan of either its SKU or any of its barcodes finds it.

- Add them in the New/Edit item form: scan with the camera, type, or let a hardware scanner type into the box and press Enter. Each code is checked as you add it, so a clash shows up while you're holding the product.
- If the SKU is blank, the first barcode you scan becomes the SKU too (editable). Plenty of small shops just use the product barcode.
- A barcode can only belong to one item per organization, and can't match another item's SKU (or the other way round). UPC-A, EAN-13 and GTIN-14 forms of the same number count as the same code.
- In Floor mode, a scan that matches nothing offers **Add as a new item**, which opens the form with that code already captured.
- The inventory search box also matches barcodes.

Things to know:

- **Browsers only allow the camera on https pages** (or `localhost`). Testing from a phone against your laptop's dev server over plain `http://192.168…` will not work; use an https tunnel or a certificate, or a hardware scanner.
- If you add a Content-Security-Policy, `script-src` needs `'wasm-unsafe-eval'` for the WASM fallback.
- UPC-A labels are 12 digits to some scanners and 13 (with a leading 0) to others. Lookups match all the zero-padded forms of the same number, so an item whose SKU is a UPC is found whichever device scanned it.
- The decoding tests (`pnpm --filter @invintel/web test`) render real barcode images and run them through the same detector the app uses.

### Auth

- Email + password, hashed with argon2id.
- Sessions are an opaque random token in an `httpOnly`, `SameSite=Lax` cookie. Only a SHA-256 of the token is stored in Mongo, and sessions expire after 7 days (TTL index).
- Failed logins are rate limited per email, and wrong join codes per client address / user (10 per 15 minutes, in memory, so it resets on restart and isn't shared across instances).
- Set `ALLOW_REGISTRATION=false` to close sign-ups once your team is in. The very first account can always register.
- Set `COOKIE_SECURE=true` when serving over HTTPS.

## Demo data

`pnpm --filter @invintel/api seed:demo` loads a small corrugated plant (nested locations, ten items, receipts, moves, an adjustment) into the configured database and creates `demo@invintel.local` (the password is at the top of `apps/api/src/seed-demo.ts`, or set `DEMO_EMAIL` / `DEMO_PASSWORD`). **That login is for local demos only. It is published in this repository, so never load the demo data into a database that faces the internet.** It refuses to run if that account already exists. Point it at a scratch database with `MONGODB_DB=invintel_demo`.

## Scripts

- `pnpm dev` run API and web together
- `API_URL=http://localhost:3002 pnpm --filter @invintel/web dev` point the web dev server at a different API (default `http://localhost:3001`)
- `pnpm typecheck` typecheck every package
- `pnpm test` run the API tests (Vitest, needs `docker compose up -d`; uses a throwaway database)
- `pnpm build` typecheck the API and build the web app

### Quality hold and NCR

Anyone can **put stock on hold** so it can't be used: on the desk (**Quality**) or on the floor (**Floor mode > Quality hold**: scan a roll or pallet label, or an item, pick where and how many, tap a reason). Plain stock moves into an automatic **Quality hold** place; a labelled roll or pallet stays where it is and is marked on hold. Every hold is an **NCR** (NCR-0001, ...). Held stock can't be moved, adjusted, counted, loaded onto a machine or reversed from Activity: only an admin **decides** it, partly or all at once: **use as is / rework** (back to a place you pick, by default where it came from), **scrap** (with a reason from the scrap list) or **return to supplier**. Each decision is a ledger line tagged with the NCR and written to the audit log.

**Inspect before release:** the floor Receive screen, the purchase-order receive dialog and the unit receive screen each have an "Inspect before release" switch; what arrives is received and goes straight on hold as "Awaiting inspection", tied to the order and the supplier lot. The same screens take an optional **supplier lot**, which is kept on the receipt's ledger line (and shown in Activity) for traceability. Admins edit the hold and scrap **reason lists** under Quality > Reason lists.

API under `/api/orgs/:orgId`: `POST /quality/holds`, `GET /quality/ncrs?status=open|closed|all`, `GET /quality/ncrs/:id`, `POST /quality/ncrs/:id/dispose` (admin), `GET /quality/summary`, `GET|PUT /reasons` (PUT is admin).

### Lot trace and mock recall

**Reports > Lot trace and mock recall** follows a supplier lot, a roll or pallet label, or a work order **forward** (where did it go: the work orders that used it, what they made, where that is now and how much is still in stock) or **backward** (what went into this pallet or work order: the rolls, their lots, their receipts and orders). The answer is a tree you can read, a table of the affected stock with where it sits now, and a CSV. **Run as a mock recall** does the same trace, times it, keeps it in a history (who, when, how many units and work orders, how long it took) and writes it to the audit log, so a plant can show how fast it can answer a recall.

The trace is read from the ledger, so it is exact for anything tracked by roll or pallet label and for lots you record at receiving. Plain stock has no lot after receiving, so links that pass through it are shown as **possible** (with a note and the likely receipts), never as fact. Stock on quality hold shows as held. The demo has a traceable chain: try lot `MILL-0712`.

API under `/api/orgs/:orgId/traceability`: `GET /trace` and `GET /trace.csv` (`?lot=` with optional `itemId=`, or `?unit=`, or `?workOrder=`; `&direction=forward|backward`), `POST /drills` (same fields in the body), `GET /drills`.

### Scrap and yield trends

On the floor, anything scrapped now needs a **reason** from a short list: the Production tile asks "Why was it scrapped?" once the scrap count is above zero (material scrapped at Report usage, finished output scrapped at Report output), and scrap decided from a quality hold uses the same list. Admins edit the list under Quality > Reason lists. **Reports > Scrap and yield trends** (Production switch) shows, for the last 7, 30, 90 or 180 days and optionally one work center: scrap value (quantity x each item's current unit cost), **yield** (good output / good + scrapped output), the biggest reason, scrap with no reason, a bar chart by reason, a trend (per day, or per week from Monday for long windows), tables by work center (value, entries, good, scrapped, yield) and by material, where the scrap came from (material used, output, quality hold), and a CSV of every scrap entry. Scrap that was reversed in Activity is ignored.

API: `GET /api/orgs/:orgId/production/scrap?days=7|30|90|180&workCenterId=` and `GET .../production/scrap/lines.csv`. `POST .../production/work-orders/:id/consume` and `/output` take an optional `scrapReason` (must be on the org's scrap list; stored on the ledger line as `reasonCode`).

### Business-to-business exchange (core)

The transport-independent core for exchanging documents with other businesses (INV-12). A **trading partner** is a business we exchange documents with, carried by a **bridge** (an adapter for one way of moving documents: email, an EDI provider, the Invintel-to-Invintel exchange, or the built-in `loopback` for tests and demos). A **B2B message** is one document sent or received, kept whole (the raw document, with its hash and size, never changed), with its state (`queued, sent, delivered, acknowledged, rejected, failed`, and `received` for inbound), every attempt, every acknowledgement (transport, functional, business), an idempotency key (the same key never makes two messages or two sends) and a link to our own record (PO number, invoice, shipment). Failed sends can be retried as the same message; permanent failures can't. Test partners are marked as such in the audit log. Settings values (endpoints, secrets) never appear in audit entries.

Code: `packages/shared/src/b2b.ts` (types, states, allowed transitions), `apps/api/src/b2b-core.ts` (the `Bridge` interface, `registerBridge`, `sendMessage`, `receiveMessage`, `retryMessage`, `recordAck`, the loopback bridge), `apps/api/src/b2b-routes.ts`. A bridge is `{ id, carries, send(message, partner), verifyInbound(request, partner) }` and never touches the database.

API under `/api/orgs/:orgId/b2b`: `GET /bridges`, `GET|POST /partners`, `PATCH /partners/:id` (admin writes), `GET /messages` (`?partnerId=&direction=&state=`), `GET /messages/:id` (with the raw body), `POST /partners/:id/messages` (send, admin), `POST /messages/:id/retry`, `POST /messages/:id/ack` (admin; record an answer by hand). Partners post documents to `POST /api/b2b/inbound/:partnerId` (no session; the partner's bridge verifies the request; anything not accepted gets the same plain refusal; 2 MB and 120 requests a minute per partner).

### Partners, email orders and invoice capture

The first real bridge on the B2B core (INV-12). Everything is on the **Documents** page (`/o/:id/documents`): Partners, Documents (the message log with every attempt and answer), Incoming invoices.

- **Email orders.** A partner with bridge `email` gets purchase orders as a plain email with a PDF attached (made by our own small PDF writer, `apps/api/src/pdf.ts`) and a private link. In a purchase order's dialog, "Email to supplier" sends it, "Preview PDF" shows it first, "Send again" makes a new revision and switches the old link off. Test partners put TEST in the subject.
- **Supplier page.** The link opens `/b2b/s/:token` with no account: the supplier confirms (optionally a ship date), declines with a reason, or sends a ship notice (date, carrier, tracking). Links are stored hashed, expire after 60 days and stop working when a newer one is sent. Answers are kept as received messages, mark the sent order acknowledged, and show in the purchase order dialog and the log. They never change stock or the order by themselves.
- **Invoice capture.** Invoices come in by upload or to a partner's invoice inbox (`invoice-inbox` bridge, secret read from the environment variable named in the partner's `bridgeConfig.secretEnv`). UBL XML and JSON are read exactly (XML with a DOCTYPE or entities is refused); a PDF is kept as it came and typed in by a person; nothing is OCR'd and no bank details are read. A captured invoice shows what was read (each field marked read, guessed or missing), whether the total matches the order, and whether the same number already came in. It never becomes a payable on its own: `GET /b2b/invoices/:id/invoice-input` gives the shape for the invoice entry and `POST /b2b/invoices/:id/converted {invoiceId}` links it once one is created.
- **Retries.** A failed send can be retried from the log; automatic retry schedules are not built yet.

Mail goes through `apps/api/src/mail.ts`. With no settings it writes `.eml` files (to `INVINTEL_OUTBOX_DIR`, default the system temp folder), so nothing leaves the machine. For real mail set `INVINTEL_SMTP_URL` (`smtp://` with STARTTLS or `smtps://`), `INVINTEL_MAIL_FROM`, and `INVINTEL_PUBLIC_URL` (used in the supplier link). Plain-text SMTP login is refused unless `INVINTEL_SMTP_ALLOW_PLAIN_AUTH=1`.

Code: `b2b-orders.ts`, `order-doc.ts`, `mime.ts`, `mail.ts`, `invoice-capture.ts`, `b2b-capture-routes.ts`; shared types in `packages/shared/src/b2bdocs.ts` and `b2bcapture.ts`. Demo data has a test partner "Midwest Paper Mill" and an uploaded invoice for the demo purchase order.

### X12 EDI (850, 855, 856, 810, 997)

A second bridge on the B2B core (INV-14): `x12`. Orders go out as an **850**; the supplier's **855** (acknowledgment), **856** (ship notice) and **810** (invoice) come back and show up where the email answers do (the order's dialog, the log, Incoming invoices); every document we receive is answered with a **997** (receipt) and every 997 we get is matched to what we sent. One transaction set per interchange, versions 004010 and 005010.

- **Partner setup** (Documents > Partners, bridge "X12 EDI"): our qualifier + id and theirs (ISA05-08, e.g. `ZZ` / `NWCORR`), version, transport, optional secret variable name (so they can post documents to `POST /api/b2b/inbound/:partnerId`), optional extra unit codes (`{"sheet":"SH"}`), receipts on/off. Saved settings are checked.
- **Test and live are separate.** A test partner only ever sends and accepts ISA15 `T`; a live one only `P`. A document in the wrong mode, from other ids, or addressed to someone else is refused (and nothing is stored).
- **Strict on the way out.** An order with a unit that has no X12 code, a part number containing `*` `~` `>`, a number that is too long, or a total that does not add up is not sent; the reasons are listed. Names and descriptions are cleaned (reserved characters become spaces; descriptions are cut to 80). Control numbers (ISA13 = GS06) come from an atomic counter per partner and wrap after 999999999.
- **Strict on the way in.** Envelope counts and control numbers must match (SE/GE/IEA), money has at most two decimals, quantities are plain numbers, units must be known. A document is read completely or refused with every problem listed; nothing is guessed. An inbound 810 becomes a captured invoice (every field marked "read"); it never becomes a payable by itself.
- **The test partner.** There is no network transport yet (AS2, SFTP or a provider would be one more adapter). Partners on the `loopback` transport get a built-in pretend supplier: in Documents, open a sent order and pick what it does (receipt and accept / accept with changes / reject / refuse as malformed / ship notice / invoice) then "Let it answer". Its documents go through the same checks as anything from outside. Only for test partners.
- **Code.** `apps/api/src/x12.ts` (envelope writer, strict parser, exact decimal helpers), `x12-maps.ts` (pure mappers to and from the canonical documents), `x12-bridge.ts` (bridge, partner settings, control numbers, what happens on arrival), `x12-loopback.ts` (test partner). Golden files with fictional companies are in `apps/api/src/golden/x12/`: a change to one is a change to what partners receive; `UPDATE_GOLDEN=1 pnpm --filter @invintel/api test x12` rewrites them (read the diff).
- **Demo.** The demo has "Lakeshore Film & Resin" as an X12 test partner with a placed order: Purchasing > PO-0002 > "Send as X12 (850)", then Documents > that order > "Let it answer".

## API

Auth (no session needed except `/me`):

| Method | Path | |
| ------ | ---- | - |
| GET    | `/api/auth/config` | `{ registrationOpen }` |
| POST   | `/api/auth/register` | `{ name, email, password, organization }` where `organization` is `{ mode: "create", name }` or `{ mode: "join", joinCode }` |
| POST   | `/api/auth/login` | `{ email, password }` |
| POST   | `/api/auth/logout` | ends the session |
| GET    | `/api/auth/me` | current user |

Organizations (session required):

| Method | Path | |
| ------ | ---- | - |
| GET    | `/api/orgs` | your organizations and roles |
| POST   | `/api/orgs` | `{ name }`, you become the owner |
| POST   | `/api/orgs/join` | `{ joinCode }` |
| GET    | `/api/orgs/:orgId` | one organization (join code only for admins) |
| PATCH  | `/api/orgs/:orgId` | rename (admin) |
| POST   | `/api/orgs/:orgId/join-code` | rotate the join code (admin) |
| GET    | `/api/orgs/:orgId/members` | members and roles |
| PATCH  | `/api/orgs/:orgId/members/:userId` | `{ role: "admin" \| "member" }` (owner only) |
| DELETE | `/api/orgs/:orgId/members/:userId` | remove a member, or leave yourself (the owner can't) |

Under `/api/orgs/:orgId` (members only):

| Method | Path | |
| ------ | ---- | - |
| GET    | `/overview` | totals, items needing attention, stock by kind of location |
| GET    | `/locations` | locations with item and unit counts |
| POST   | `/locations` | create (admin): `name`, `type`, `parentId`, `code`, `description` |
| PATCH  | `/locations/:id` | edit (admin) |
| DELETE | `/locations/:id` | delete, refused while it holds stock (admin) |
| GET    | `/items` | items with total quantity and per-location stock |
| POST   | `/items` | create, optional `initialStock: { locationId, quantity }` |
| GET    | `/items/:id` | get one |
| PATCH  | `/items/:id` | update details (stock changes go through adjust/transfer) |
| DELETE | `/items/:id` | delete item and its history |
| POST   | `/items/:id/adjust` | `{ locationId, delta, reason }`, can't go below 0 at that location |
| POST   | `/items/:id/transfer` | `{ fromLocationId, toLocationId, quantity, reason }` |
| GET    | `/items/:id/movements` | stock history for one item |
| GET    | `/movements` | the ledger. Filters: `itemId`, `locationId` (includes children), `type`, `q`, paging with `before` + `limit` |
| POST   | `/movements/:id/reverse` | `{ reason }`, undo an entry (both halves of a move) |
| POST   | `/receipts` | `{ itemId, locationId, quantity, reference }`, returns the item and `movementIds` |
| POST   | `/moves` | `{ itemId, fromLocationId, toLocationId, quantity, reason }` |
| GET    | `/lookup?code=` | resolve a scanned SKU, location code, location name or id |

## License

MIT

## Running behind nginx

`deploy/nginx/run-local.sh start` builds the web app and starts nginx (installed with `brew install nginx`) on port 8080, serving the built files and passing `/api` to the API on loopback (`API_PORT=3011 deploy/nginx/run-local.sh start` if the API isn't on 3001). One address serves both, so a phone on the same network can open `http://<this machine's address>:8080`. It has rate limits on sign-in and the API, basic security headers and long caching for built assets, and uses its own directory (`~/.invintel-nginx`), not nginx's global config. Use `LISTEN=127.0.0.1:8080` to keep it to this machine, and `stop` to turn it off.

The API listens on 127.0.0.1 only (set `HOST` to change that), so everything goes through nginx or the Vite proxy. Behind a tunnel on this machine nginx takes each visitor's real address from `CF-Connecting-IP` (only when the connection is from loopback), so the sign-in limit is per person, not per tunnel. Set `BASIC_AUTH_FILE` to a htpasswd file to put a username and password in front of the whole site before sharing a link with anyone else.

It speaks plain HTTP. Put TLS in front of it before anyone outside your own network uses it, and get a security review of your setup before it faces the internet.
