# INV-15: Sales orders with reservations (on hand vs available)

Owner: Eli. Branch: `inv-15/sales-orders` (on main with INV-12 and INV-14). Ticket: INV-15 on the Invintel board.

## What it does

- **Sales orders** (`/o/:id/sales`, API `/api/orgs/:orgId/sales`): customer (a customer trading partner or a name), their order number, wanted-by date, lines with price. Draft, confirmed, part shipped, shipped, closed short, cancelled. Admins write, confirm, cancel and close; anyone ships.
- **Reserve on confirm, release on cancel/close.** `available = on hand - on quality hold - reserved`. Reserved is derived from the ledger (confirmed orders: ordered minus live shipments), never stored, so cancel, close, shipment and an Activity undo can't leave it wrong. Items carry `reserved` and `available`; Inventory shows "N promised · M free", the item page an Available card, an order line the item's current availability, and the Exchange stock answer is "what can still be promised".
- **Shortage is explicit.** Confirm is refused when it doesn't fit (it says which items and by how much; the order stays a draft). A back-order is allowed on purpose and shows as short; the item then reads over-promised (negative available).
- **Ship through the ledger** (new movement type "ship", pointing at the order): plain items from a place, rolls and pallets as whole labelled units. Everything is validated before anything is posted; holds (quality hold areas, held units), over-shipping, other items' units, unknown places and concurrent shippers are refused. A pick list suggests places and units (nothing on hold, oldest units first). An undo in Activity puts stock and reservation back; roll and pallet entries can't be undone (existing rule).
- **Approvals (INV-7).** New kind "sales_order" (Settings > Approval rules): confirming, or accepting an Exchange order, worth at least $X waits for another admin. Approving carries it out as the person who asked (and sends the held answer to the customer).
- **Exchange.** Accepting an incoming order makes the sales order, reserves, then sends the answer (accepted or changed). Unmappable lines (unknown SKU, different unit, too many decimals) refuse the acceptance with the reason; shortage refuses it and offers a back-order; a rejection cancels the order and releases the stock. Shipping from Sales sends the ship notice with the shipment's own number and exactly what went; a failed notice leaves the shipment standing and can be sent again. The standalone ship-notice route is closed for an order that Sales tracks (409 with the order number). `sendOrderResponse` and `sendShipNotice` are exported from `exchange.ts` and used by both the old routes and Sales, not duplicated.
- **Audit.** `sales_order.created / updated / confirmed / shipped / cancelled / closed` (each with who, what and the ledger movement ids).
- **Feature switch.** Settings > Features > Sales (default on; off hides the menu and the API answers 403; the Exchange then behaves as it did before).
- **Data archive.** Sales orders are in the export and restore, and the SO number counter carries on.
- **Recall (a small extra).** The forward lot trace follows a shipped roll or pallet to the customer ("Shipped to ...", and a "customers" list in the summary).

## How to try it

`pnpm --filter @invintel/api seed:demo`, sign in, **Sales**: SO-0001 reserved, SO-0002 part shipped (Ship it), SO-0003 a draft (Confirm it). **Inventory**: RSC-1296 shows "promised" and "free". To see the Exchange side, connect another organization as a supplier, have it place an order for RSC-1296 and send it, then **Exchange > Orders from customers > Answer > Accept** (a big quantity shows the shortage and "Accept anyway (back-order)").

## Decisions I made

- **Derived, not stored.** A stored reserved counter drifts the first time anything touches stock outside this flow (an undo, a count, a hold). Deriving it from live ledger lines makes that impossible, at the price of one extra query when items are loaded.
- **Claim, then check.** Confirming moves the order to confirmed first, then checks availability including itself, and puts it back if it doesn't fit. Two confirms racing for the same stock can both be refused (retry), never both accepted. Tested with concurrent requests. While the check runs, the order can't be shipped, cancelled or closed (a short guard that expires by itself).
- **Reservation is per item, not per place or lot.** Simple and what the question "can I promise this?" needs. The pick decides where it comes from. (A reservation of a specific lot or place would be a later refinement.)
- **Quality hold stock is not available to promise**, for quantity items (hold area) and for labelled units (held in place).
- **Accepting is a promise.** An incoming order is only answered once its stock is reserved (or on purpose as a back-order, or after approval).
- **Whole units for rolls and pallets.** Splitting a roll to ship part of it isn't offered; the dialog says so.
- **A confirmed order can't be edited.** Cancel it (nothing shipped) or close it (part shipped) and write a new one. Changing quantities on a promise that a customer was told about needs a real change-order flow.

## Changed in existing behaviour (Gus: read these)

- `POST /exchange/orders/:id/respond` with accepted/changed now creates and confirms a sales order first (when Sales is on), and can return 409 (shortage or unmappable line, with `shortages`/`salesOrder`) or 202 (approval). Rejected cancels it. Two exchange tests were updated for this (ship through Sales; the old ship route answers 409 for a tracked order).
- Exchange stock answers use available (on hand minus hold minus reserved, never below 0), not on hand.
- Item responses gained `reserved` and `available`; `DEFAULT_MODULES` gained `sales: true`; movement type `ship`; approval kind `sales_order`; trace summary gained `customers`.

## Tests

`sales.test.ts` (30): drafts and roles and validation, other organizations, reserve/release arithmetic, shortage and back-order, racing confirms, quality hold, module switch, approvals (hold, approve, reject, approved-but-gone), shipping in parts (ledger, audit, status), every refusal, all-or-nothing, concurrent shippers, undo in Activity, close and cancel rules, pick list, rolls and pallets (whole units, holds, other item's unit, used-up unit, undo refused), a **randomized sequence of confirm / ship / undo / cancel / close** checked against independent arithmetic after every step, recall to the customer, and the Exchange (accept reserves once, shortage, unmappable lines, reject releases, ship notice per shipment and failed-notice retry, approval holding the answer, stock answers, Sales off). I also broke the reversal handling and the shortage check on purpose to confirm the tests fail. Whole API suite (390), web (20), typecheck and build green. Clicked through in a browser at desktop and 375 px (found and fixed a dialog overflow on the new-order form).

## Known limits

- Reorder suggestions and the low-stock status still look at on hand, not available (a plant promising most of an item may want them to use available; that changes Alerts and Purchasing, so I left it for a decision).
- Customers other than Exchange partners (email, X12) get no automatic ship notice yet; the order's customer can be an email or X12 partner but nothing is sent.
- A confirmed order's quantities can't be changed; reservation is per item (not lot or place); plain (non-labelled) shipments have no lot, so recall stops at plain stock as elsewhere.
- Undoing a plain shipment in Activity after the customer was told it shipped returns the stock but doesn't send a correction.
