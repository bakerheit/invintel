# Competitor research for Invintel (manufacturing / plant ERP direction)

Author: Eli. Date: 2026-10-18. Time-boxed desk research, public sources only (vendor pages and docs, review sites, forums). No insider knowledge is claimed anywhere in this file. Anything I could not confirm from a source is marked "(unverified)". Review-site AI summaries and comparison aggregators (rfp.wiki, ToolRadar, Dupple) are low-confidence and flagged as such.

How this fits: it follows the model in `workflow-proposal.md` and `workflow-models.md` (ledger-first stock, scan-first floor UX, work centers, BOMs, work orders, Load / Report usage / Report output, variance, rolls and pallets as stock units, phases 0-4).

Honest caveat up front: public evidence on plant-floor roll handling is thin. Corrugated vendors publish marketing, not docs, and I found no independent user reviews of Kiwiplan's roll module. The strongest "what users hate" evidence comes from Epicor and Odoo/ERPNext forums, Katana and Fishbowl reviews, and the general review sites.

---

## 1. Comparison table

Products covered: 12 (Kiwiplan, Amtech, ePS CorrTrac/Pace, Plex, Tulip, Epicor, Infor, Odoo, ERPNext, MRPeasy, Katana, Fishbowl). Apex has no usable public info (see section 2.2).

| Product | Segment | BOM / work orders | Floor UX | Unit / roll tracking | Pricing signal | Biggest complaint |
| --- | --- | --- | --- | --- | --- | --- |
| Kiwiplan (Advantive) | Corrugated, folding carton, plastics; ERP+MES | Order mgmt, scheduling (CASE), MES; details not public | "Shop floor data collection" in MES; handheld/barcode details not public | Roll Stock System (order to consumption); Unit Load Tracking for WIP and finished goods | None public | No independent complaints found (unverified); only vendor-side comparisons |
| Amtech (Axiom / EnCore, RIMS) | Corrugated, sheet feeders, labels | ERP+MES; details not public | Roll-stand sensors read footage and splices | Per-roll lifecycle: ordered, in transit (mill ASN), received, staged, consumed | None public | No public complaints found (unverified) |
| ePS (CorrSuite / CorrTrac, Pace) | Corrugated, packaging ERP+MES | CorrPlan, CorrTrim, MES modules | Rolls scanned for supplier, qty, location (one customer case) | CorrTrac roll stock; location and status | None public (Pace: "on request") | Pace reviews: ease of use 3.31, value 3.25 (Software Advice); cluttered GUI, heavy customization upkeep |
| Plex (Rockwell) | Mid-large discrete manufacturing, ERP+MES | Full ERP/MES, workcenter control panels | HMI per work center; labels printed per container; blocks untrained operators | Container/pallet and serialized labels (customer testimonials) | Quote-based (unverified); value for money 3.8 (Software Advice, n=15) | Steep learning curve; ~8 months to implement (G2) |
| Tulip | Frontline ops, no-code apps, sits beside an ERP | Apps and work-order dispatch; not a system of record for stock (unverified detail) | Operator apps, big-screen friendly, no-code | Via apps; depends on the ERP (unverified) | $100 / $250 per interface per month (Essentials / Pro, ToolRadar); $1,200 / $2,400 per year (TrustRadius) | Per-interface cost scales fast; limited features cited in 3 of 36 G2 reviews |
| Epicor Kinetic | Mid-large discrete, ERP with MES / Data Collection | Jobs, operations, materials with "related operation" | Data Collection (ex-MES): clock on/off, report qty | Lot / serial supported but cannot be backflushed (forum) | Quote-based (unverified) | Backflush rules are fiddly and fail silently (forum threads, older 10.x versions) |
| Infor (SyteLine / CSI, LN, FactoryTrack) | Mid-large discrete | Routing-driven backflush, pick lists, jobs | Dated UI is a recurring theme (rfp.wiki, low confidence) | Lot / serial need backflush flags on two forms | Quote-based (unverified) | Dated UX, steep admin curve, services-heavy upgrades (rfp.wiki; low confidence) |
| Odoo Manufacturing | Open core, SMB to mid | BoM, operations, work centers, by-products, flexible consumption | Shop Floor (tablet view) | Lots / serials; UoM per BoM line | Quote/subscription (unverified figures); one Capterra reviewer calls cost "predictable" | Painful implementation, upgrades break custom modules, partner support (Capterra) |
| ERPNext (Frappe) | Open source, SMB | BOM, work order, job cards, production plan (MRP) | Job card on terminal/tablet (vendor guide) | Batch / serial; UoM conversion awkward in WOs (forum) | Open source (not confirmed in this pass; unverified) | No finite scheduling; one machine per operation; UoM conversion pain (forum) |
| MRPeasy | Small manufacturers, cloud MRP | MO, routing, drag-drop scheduling | Browser kiosk for shop floor reporting; barcode on higher editions | Lot tracking all plans; UoM conversions listed | $49 / $69 / $99 / $149 per user per month (Capterra); other sources differ | Documentation 3.4, ease of use 3.6 (Dupple); thin evidence |
| Katana | Small product makers, e-commerce | MO with tasks, ingredients, optional actual usage | Shop Floor App; barcode scanning | Batch numbers; limited serial tracking | Tiered by order count (complaints); no figures verified | Price jumps by order volume, bugs, fraction handling in recipes |
| Fishbowl | SMB inventory + manufacturing | BOM, WO, yield calc, disassembly, reverse MO | Fishbowl Go: Move, Add, Scrap, Cycle count; WOs done in desktop (integrator note) | Lot / serial, barcode | Contact vendor (no public figure) | Rigid, inventory inaccuracies, steep curve, support, thin reporting (GetApp / Capterra / Xero) |

