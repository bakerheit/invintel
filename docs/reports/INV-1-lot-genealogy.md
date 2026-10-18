# INV-1: Lot genealogy and mock recall

Owner: Eli. Branch: `inv-1/lot-genealogy` (stacked on main with INV-2 merged). Ticket: INV-1 on the Invintel board.

## What it does

- **Reports > Lot trace and mock recall.** Start from a supplier **lot**, a roll or pallet **label**, or a **work order**, and pick a direction:
  - **Where did it go (forward):** every work order that loaded or used it, what each made (labelled outputs are followed on into the next work order, up to 8 levels), and where all of that is now with how much is still in stock.
  - **What went into it (backward):** the work order that made a pallet, the rolls it used, each roll's receipt (date, lot, purchase order and supplier where the receipt had one), and the plain materials it used.
- **Result:** summary cards (answered in N ms, rolls and pallets, still in stock, work orders, places), the tree, a table of affected stock (item, lot, remaining quantity, status, location, via which work order) and a CSV download.
- **Mock recall:** the same trace, run as a drill. It is timed, kept in a history list (who, when, what was traced, units, work orders, time taken, whether it had possible links) and written to the audit log (`traceability.drill`). Any member can run one; a failed trace is not recorded.
- **Honest about plain stock.** Plain (not label-tracked) stock has no lot after receiving. A forward trace from a plain lot, or a backward trace through plain materials, lists the work orders or receipts that *might* be involved, marked "possible", with a note. Nothing inferred is ever shown as fact.
- Stock on quality hold (INV-2) shows as on hold; production lines that were reversed are ignored.
- Lives in the Reports area (registered in `apps/web/src/lib/reports.ts`).

## How to try it

`pnpm --filter @invintel/api seed:demo` (the demo now has a traceable chain), sign in, **Reports > Lot trace and mock recall**. Lot `MILL-0712`, "Run as a mock recall": 4 rolls and pallets, 900 still in stock, one work order, two places. Then "What went into it?" with the label of a finished pallet (see the table) to go back to the roll and its lot.

## Decisions I made

- **Exact only where the data is exact.** Labelled rolls and pallets carry their lot and their work-order lines, so those links are exact. Everything through plain stock is inferred and labelled so; the alternative (guessing by FIFO) would look precise and be wrong.
- **Read from the ledger and unit records, no new write path.** Nothing was added to production or receiving for the trace itself, only the supplier lot field from the shared schema piece; so history before this change traces as far as the data allows.
- **A tree plus a flat table.** The tree shows how things connect; the table is what you act on in a recall (what exists, where, how much).
- **Seen-before nodes are shown once and referenced after** ("already shown above"), so a work order that made two pallets isn't expanded twice and cycles can't loop.
- **Caps:** depth 8 levels, 2,000 steps (the trace says so when it stops), and at most 30 possible work orders per plain lot.
- **Drills record counts, not the whole result**, so history stays small; the trace can be rerun for the detail.
- **No "put all affected stock on hold" button yet.** It would be the natural real-recall step (INV-2's hold on every available unit in the result); I left it out to avoid a mass stock change without its own review.

## Tests

`apps/api/src/traceability.test.ts` (12 tests), on a small plant (labelled rolls and plain glue become labelled pallets in one work order; pallets go into a second order that makes plain crates; glue arrives on a purchase order with a supplier lot): forward trace from a lot across two levels with the right units, remaining quantities, statuses, locations and work orders; lot case-insensitivity; a lot nobody used; plain-lot traces marked inferred with PO and supplier; starting from a label or a work order; held stock shown as held; backward from a pallet to the roll, its lot and receipt, plus the glue as possible sources; backward through two levels; backward from a lot of pallets (a work order expanded once, referenced after); every error (unknown lot, label, work order, none or two starting points, bad direction, other organizations' data); reversed lines ignored; drills (timing, history order, audit, any member, failed drill not kept, per-organization); CSV columns and rows. Whole API suite (190), typecheck and build green. Clicked through in a browser at desktop width (mock recall, forward and backward traces) and phone width.

## Known limits

- Plain stock after receiving is not traceable by lot (by design, see above); tracking the material by roll or pallet fixes it.
- Receipts of labelled rolls and pallets are not linked to a purchase order yet (unit receiving has no order link), so a backward trace shows the lot and date but not the PO for those.
- There is no customer or shipment step (no sales orders), so a forward trace ends at "where it is now".
- Output scrap on unit-tracked output isn't recorded, so scrapped output isn't in the trace.
- A very large trace is capped (2,000 steps) rather than paged.
