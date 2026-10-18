# Invintel

Open source inventory management, built by Bakerheit Technologies.

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

### Purchasing

**Purchasing** (sidebar) covers suppliers and purchase orders:

- **Running low** lists items at or under their reorder level with a suggested quantity (enough to get back to twice the reorder level, minus what is already on open orders). Tick the ones you want, pick a supplier, and it drafts an order.
- Orders go **draft > ordered > partly received > received** (or cancelled). Admins write, place and cancel orders; any member can receive against one, so the dock can do it. Placed orders can't have their lines changed: cancel and write a new one.
- **Receiving** puts stock into a location of your choice through the ledger ("Received: PO-0007") and ties each receipt to the order. What has arrived is *read from the ledger*, so reversing a receipt in Activity takes it off the order automatically. Suppliers over-ship: receiving more than ordered is allowed and flagged.
- **Close short** finishes a partly received order without waiting for the rest. **Cancel** is only for orders where nothing has arrived.
- Every supplier and order change is in the audit log.

API under `/api/orgs/:orgId/purchasing`: `GET/POST /suppliers`, `PATCH /suppliers/:id`, `GET /suggestions`, `GET/POST /orders`, `POST /orders/from-suggestions`, `GET/PATCH /orders/:id`, `POST /orders/:id/place|cancel|close|receive`.

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
2. **The camera** (button next to the scan field). It reads one code, then closes.
3. **Typing** (keyboard button), for labels that won't scan.

How the camera works: it uses the browser's own `BarcodeDetector` when the device has one and it can read Code 128 (Chrome on Android, and Chrome on macOS). Otherwise it falls back to [ZXing-C++ compiled to WebAssembly](https://github.com/Sec-ant/barcode-detector) (iOS Safari, Firefox, Windows and Linux Chrome). The WASM binary (about 1 MB) is served from our own origin, not a CDN, and only downloads the first time someone opens the camera, so it works on a plant network with no internet. To force the WASM path on a device whose native detector misbehaves, run `localStorage.setItem("invintel.scanner", "wasm")` in that browser.

Formats read: Code 128, Code 39, ITF, EAN-13, EAN-8, UPC-A, UPC-E, QR and Data Matrix (the list is in `apps/web/src/lib/scan-formats.ts`). Print SKUs as Code 128 and location codes as QR or Code 128.

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

`pnpm --filter @invintel/api seed:demo` loads a small corrugated plant (nested locations, ten items, receipts, moves, an adjustment) into the configured database and creates `demo@invintel.local` (the password is at the top of `apps/api/src/seed-demo.ts`). It refuses to run if that account already exists. Point it at a scratch database with `MONGODB_DB=invintel_demo`.

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

It speaks plain HTTP. Put TLS in front of it before anyone outside your own network uses it, and have Frida review it before it faces the internet.