---

## 2. Corrugated / packaging

### 2.1 Kiwiplan (Advantive)

**What it does well (vendor-stated).** Integrated ERP + MES for corrugated, folding carton and plastics. Modules relevant to us:
- *Roll Stock System*: tracks ordering, receipt, movement, location and consumption of raw material and roll stock, and links inventory to production so the line is not waiting on paper.
- *Unit Load Tracking*: current location and movement of WIP and finished goods units, including when and which truck they shipped on. This is the pallet-level equivalent of what Invintel calls a stock unit.
- *Truck scheduling*, *Supply Chain Simulator* (no detail published), corrugator scheduling that "replans 90 days ahead every 15 minutes" (vendor claim), trim minimization (vendor claims 1-3% yield gain, unverified).

**How it models our concepts (public level only).**
- BOM / work orders / work centers: not documented publicly. The MES is described as production planning, tooling, shop-floor data collection, KPIs, quality.
- Consumption manual vs backflush: not stated. Roll Stock "consumption" is mentioned, mechanism not.
- Scrap / yield: trim optimization is a planning-side feature (reduce trim when scheduling), not described as floor reporting.
- Co-products / remnants: nothing public.
- WIP and finished goods: Unit Load Tracking covers both, unit by unit.
- Planning: strongest public area (scheduling, load building, trucks).

**Plant-floor UX.** The Advantive pages I could read do not mention handhelds, barcodes or mobile at all. Unverified either way.

**What people hate.** Nothing independent found. Capterra and Software Advice listings carry no ratings or complaints (Capterra shows a placeholder). Advantive's own "outperforms generic ERP" post claims generic ERPs need heavy configuration for corrugated, which is a vendor argument, not a complaint.

**Roll/pallet tracking and units.** Roll-level tracking is claimed; unit-of-measure handling (weight vs linear feet vs MSF) and partial-roll remnants are not public.

### 2.2 Apex-style plant software

I found no public information on Apex Supply Chain Technologies serving corrugated or paper. Searches returned unrelated "Apex Real Time Solutions" (an African warehouse automation firm) and trade-press tags that talk about WMS, voice picking and AMRs generally. I will not infer details. Apex and Kiwiplan being linked in Andrew's background is his knowledge, not something I can source. Treat the entire Apex section as **"no public info"**.

### 2.3 Amtech Software (Axiom, EnCore, RIMS)

- Roll Stock Information Management (RIMS) follows each roll through order, transit (it ingests mill advance ship notices), receipt, staging and consumption.
- Uses automated roll-stand sensors that measure lineal footage and detect splices on the corrugator, and feeds roll data back into the trim algorithm and the schedule (vendor-stated).
- Good: planning against paper that has not arrived yet; per-roll lifecycle; sensor-based consumption rather than operator estimates.
- Gaps in public info: weighing, remnant return-to-stock, scrap reasons, pricing. The page itself returned HTTP 403 to my direct fetch; this is from a search summary of the page (verify before relying on it).
- Complaints: none found.

### 2.4 ePS (CorrSuite, CorrTrac, Pace)

