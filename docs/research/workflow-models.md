# Inventory workflow models, and where Invintel stands

Written by Will. Sources are vendor docs and practitioner guides, so treat them as examples of common patterns, not standards. Competitor product research is in `competitors.md` (Eli).

## 1. The classic flow

Almost every WMS/ERP inventory module runs the same loop, with different amounts of ceremony:

| Stage | What happens | Typical control |
| --- | --- | --- |
| Receive | Goods arrive and are checked in, often against a purchase order. Partial receipts and variances are normal. | Expected vs received qty, variance reason |
| Putaway | Received stock is sent to a bin or location and confirmed. | Scan location + item |
| Store / move | Stock sits, gets replenished, moves between locations. | Transfer documents, sometimes with an in-transit state |
| Pick | Stock is allocated and pulled for an order (discrete, batch, wave, or zone picking). | Reservation / allocation |
| Pack / ship | Contents verified against the order, labels generated. | Double-check scan |
| Count | Rolling cycle counts instead of one annual stocktake. | Variance thresholds, approval |

Sources: [Cleverence: warehouse stock management](https://www.cleverence.com/amp/articles/for-business/warehouse-stock-management-system-5827/), [Racklify: WMS core features](https://racklify.com/encyclopedia/what-is-a-warehouse-management-system-core-features-and-benefits/), [Gestisoft: WMS components](https://www.gestisoft.com/en/blog/components-of-warehouse-management-system) (suggests rolling out in order: visibility and master data, then receiving and putaway, then pick and pack, then shipping and counts).

## 2. Design patterns worth borrowing

**Ledger first.** Stock movements are append-only records. Corrections are reversals or adjustment entries, never edits. On-hand is derived by summing movements; most systems also keep a materialized on-hand table for speed, with the ledger staying authoritative and a way to rebuild the table from it. Some model every move as a paired debit (source) and credit (destination). ([SKU.io movement ledger](https://docs.sku.io/guides/inventory/the-movement-ledger), [Cleverence: inventory design pattern](https://www.cleverence.com/articles/for-business/inventory-design-pattern-5381/))

**Several quantities, not one.** On hand, reserved/allocated, on order, in transit. Available to promise is roughly on hand minus reservations plus expected receipts. Terminology varies by product. ([SKU.io](https://docs.sku.io/guides/inventory/the-movement-ledger), [Odoo ATP add-on](https://apps.odoo.com/apps/modules/13.0/stock_available_to_promise_release))

**Counts are a workflow, not a field edit.** Rolling cycle counts prioritised by ABC class (high-value items counted most often; frequencies vary by vendor, so set against your own data). Counter, verifier and approver are separate roles in bigger operations (one person can hold several in a small one). Variances above a percentage or value threshold are held for approval; approvers can accept or send back for a recount, with a cap on recounts. Adjustments carry reason codes that feed root-cause review. ([Oracle cycle count setup](https://docs.oracle.com/cd/A60725_05/html/comnls/us/inv/ccdef.htm), [Infor LN cycle counts](https://docs.infor.com/ln/10.4.in/en-us/lnolh/help/wh/onlinemanual/000000000000006.html), [Cleverence cycle counts](https://www.cleverence.com/articles/for-business/cycle-counts-procedure-4726/))

**Replenishment.** Min/max: reorder point at or just above the minimum (reorder point is often average daily demand x lead time + safety stock), order quantity is max minus current stock. Simple, cheap, easy to explain; picking the numbers is the hard part. ([Shopify: min/max](https://www.shopify.com/blog/min-max-inventory))  My search found little on PO and receiving detail, so that part of this doc rests on general knowledge and Eli's research.

**Lots, serials, units.** Serials identify one unit; lots group identical units. Picking policy (FIFO, FEFO, closest location) is configurable and separate from costing (standard, FIFO, average). Store everything in a base unit and convert at the edges (receive 2 crates of 12, hold 24 each). ([Fulfil](https://www.fulfil.io/products/inventory-management/lot-tracking/), [Visma lot/serial tracking](https://help.content.visma.net/Norway/NO_EN/online-help/shared-files/IN/in-lot-serial-number-tracking-con.html), [Odoo traceability and valuation](https://open-exam-prep.com/study-guides/odoo-19/inventory-warehouse/traceability-valuation))

## 3. Audit: what Invintel has today

Built and working: organizations and roles, locations, items with a reorder level, per-location stock, adjust (+/-), instant transfer, and a stock movement collection that records every change with who made it.

| Capability | State | Notes |
| --- | --- | --- |
| Immutable movement ledger | Partial | Movements are append-only and carry user, location, reason, transfer id. No reversal flow, no document concept, and on-hand is stored separately with no rebuild/verify tool. No UI to browse the ledger at all. |
| Receiving | Missing | Today "receive" is an adjustment with free text "Initial stock" or whatever the user types. No expected vs received, no supplier, no PO. |
| Putaway | Implicit | Receiving picks a location, but there is no bin hierarchy (warehouse > zone > aisle > bin). Locations are flat. |
| Transfers | Basic | Instant, single step. No in-transit state, no approval. |
| Adjustments | Basic | Free-text reason only. No reason codes, no approval threshold. |
| Cycle counts | Missing | No count sheets, variance, or approval. |
| Replenishment | Minimal | A reorder level flags "Low", with no target level, no supplier or lead time, no suggested order. |
| Purchasing | Missing | No suppliers or purchase orders. |
| Outbound (orders, reserve, pick, ship) | Missing | Everything is on hand. There is no reserved or available quantity. |
| Lots, serials, expiry | Missing | |
| Units of measure | Missing | Whole units only. |
| Barcodes / scanning | Missing | SKU is typed. |
| Costing | Minimal | One unit cost per item. No valuation method, no landed cost. |
| Reporting, alerts, import/export | Missing | |

## 4. What this suggests

Invintel's data model is already shaped like the right thing (items x locations x movements with an actor). The gap is mostly workflow and UX: stock changes are presented as "edit a number" instead of "record what happened". See `workflow-proposal.md` for the proposed flow.

## 5. Added after Andrew's steer: plant and production flows

Andrew's context: many users at Kiwiplan and Apex were plant workers moving inventory, and some loaded it into resource-use areas where raw material is converted into product (paper into a pizza box). So the target is an ERP-style suite: inventory, planning, resource use.

**Corrugated flow, as described by public vendor/patent material.** Roll stock is received into storage, moved to the corrugator's wet end where paper is glued into continuous board, then cut and stacked into a WIP area before the folder-gluers. Roll-tracking products scan rolls to identify supplier, amount and location, follow each roll from order through transit, receipt, staging and consumption, and in some cases use roll-stand sensors that measure lineal footage and detect splices. Vendor claims about waste reduction are unverified. I found nothing public on partial-roll remnant handling; that's a question for Andrew. ([ePS CorrTrac and Amtech RIMS via search](https://www.amtechsoftware.com/solutions/manufacturing-execution/rollstock-management/), [roll tracking patent](https://patents.justia.com/patent/20180053154), [ePS corrugated suite](https://epssw.com/corrugated-suite))

**Production mechanics.** A bill of materials plus a quantity completed implies component usage. *Backflushing* deducts that implied usage in one step instead of scanning every component, which suits repetitive work but depends on accurate BOMs and reporting, so ERPs pair it with cycle counts. Scrap and yield percentages on the BOM or routing adjust the calculation, and the gap between expected and actual usage is how you spot scrap, bad BOMs or reporting errors. ([ERP Research: backflushing](https://erpresearch.com/glossary/backflushing), [Oracle JD Edwards: backflush](https://docs.oracle.com/en/applications/jd-edwards/supply-chain-manufacturing/9.2/eoash/completing-work-orders-through-backflush.html))

**Planning mechanics.** MRP nets gross demand against on-hand plus scheduled receipts, offsets by lead time, and explodes down the BOM with scrap/yield, producing planned orders. Classic MRP assumes infinite capacity; capacity planning and finite scheduling (sequencing by priority, setup families, tooling and labour constraints) are layered on, and a common pattern is MRP for materials plus a finite scheduler for the short horizon. ([Cleverence: MRP overview](https://www.cleverence.com/articles/oracle-documentation/overview-of-material-requirements-planning-4729/), [MetricGate: MRP](https://metricgate.com/docs/material-requirements-planning/))

**Plant-floor UX.** Guidance converges on: scan-first flow where the scanner is always ready for the next code, immediate visual (and optional haptic) confirmation, one prominent action per step, large touch targets usable with gloves (one source suggests 60px minimum, 72px for primary actions, 16px between; validate with real gloves), high contrast for dirty screens and glare, and offline tolerance with a clear indicator and sync. ([Racklify: warehouse UI guidance](https://racklify.com/encyclopedia/designing-warehouse-software-user-interfaces-practical-guidance/), [Microsoft Dynamics 365 warehouse mobile app](https://learn.microsoft.com/en-us/dynamics365-release-plan/2021wave1/finance-operations/dynamics365-supply-chain-management/warehouse-management-mobile-application))

### Additional audit rows for the ERP scope

| Capability | State |
| --- | --- |
| Item types (raw, component, finished, supply) | Missing |
| Unit-level tracking (roll, pallet) with variable quantity and barcode | Missing |
| Location types (storage, production area, WIP, shipping) and hierarchy | Missing |
| Work centers (machines, lines) | Missing |
| BOM and routing | Missing |
| Work orders: load, consume, produce, scrap | Missing |
| Variance (expected vs actual usage), yield, waste reporting | Missing |
| MRP, shortages, planned orders | Missing |
| Floor (handheld/kiosk) UI | Missing. Current UI is a desk web app. |
