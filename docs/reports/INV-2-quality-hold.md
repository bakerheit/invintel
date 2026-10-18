# INV-2: Quality hold and NCR

Owner: Eli. Branch: `inv-2/quality-hold` (the shared schema piece for INV-1/2/6 is its first commit). Ticket: INV-2 on the Invintel board.

## What it does

- **Put stock on hold.** Desk: **Quality** > "Put something on hold" (pick an item, where it is and how many, or switch to "Roll or pallet" and type or scan the label). Floor: **Floor mode > Quality hold** (scan a label or an item, tap where, how many, and a reason). Any member can do this.
- **What a hold does.** Plain stock moves into an automatic place called **Quality hold** (a new location type, "quarantine"). A labelled roll or pallet stays where it is and its status becomes quarantined. Each hold is an **NCR** with a number (NCR-0001), a reason from a short list, a note, the supplier lot, and who and when.
- **Held stock is frozen.** It can't be moved, adjusted, received into, counted, loaded onto a machine, used from a roll or reversed from Activity. The only way out is a decision.
- **Decisions (admin only), partial or whole:** use as is, rework (both release the stock to a place you pick, default where it came from), scrap (needs a reason from the scrap list; the ledger line carries it) or return to supplier. Quantities add up: you can decide 2 of 5 and the rest stays open; the NCR closes when nothing is left. A labelled unit is always decided whole.
- **Inspect before release.** The floor Receive screen, the purchase-order receive dialog and the unit receive screen have an "Inspect before release" switch: what arrives is received (it counts against the order) and goes straight on hold as "Awaiting inspection", linked to the order and its supplier lot.
- **Supplier lot on receipts** (shared piece): an optional lot on floor receipts, PO lines and unit receipts, kept on the ledger line and shown in Activity. Used by INV-1.
- **Reason lists** (shared piece): hold reasons and scrap reasons, editable by admins (Quality > Reason lists), with defaults. INV-6 uses the scrap list.
- Everything audited: `ncr.opened`, `ncr.dispositioned`, `reasons.changed`; each stock change is a ledger line tagged with the NCR id.

## How to try it

`pnpm --filter @invintel/api seed:demo` (the demo now has a hold of 3 bags of starch), sign in, **Quality**: the open hold shows. Click it, choose Scrap 2 with a reason, record, then release the rest: it closes. On a phone-sized window open Floor mode > Quality hold, scan `STRAP-PP`, pick the place and a reason. In Purchasing, open an order, tick "Inspect before release" and receive.

## Decisions I made

- **Plain stock moves to a hold place; units keep their place.** Moving plain stock keeps stock rows honest (held stock isn't "available"), and the existing unit status covers rolls without a second copy of the stock.
- **One hold area per organization**, created on first use, location type "quarantine". Ordinary moves, adjustments, receipts and counts into or out of it are refused (409): held stock is managed from Quality only. A hand-made location of this type becomes a hold area too.
- **Decisions are admin-only, holds are for everyone**, because stopping something is cheap and safe while deciding changes stock.
- **No module switch** for Quality yet (it would change the switches test and settings page); it is always on.
- **Scrap reasons are the org's scrap list** (shared with INV-6), validated case-insensitively and stored with the list's spelling.
- **Activity won't reverse NCR lines** (409, "Decide it from Quality"), and the floor Receive screen hides Undo for a held receipt, so the NCR and the stock can't drift apart.
- **Inspect-before-release posts two things**: the receipt, then the hold (a transfer into the hold area). If the hold fails after the receipt, the API says so and the stock stays received.

## Tests

`apps/api/src/quality.test.ts` (10 tests) and `reasons.test.ts` (2): hold of plain stock (moves, NCR fields, ledger pair tagged with NCR and lot, audit); bad holds (too many, unknown reason, missing fields, unit-tracked item without a unit, already held); guards (moves in and out, adjust, receive into the hold area, Activity reversal); use/rework partial and whole with default and chosen place, closed holds, over-deciding, admin-only; scrap reason required and validated, scrap and return ledger types, partial scrap; two decisions at once can't take more than is held; units (held in place, can't be used, moved or held again; release, scrap, return, decided whole); inspect before release for floor, PO and unit receiving; organization isolation and the status filter; reason lists (defaults, admin-only, validation, audit, per org); supplier lot on floor, PO and unit receipts and in Activity. Whole API suite and typecheck and build green. Clicked through in a browser: desktop (hold, partial scrap, release, close) and a phone-sized window (floor hold flow, desk form).

## Known limits

- Held stock still counts in stock totals and value (it is physically there); it just can't be used. A "stock on hold" figure on the Overview and an alert for old holds are not built.
- Holds apply to whole items and units; there are no lot-level holds on plain stock (plain stock has no lots).
- No attachments or photos on an NCR, no cost of poor quality figure, no supplier notice.
- A count of the hold area is refused rather than reconciled.
- Rework does not track the extra work; it just releases the stock.