- CorrTrac: roll stock inventory with real-time status and location, inside CorrSuite alongside CorrPlan and CorrTrim.
- One customer case (FEPA, Italy): rolls are scanned to record supplier, quantity and location, movements reported back to SAP through CorrTrac, POs flow into CorrTrac to guide production. This is a single testimonial.
- Pace (older EFI product): Software Advice 3.7 from 84 reviews; lowest sub-scores ease of use 3.31 and value 3.25. Reviewers mention heavy time spent on maintenance and customization, and a cluttered GUI for new users.
- Not found: how partial rolls are handled; pricing.

### 2.5 Others seen

- Radius (ePS Packaging Suite): aimed at flexible packaging, not corrugated.
- Sonoco Intellicore: embedded core ID for automatic roll tracking, aimed at "ghost" inventory. Mentioned only as evidence that lost/partial rolls are a known problem. Details unverified.
- A single vendor blog cited an IDC MarketScape 2026 ranking for packaging ERPs; I could not verify it. Ignore.
- Sage 500 community thread: rolls vary in weight within one order and there is no out-of-the-box way to handle variable UoM; general ERPs need custom work for weight-based remnants. This is the clearest public statement of the gap Invintel can fill.

---

## 3. MES / ERP, mid to large

### 3.1 Plex (Rockwell Automation)

- **Good:** work center control panels ("who, what, where, how"), can block untrained operators or wrong containers; labels printed per container so each pallet/container comes out with a barcode; history by part per step and operator; workcenter log of production, maintenance and downtime events. All from Rockwell/Plex white papers and customer testimonials, so promotional.
- **Material flow:** one customer says material must be loaded before a tag can be printed, then new containers are started and production recorded each time a pallet comes out. That is a Load -> Report output flow very close to Invintel's.
- **BOM / backflush / scrap / yield / planning:** no public docs found in this pass (unverified).
- **Complaints:** G2 3.9 from 72 reviews, main theme steep learning curve (AI summary, medium confidence); implementation time listed as 8 months on G2; value for money 3.8 and support 3.8 on Software Advice (n=15). Low-confidence aggregator mentions mobile app stability and offline edge cases (rfp.wiki, 37% stated confidence, treat as a hint only).

### 3.2 Tulip

- **What it is:** no-code platform for building operator apps; guides operators, collects data from people, machines and devices. It is a floor layer, usually next to an ERP. Integrations named by a comparison site: SAP, NetSuite, Dynamics 365, Oracle (Plex and Epicor not named). Tulip's own text says ERP connection ease depends on your IT setup. HTTP connectors and an Open API exist.
- **Good:** fast time-to-value for custom floor apps, reviewers find it easier to set up than Augmentir (G2); 4.5 from 36 reviews. Work-order dispatch is rated a strength by comparison sites (low confidence).
- **Roll / unit tracking, BOM, backflush, scrap:** it is whatever you build; not a stock ledger (my reading, partly unverified).
- **Pricing:** $100/month (Essentials) and $250/month (Professional) per interface (ToolRadar); TrustRadius quotes $1,200 and $2,400 per year per interface; Enterprise by quote. Essentials caps at 50 interfaces / 150 operators.
- **Complaints:** per-interface pricing "escalates" as you add stations (ToolRadar); "limited features / functionality" in 3 of 36 G2 reviews; building from scratch can be hard (a Gartner reviewer, paraphrased from a search summary because the page returned 403). Offline behavior: not found.

### 3.3 Epicor Kinetic

- **Model:** jobs with operations and materials. Materials carry a "related operation"; backflush happens when quantity is reported against that operation via Data Collection (formerly MES). There is also a Backflush checkbox at job close.
- **Floor UX:** Data Collection to clock on/off and report quantities. Details of the current Kinetic UI not verified.
- **Hates (epiusers.help forum, 10.x era):**
  - Backflush silently did nothing after quantities were reported; the cause was one of several config conditions (part flag, warehouse/bin, related operation with labor reported, a non-backflush final operation, lot tracking).
  - Lot- and serial-tracked items cannot be backflushed and must be issued manually.
  - Receiving to inventory before materials are issued can lock in wrong costs, and over-receipts are not blocked by default (a BPM is needed).
  - A costing complaint about labor posting with blank setup time when auto-receipt is on (one user; unconfirmed).
- **Takeaway:** the rules for "when does it consume" are hard to see and hard to debug. Forum answer is "run the backflush process on a schedule" or "add a dummy last operation".

### 3.4 Infor (SyteLine / CloudSuite Industrial, LN, FactoryTrack)

