# Invintel workflow proposal (draft for Andrew)

Status: draft by Will. Competitor findings from Eli (`competitors.md`) are still to be folded in. Corrections from Andrew's plant experience are the most valuable input here.

## 1. The idea in one paragraph

Invintel follows material from the dock to the customer: it arrives, gets put somewhere, moves around the plant, gets loaded into a machine or work area, gets consumed to make something else, and the output goes back into stock. Every one of those steps is a *recorded event* that posts to an append-only ledger. Stock levels are what the ledger adds up to. Plant workers record events with a scanner and a couple of taps; planners and buyers use the same events to see what's short, what's late and where waste is happening.

## 2. Principles

1. **Record what happened, don't edit a number.** The UI never has a "set quantity" box. It has Receive, Move, Load, Report, Count. Each posts ledger lines. Mistakes are reversed, not overwritten.
2. **The two-scan rule.** The most common floor action (move) should be: scan the thing, scan the place. Everything else is a variation.
3. **One screen, one decision.** Floor screens show one prominent action per step. Gloves, glare and forklifts are the design constraints, not an afterthought.
4. **Start simple, grow without rewrites.** A small shop uses quantities and locations. A plant adds unit-level tracking, work centers and BOMs. These are optional dimensions on the same model, not a second product.
5. **Variance is a feature.** Expected usage (from the BOM) vs actual usage is the main signal for waste, bad recipes and reporting problems.

## 3. Domain model

| Thing | What it is |
| --- | --- |
| **Item** | A material or product. Type: raw material, component, finished good, supply. Tracking mode: by quantity, by lot, or by unit (each roll/pallet is its own record). Base unit of measure plus conversions (kg to lb, sheets to MSF, and so on). Optional attributes (width, grade, etc.). |
| **Stock unit** | A physical thing with a barcode: a roll, a pallet. Has an item, lot, quantity (which can shrink), location, status (available, quarantined, consumed). Only for items tracked by unit. |
| **Location** | Hierarchy (site > area > bin). Has a *type*: receiving, storage, WIP, production area, finished goods, shipping. |
| **Work center** | A machine, line or cell. It has a production-area location where material is staged ("at the machine"), a status, and later a capacity. |
| **BOM / routing** | Recipe: inputs per unit of output, scrap/yield %, optional co-products, plus the ordered operations at work centers. Versioned. |
| **Work order** | A production run: item, quantity, due date, status (planned, released, running, done, closed), required materials from the BOM, actual consumption, outputs, scrap. |
| **Ledger line** | Immutable: item, unit (if any), from and to location, quantity, unit of measure, type, source document, who, when, reason. |
| **Documents** | Receipt, Move, Load, Consume, Produce, Scrap, Adjust, Count, later Ship. Each posts ledger lines. |

Quantities per item: on hand, reserved for work orders, on order, in transit. Available = on hand minus reserved. The ledger is authoritative; on-hand tables are rebuildable from it.

## 4. The flows

**Plant floor (handheld, kiosk, tablet):**

1. **Receive** — scan or pick the PO/supplier, enter quantities (or weigh), print labels, system suggests a putaway location, scan to confirm. Variance vs expected is captured with a reason.
2. **Move** — scan the unit, scan the destination. Done.
3. **Load** — scan the unit, scan the machine (or the work order). The unit is now "at" that work center. The screen shows what the work order needs next.
4. **Report usage** — at roll change or end of run: record what's left (weight/length) or mark fully consumed. The system books consumption, and a partly used roll goes back to stock as a remnant with its new quantity (or to scrap, with a reason).
5. **Report output** — good quantity produced (and scrap), producing finished-goods units (pallets of boxes) into WIP or finished goods.
6. **Count** — walk a location, scan what's there, system shows variances for review.

**Office:**

7. **Plan** — see demand (orders, forecast), net against stock and incoming, get shortage list and suggested production and purchase orders; release work orders.
8. **Buy** — suppliers, POs, receiving against POs.
9. **Review** — approve variances over threshold, review waste/yield, reverse mistakes, see inventory value.

## 5. Module map and phasing

| Phase | Ships | Why this order |
| --- | --- | --- |
| **0. Foundation** | Ledger as the source of truth with documents (Receipt, Move, Adjust), reason codes, an Activity screen to browse and reverse, location hierarchy with types, units of measure | Everything later posts to this. API for movements already exists. |
| **1. Floor app** | Scan-first Receive, Move, Count in a phone/handheld-friendly mode, label printing (Code 128/QR), unit-level tracking | Most users are plant workers moving stock. Highest daily value. |
| **2. Production** | Work centers, BOM and routing, work orders, Load / Report usage / Report output / Scrap, remnants, variance report | This is the "resource use" step. |
| **3. Planning and purchasing** | Demand entry or import, MRP netting, shortages, suggested POs/work orders, suppliers and POs | Turns recorded flow into forward-looking decisions. |
| **4. Scheduling and reach** | Finite scheduling on work centers, sales and shipping, costing, import/integration with existing ERPs, reports | Heavier and riskier; needs real data from phases 1-3. |

## 6. UX plan

Two surfaces, one app:

**Floor mode** (`/floor`, installable PWA): big type and targets, high contrast, scanner input always focused (works with keyboard-wedge scanners and phone cameras), a launcher with five tiles (Receive, Move, Load, Report, Count), one primary action per step, instant color-and-sound confirmation, "undo last" for a short window, large clear error states. Offline queue is a later phase but the design assumes it.

**Desk mode** (current app, extended): grouped sidebar (Overview, Inventory, Production, Planning, Purchasing, Settings), an Overview of things that need attention (shortages, low stock, late work orders, variances to approve), a global Record (+) action, a command palette for power users, tables with saved filters, an Activity ledger with filters by item, location, type, user.

**First things to build** (each useful on its own):
1. Activity screen over the existing movements API, with reason filter and a Reverse action.
2. Location types and hierarchy (tree view), including a "production area" type.
3. Floor mode shell with Move and Receive, usable today by typing or pasting codes.
4. Reason codes and document numbers on adjustments and transfers.

## 7. Questions for Andrew

1. Were rolls/pallets tracked individually with their own barcode (and a remaining weight/length), or by lot and quantity?
2. How did operators report usage: at each roll change, at end of order, or automatically from sensors? Measured, or calculated from the BOM?
3. Who decided a run was "done" and how was good quantity counted (operator entry, counter, pallet labels)?
4. Where did orders come from: entered in this system, or imported from a customer/ERP system?
5. How many sites, and did material move between them?
6. What devices were on the floor: rugged Android handhelds, fixed kiosks at machines, forklift tablets?
7. Trim waste on a corrugator: part of yield, or tracked separately?
8. Was costing in scope for the first version, or just quantities?

## 8. Risks

- **Scope.** This is a multi-year suite. Phases are chosen so each one is useful alone.
- **Accuracy of backflush.** It's only as good as BOMs and reporting; counts are the safety net (and the first thing to build after production).
- **Floor ergonomics.** Everything here about gloves, glare and scanners comes from vendor guidance. We need to test with real devices and operators.

## 9. What the competitor research changes (added after Eli's report)

Source: `docs/research/competitors.md` (Eli). Several of its claims are marked unverified there, and it found no public detail on Apex or on how corrugated vendors handle partial rolls, so treat those as questions for Andrew rather than facts.

**It confirms the core design.** The recurring failures across Epicor, Katana, Odoo, Fishbowl and ERPNext are the ones this proposal was built to avoid: stock that only moves when an order completes (Katana), backflush that silently does nothing (Epicor), backflush that can't handle lot/serial-tracked items (Epicor, Infor), production reporting that's desktop-only (Fishbowl Go, Odoo Shop Floor), and free "set quantity" edits that wreck accuracy (Fishbowl). Ledger-first posting, scan-first Floor mode and explicit unit consumption are the right bets.

**What it changes or sharpens:**

| Change to the plan | Why |
| --- | --- |
| **Consumption is hybrid, not pure backflush.** Load defines what's at the machine; reporting usage pre-fills the BOM-expected amount and the operator confirms or edits it. Unit-tracked items are always explicit (scan the roll, enter what's left). | ERPNext's "material transferred for manufacture" and Katana's pre-filled actuals work; Epicor's pure backflush is brittle. Rolls are the case where the ledger needs explicit unit usage. |
| **Outputs are typed lines**: good, scrap, co-product, remnant. Scrap posts to a scrap location like any other movement, and finished goods can be scrapped from the floor. | Odoo, ERPNext and Infor each bolt scrap and by-products on separately. One concept is simpler. |
| **No silent failures.** Show a posting preview and a plain reason when something didn't consume or post. | The most repeated complaint against Epicor. |
| **Progressive complexity.** Start as quantities and locations; switch on units, work centers and BOMs per item. Offer templates (roll item, pallet item). | Implementation time and learning curve dominate complaints at every size. |
| **Design for offline** (queue, idempotent posting, visible sync state) even though full offline is later. | Soft evidence, but expensive to retrofit. |
| **Open data**: CSV import/export and a documented API for everything. | Lock-in complaints about Katana and Odoo. |
| **Barcodes on orders and operations**, not only items. | MRPeasy: scan a work order to jump straight to reporting. |
| **Units can exist before they arrive** ("in transit"), confirmed at receiving. | Amtech's ASN visibility. Not built. |

**Where this stands against what's built (as of the phase 1 branch):**

| Item | Status |
| --- | --- |
| Ledger with reversal, reason on every line, audit log, verify tool | Built (audit log, Activity, reversals). Structured reason codes: not built. |
| Scan-first Floor mode: Receive, Move, Look up | Built, with camera scanning and one-tap undo (not for units yet). |
| Floor Count | Not built. |
| Unit-level stock with shrinking quantity | Built: receive, move, use some, retire at zero, labels. |
| Report usage returns a remnant to stock | Eli's production code does this on the same unit (leftover stays on the roll; moved back via `moveUnit`). Floor UI for it is not built. |
| Hybrid consumption, variance view, typed outputs, posting preview | Eli's production branch (API). |
| CSV import/export | Built on main. |
| Offline queue | Not built. |
| Barcodes on orders; in-transit units | Not built. |

**Open questions this adds for Andrew:** is a roll's base unit weight, length or area (the research says the choice drives everything downstream), and how do their plants record remnants and trim today?
