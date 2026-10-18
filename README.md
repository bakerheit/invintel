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

**Inventory > Export** downloads every item as CSV, one row per item and location (`sku, name, category, description, reorder_level, unit_cost, barcodes, location, quantity`). Text cells that start with `=`, `+`, `-` or `@` get a leading apostrophe so a spreadsheet can't run them as formulas.

**Inventory > Import** (admins) takes a CSV and shows a preview before anything is written: new items, stock lines, rows skipped and problems per line. Rules:

- Needs a SKU and a name column. Common header names work (`Part number`, `Qty`, `On hand`, `UPC`, `Bin`...). Optional: category, notes, reorder level, unit cost (`$12.50` is fine), barcodes (separate with `|`), location (its code, full path or unique name) and quantity.
- It only **creates**: an existing SKU is never changed, so importing the same file twice can't double anything. Repeat a SKU on another line to put stock in a second location.
- Opening stock goes through the ledger as receipts ("Imported from CSV"), and each new item is in the audit log.
- One bad row blocks the whole import (the preview says which line), so you never end up half-loaded. Limits: 1000 rows per file, about 2 MB. Unit costs are rounded to the cent.

API: `GET /data/items.csv`, `POST /data/items/import` with `{ csv, dryRun }`.

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