- **Backflush:** routing-driven. Needs a backflush location in Inventory Parameters; lot/serial items need the flag on both Inventory Parameters and the Items form. Pick lists mark backflush items with qty to issue 0 and a "BACKFLUSH ITEM" comment. Job Operation Status Report shows whether an item is backflushed and from where. Infor warns that no error is raised if you backflush an item flagged Obsolete or Slow Moving.
- **FactoryTrack Job Material Issue:** a by-product action type exists and disables the backflush and issued fields (by-products are first-class).
- **Complaints (rfp.wiki aggregate, low confidence):** dated UX versus cloud-native ERPs, steep admin curve, services-heavy upgrades and migrations, uneven implementations. Review averages cited: Capterra 3.9 (66), Software Advice 3.8 (68), Gartner Peer Insights 4.3 (59). Not shop-floor specific.

---

## 4. Open source and SMB

### 4.1 Odoo Manufacturing

- **BOM / WO / work centers:** BoM with operations on work centers, duration tracked or fixed, per-operation work sheets (PDF, slides, text). Enable Work Orders in settings.
- **Consumption:** per-component "Manual Consumption" flag; if the operator does not tick Consumed, a warning appears and the qty must be entered before the operation can finish. "Flexible Consumption" on the BoM: Blocked / Allowed / Allowed with Warning. (From these docs I infer the default is automatic consumption; the docs page does not say so explicitly.) A third-party vendor (ECOSIRE) claims native Odoo makes operators register consumption move by move, which I could not confirm in Odoo's own docs. Treat as a vendor claim.
- **Scrap:** scrapped items go to a virtual scrap location (clean for the ledger). Manufacturing app: finished products can be scrapped only after the MO is Done; components only while Draft or Confirmed. Shop Floor module: components only, no finished goods. A "Replenish Scrapped Quantities" option creates a pick to replace scrapped components (two/three-step manufacturing).
- **Co-products:** By-products tab on the BoM: product, quantity, UoM, optional "Produced in Operation".
- **Floor UX:** Shop Floor module, tablet-oriented task view for operators. Detailed behavior for consumption and by-products in Shop Floor not verified in this pass.
- **Complaints (Capterra, ~1,300 reviews, 4.2):** painful implementation, customization is hard, version upgrades can break custom modules, partner support struggles to keep up with fast releases, some performance issues with big data or many apps, BI gap. Third-party apps cannot be used on Odoo Online (a module listing says so).
- **Units / lots:** lots and serials built in; guides warn that wrong lot entry hurts accuracy; serial tracking takes more effort than lots (consultant blogs). Roll-style variable quantities: not covered.

### 4.2 ERPNext (Frappe)

- **BOM / WO:** BOM, Work Order, job cards (operator starts/stops an operation on a terminal or tablet, logs completed and rejected qty and actual time, per a vendor guide), Production Plan as the MRP engine.
- **Consumption:** Manufacturing Settings has two backflush modes: "Material Transferred for Manufacture" (consume only what was moved to the floor) and "BOM" (consume BOM qty times finished qty). "Allow Continuous Material Consumption" lets you consume over time via separate Material Consumption entries, which update Consumed Qty on the Work Order and suggest the unconsumed remainder next time. "Validate Components Quantities Per BOM" flags edited quantities.
- **Scrap / co-products:** v16 replaces the "Scrap Items" table with "Secondary Items" (BOM docs). I did not find detailed steps.
- **Gaps (forum):** one user reports a work order issuing stock 1:1 and ignoring a pieces-to-kg conversion factor; another reports one machine per operation with no splitting of planned qty across parallel machines. Finite-capacity scheduling/APS is a stated gap (vendor guide). Both are single-user/vendor reports.
- **Takeaway:** "Material Transferred for Manufacture" is exactly Invintel's Load step used as the consumption base. That is a good model to copy.

### 4.3 MRPeasy

- Routing, manufacturing orders, scheduling with drag-and-drop calendar and Gantt (Capterra listing), shop floor reporting via browser kiosk (all plans per plan comparison), lot tracking, UoM conversions including vendor-based ones.
- Barcodes: official video says barcode support is an Enterprise edition feature. Manufacturing orders and operations have barcodes: scan the operation barcode to open that operation for reporting; stock lots get printed labels that open the lot page on scan.
- Pricing: Capterra lists $49 / $69 / $99 / $149 per user per month by plan; other sources show lower EUR figures and extra 10-user blocks. Conflicting; confirm before quoting.
- Reviews: Capterra ~4.5 (~164 reviews); Dupple 3.9 overall with documentation 3.4, ease of use 3.6, integrations 3.7. Thin evidence on complaints.
- Not found: how partial consumption is booked, how UoM conversion applies at consumption.

### 4.4 Katana

- **Model:** manufacturing orders with tasks and ingredients. By default Katana uses the planned ingredient quantity. If an admin enables it, the Shop Floor App asks the operator for actual consumed quantities when finishing a task: list pre-filled with planned, edit what differed, optional comment saved as an MO note with the operator's name. Barcode scanning speeds entry; batch numbers can be recorded.
- **Limits (Katana's own help article):** ingredients are not linked to tasks, so usage is reported per order; reported amounts do not reduce stock until the MO is completed; committed quantity stays at the plan until then.
- **Complaints (Software Advice, Capterra, Shopify app reviews, third-party roundup):** pricing tied to order count caused tier jumps ("$99 to $400" style anecdotes), bugs and slow fixes, no fraction support when recipes split units (Katana said it was on their radar), limited serial tracking, no Google Sheets export, pricey API, missing undo/backup, steep curve for people new to inventory. Third-party roundup lists Trustpilot 2.8 (unverified source quality).

### 4.5 Fishbowl

- BOM, work orders (assembly, sub-assembly, disassembly, repair, reverse MO), yield calculations, available-to-build, lot/serial, barcode.
- Fishbowl Go (mobile): Move, Add Inventory, Scrap, Cycle Count, Part. One integrator's support page says their team generally uses the desktop Client for work orders (i.e. production is not first-class on the handheld).
- UoM module with conversion rates exists; how conversions apply in work orders not found.
- Complaints: rigidity, inventory inaccuracies, steep learning curve (GetApp); slow support (Xero reviewer); limited custom reporting and recurring technical disruptions (Capterra pros/cons). Capterra shows 1,125 reviews with 84% positive.
- Pricing: contact vendor.

---

## 5. Patterns across the field

1. **Consumption timing is where ERPs go wrong.** Epicor (silent backflush failures), Katana (stock not reduced until MO completes, usage per order not per task), Odoo (manual vs auto flag, flexible consumption), ERPNext (two backflush modes plus continuous consumption). Nobody solves the roll-change case cleanly in public material.
2. **Unit-tracked items break backflush.** Epicor says lot/serial cannot be backflushed; Infor needs flags on two forms; Sage 500 has no variable-weight roll UoM. Rolls are the exact case where the ledger needs explicit unit consumption.
3. **Production is second-class on handhelds.** Fishbowl Go (WOs in desktop), Odoo Shop Floor (no finished-good scrap), Epicor needs a separate Data Collection client.
4. **By-products and scrap are bolted on.** Odoo tab, ERPNext renamed Scrap Items to Secondary Items in v16, Infor has a by-product action type. Invintel can make "output with a type" (good, scrap, co-product, remnant) one concept.
5. **Learning curve and implementation time dominate complaints** at every size (Plex 8 months, Odoo painful rollout, Fishbowl/Katana steep curve, Pace cluttered GUI).
6. **Pricing models irritate**: per interface (Tulip), per order count (Katana), per user (MRPeasy).
7. **Corrugated vendors are strong on roll lifecycle and scheduling** (ASNs, sensors, trim, trucks) but publish almost nothing on partial rolls or floor UX.

---

## 6. Ranked improvements for Invintel

Ranked by (evidence strength x daily value x fit with the phase plan). Effort: S = days, M = a few weeks, L = months.

| # | Improvement | Evidence | Effort | Phase |
| --- | --- | --- | --- | --- |
| 1 | **Ledger-first stock with documents, reason codes, reversal and a rebuild/verify tool.** One posting path for Receipt, Move, Load, Consume, Produce, Scrap, Adjust, Count. | Katana books usage only at MO completion; Epicor receipts-before-issues lock bad costs with no default guard; Fishbowl reviewers cite inventory inaccuracy; Odoo scrap-to-virtual-location is a clean model. Everything else depends on this. | M | 0 |
| 2 | **Scan-first floor mode (/floor) with Move, Receive, Count first, then Load / Report.** Two-scan Move; scanner always focused; undo-last; big targets. | Fishbowl Go leaves work orders to the desktop; Odoo Shop Floor is limited; Epicor needs a separate client. Plex shows a labels-at-the-machine flow is wanted. | M-L | 1 |
| 3 | **Unit-level stock (roll/pallet) with a shrinking quantity and a Report usage step that returns a remnant to stock** (new qty, new location) or scrap with a reason. | Epicor cannot backflush lot/serial; Sage 500 has no variable-weight roll UoM; Amtech/Kiwiplan track rolls but publish nothing on remnants; Katana users hit fraction problems. Open gap in public material. | L | 1 (units, labels), 2 (remnants) |
| 4 | **Hybrid consumption: Load is the base, operator confirms or edits actual.** BOM-expected quantity is pre-filled at Report usage; unit-tracked items are always explicit; bulk items can backflush from the Load total. | ERPNext "Material Transferred for Manufacture" is the same idea; Katana pre-fills planned and lets operators edit; Odoo flexible consumption (Blocked/Allowed/Warn); Epicor shows pure backflush is brittle. | M | 2 |
| 5 | **Variance view: expected (BOM x output) vs actual, by item, work order, work center and operator, with an approval threshold.** | Katana says discrepancy reporting is its point but ties usage per order not per step; Odoo warns on deviation but gives little analysis; Fishbowl/Capterra complaints about thin reporting. | M | 2 |
| 6 | **"No silent failures": show a posting preview and a plain reason when something did not consume or post** (missing BOM line, unit not loaded, lot flag, wrong location). | Epicor forum: backflush "did nothing" with many hidden conditions, answers range from scheduled server process to dummy operations; Infor warns of no error on obsolete items. | S-M | 2 |
| 7 | **Outputs as typed lines: good, scrap, co-product, remnant; scrap of finished goods allowed from the floor.** Each posts ledger lines to the right location (WIP, FG, scrap, by-product stock). | Odoo Shop Floor cannot scrap finished products; Odoo and Infor treat by-products as add-ons; ERPNext renamed scrap table in v16. | M | 2 |
| 8 | **Progressive complexity: start as quantities + locations, switch on units / work centers / BOMs per item or site, with templates (roll item, pallet item).** | Plex 8-month implementations; Odoo rollout pain; Katana/Fishbowl steep curves; Pace cluttered GUI. | M | 0-2 (design from start) |
| 9 | **Offline-tolerant floor queue with a visible sync indicator, idempotent posting, conflict rules (ledger makes this easy).** | Scanner latency and connectivity are recurring warehouse complaints (vendor blogs); Plex mobile/offline edge cases and Tulip cloud dependence (low-confidence aggregator). Evidence is soft, but design now to avoid a rewrite. | L | 1 (design), 4 (full) |
| 10 | **Open data: CSV import/export of every table, a documented API, and custom attributes instead of custom code.** | Katana: no Google Sheets export, pricey API; Odoo: upgrades break custom modules; Tulip/Katana pricing meters usage. | S-M | 0-1 (CSV/API), 3-4 (attributes) |

Notes on ranking: 1-3 are foundation for the Andrew-shaped use case (plant workers moving rolls and loading machines). 4-7 are the production core and where competitors fail loudest. 8-10 reduce adoption friction and lock-in; cheap to plan early, expensive to retrofit.

---

## 7. Copy list

1. **ERPNext "Material Transferred for Manufacture" consumption base.** Load defines what is at the machine; consumption defaults to that.
2. **Odoo Flexible Consumption (Blocked / Allowed / Allowed with Warning)** as a per-BOM setting, plus the per-component "Manual Consumption" flag for rolls.
3. **Odoo scrap-as-move to a virtual scrap location,** so scrap is a normal ledger line and not a special case.
4. **Katana pre-filled actuals with an optional comment** saved with the operator's name. Good for quick edits, ledger-friendly.
5. **Kiwiplan Unit Load Tracking** idea: WIP and finished pallets are tracked units with location and ship history, same as raw rolls.
6. **Amtech ASN-in-transit roll visibility:** unit exists as "in transit" before arrival; receiving confirms it.
7. **Plex work-center guard rails:** block loading the wrong container or an untrained operator (optional rule, later).
8. **MRPeasy barcodes on orders and operations,** not just items; scan an order or operation to jump straight to reporting.
9. **ERPNext "Validate Components Quantities Per BOM"** style soft check at posting time.
10. **Infor by-product as an action type** (not a separate module).

## 8. Avoid list

1. **Consumption that only runs in a scheduled server process or when a hidden checklist is satisfied** (Epicor). Make rules visible and posting immediate.
2. **Backflush that cannot handle unit-tracked items** (Epicor, Infor flags). Rolls are the main case.
3. **Production reporting only on the desktop** (Fishbowl Go, Odoo Shop Floor limits). Floor mode must do Load / Report / Scrap.
4. **Stock that does not move until an order is completed** (Katana). Load and consume events post as they happen.
5. **Usage-metered pricing or limits per screen / order count** (Tulip per interface, Katana order tiers). Keep it open source and flat.
6. **Custom code that breaks on upgrade** (Odoo reviewers). Prefer configuration and attributes, and keep the API stable.
7. **A "set quantity" box.** Matches the proposal's principle; competitors that allow free edits end up with inaccuracy complaints (Fishbowl).
8. **One machine per operation / no parallel work centers** (ERPNext forum). Allow multiple work centers on the same operation.
9. **Overbuilt first-run screens** (Pace cluttered GUI, Plex long rollouts). Show the five floor tiles first.
10. **UoM conversion that is ignored at work-order time** (ERPNext forum). Convert at the edges, hold stock in one base unit, test with roll weight vs length vs area.

---

## 9. Notes for the Invintel phases

- **Phase 0:** items 1, 8 (design), 10 (CSV/API) and location types. Keep the base UoM + conversion table, and decide early whether a roll's base unit is weight, length or area (question for Andrew).
- **Phase 1:** item 2, unit stock and labels (3), offline design (9). Floor mode should be usable with a keyboard-wedge scanner plus phone camera.
- **Phase 2:** items 4, 5, 6, 7, remnants from 3. Start with a work center = location + status, not capacity.
- **Phase 3-4:** planning leans on Kiwiplan/Amtech patterns (roll ordering from demand, ASN in-transit) only after real usage data exists; do not copy their scheduling until phases 1-2 produce data.

## 10. Sources

Corrugated / packaging
- Kiwiplan product page: https://www.advantive.com/products/kiwiplan/
- Kiwiplan vs generic ERP (vendor post): https://www.advantive.com/blog/how-kiwiplan-outperforms-generic-erp-systems/
- Kiwiplan listings (no complaints): https://www.capterra.co.nz/software/1036108/kiwiplan , https://www.softwareadvice.com/erp/kiwiplan-profile
- Amtech roll stock: https://www.amtechsoftware.com/solutions/manufacturing-execution/rollstock-management/ (direct fetch 403; used search summary)
- Amtech overview (builtin): https://builtin.com/company/amtech-software
- ePS Corrugated Suite: https://epssw.com/corrugated-suite
- ePS Pace reviews: https://www.softwareadvice.com/business-management/efi-pace-profile/
- Packaging ERP roundup: https://softwareconnect.com/roundups/best-packaging-erp-software/
- Sage 500 variable-UoM thread: https://communityhub.sage.com/us/sage500/f/sage-500-erp-manufacturing-distribution-and-internet-applications/99938/uom-that-are-variable
- Apex (unrelated listing found): https://www.capterra.com/p/10022410/Apex/ ; trade tag page: https://www.supplychain247.com/topic/tag/Apex_Supply_Chain_Technologies/P15

MES / ERP
- Plex on G2: https://g2.com/products/plex-smart-manufacturing-platform/reviews ; Software Advice: https://www.softwareadvice.com/inventory-management/plex-online-profile/
- Plex white paper (customer quotes): https://plex.rockwellautomation.com/en-us/resources/consistent-and-clear-increased-productivity-better-quality-and-lower-costs-within-reach.html
- Tulip pricing and reviews: https://toolradar.com/tools/tulip/pricing , https://www.capterra.com/p/180620/Tulip/ , https://www.trustradius.com/products/tulip/reviews , https://www.gartner.com/reviews/market/manufacturing-execution-systems/vendor/tulip-interfaces/product/tulip-platform/likes-dislikes (403 on fetch)
- Tulip integration notes: https://support.tulip.co/docs/integration-connectors.md
- Epicor backflush thread: https://www.epiusers.help/t/labor-and-material-backflushing/122810 ; related: https://www.epiusers.help/t/e10-mes-backflushing-not-working/34352 , https://epiusers.help/t/costing-issues-with-mes/34784
- Infor backflushing: https://docs.infor.com/csi/10.x/en-us/csbiolh/inventory_user_cl_sl/lsm1454144447899.html , https://docs.infor.com/factorytrack/2026.x/en-us/useradminlist/ftslwmug/ses1493275621766.html
- Infor SyteLine aggregate (low confidence): https://www.rfp.wiki/erp/cloud-erp-product-centric-enterprises/infor-cloudsuite-industrial-syteline

Open / SMB
- Odoo scrap docs: https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/manufacturing/workflows/scrap_manufacturing.html
- Odoo BoM docs: https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/manufacturing/basic_setup/bill_configuration.html
- Odoo Capterra reviews: https://capterra.com/p/135618/Odoo/reviews/?page=2
- Odoo by-products (third-party): https://www.cybrosys.com/blog/overview-of-by-product-management-in-odoo-18-manufacturing
- Odoo backflush add-on claim (vendor): https://ecosire.com/apps/odoo/odoo-manufacturing-backflush
- ERPNext material consumption: https://docs.frappe.io/erpnext/material_consumption.md ; manufacturing settings: https://docs.frappe.io/erpnext/manufacturing-settings ; BOM: https://docs.frappe.io/erpnext/bill-of-materials.md
- ERPNext forum: https://discuss.frappe.io/t/job-card-cannot-be-generated-as-per-workstation-performing-similar-operation/130119 , https://discuss.frappe.io/t/how-to-setup-uom-to-convert-from-weight-to-pieces/90092
- MRPeasy: https://mrpeasy.com/pricing/ , https://www.mrpeasy.com/demo-videos/barcode-system-printing-and-scanning-barcodes/ , https://dupple.com/reviews/mrpeasy , https://www.capterra.com/p/134177/MRPEasy/reviews/Capterra___4790887/
- Katana help (actual usage): https://support.katanamrp.com/en/articles/5967154-tracking-the-actual-quantity-of-ingredients-used-in-manufacturing ; reviews: https://www.softwareadvice.com/manufacturing/katana-mrp-profile/reviews/ , https://api.craftybase.com/compare/katana-reviews
- Fishbowl: https://www.getapp.com/operations-management-software/a/fishbowl/reviews/?page=12 , https://apps.xero.com/us/app/fishbowl-manufacturing-and-warehouse , https://support.machmotion.com/books/fishbowl-mobile-app-J1v/page/fishbowl-go , https://www.fishbowlinventory.com/blog/measuring-up-the-unit-of-measure-module

General warehouse UX complaints (vendor blogs, weak)
- https://zebra.com/ap/en/blog/posts/2020/warehouse-leaders-reveal-biggest-technology-worries.html

## 11. Unverified or thin

- **Apex Supply Chain Technologies:** no public info tying it to corrugated or paper; nothing claimed.
- **Kiwiplan:** BOM / work order / consumption / scrap / co-product / remnant handling, handheld and barcode use, pricing, and any independent complaints. All unverified. Efficiency figures (20% throughput, 25% less WIP, 1-3% yield) are vendor marketing.
- **Amtech / ePS:** page content from search summaries (Amtech fetch returned 403). No pricing, no partial-roll handling, no complaints.
- **Plex:** BOM, backflush, scrap, planning docs not found; ratings from G2 AI summary and a small Software Advice sample; "8 months" is G2 listing text.
- **Tulip:** stock/BOM capabilities, offline behavior, Gartner "dislikes" (403). Pricing figures differ between ToolRadar and TrustRadius; check Tulip's own page.
- **Epicor:** forum evidence is from 10.x-era versions and may not apply to current Kinetic. No pricing.
- **Infor:** complaints come from an AI-generated aggregator (rfp.wiki); not shop-floor specific. No pricing.
- **Odoo:** Shop Floor consumption and by-product behavior not verified in current docs; default-automatic-consumption is my inference; no pricing figures verified. Roll / variable-weight UoM not found.
- **ERPNext:** pricing/licensing not checked; Scrap/Secondary Items detail not found; two complaints are single forum posts.
- **MRPeasy:** pricing conflicts across sources; partial consumption and UoM at consumption not found; complaints thin.
- **Katana:** no verified price list; Trustpilot 2.8 from a third-party roundup; barcode and batch details limited to the help article.
- **Fishbowl:** no public price; scrap/yield mechanics in work orders not found; "WOs mostly done in desktop" is one integrator's note.
- **Plant-worker sentiment:** I found no Reddit or forum threads from actual plant workers about any of these products (search tool returned none). Worker-side pain is inferred from admin forums, review sites and vendor blogs. Andrew's first-hand experience is the better source here.
- **Offline tolerance:** supporting evidence is soft (aggregator hints, vendor blogs). Treat item 9 as design guidance rather than competitor-proven.
