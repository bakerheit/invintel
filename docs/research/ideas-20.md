# Invintel: 20 candidate improvements (round 2)

Merged by Gus from three research passes: Will (warehouse/SMB inventory, scanning, integrations, lots and units), Eli (plant operations, reporting, pricing and packaging, open-source gaps) and Gus (onboarding, compliance, multi-site, customer-facing). The full write-ups, with sources and honest evidence grades, are kept outside the repo: `~/.claude/team/bakerheit/invintel-ideas-{gus,will,eli}.md`. Evidence is mostly vendor material and small review samples; items marked "verify" need a primary-source check before anyone builds on them.

Effort: S = days, M = a week or two, L = weeks. "Source" says which list(s) it came from.

| # | Improvement | Helps | Effort | Risk | Source |
| --- | --- | --- | --- | --- | --- |
| 1 | **Units of measure and fractional quantities** (kg, metres, cases vs each; stored exactly, shown with decimals; conversions) | Plants (weight on a roll), anyone buying in one unit and selling in another | L | High: every quantity in the app is a whole number today | Will 1 |
| 2 | **Lot, batch and expiry on quantity items**, FEFO hints, expiry alerts | Food, chemicals, anything with shelf life | L | Medium-high: changes the stock key | Will 2 |
| 3 | **Lot genealogy and a timed mock-recall report**: trace forward and back (supplier lot to work orders to finished lots) | Quality, compliance, customer audits | M | Medium: only as complete as captured data | Eli 1, Will 3, Gus G1 |
| 4 | **Quality hold and NCR**: hold or quarantine units and stock, inspect-before-release at receiving, disposition (use, rework, scrap, return) posting to the ledger | QA, receiving, supervisors | M | Medium: touches posting paths | Eli 2+3, Gus G2 |
| 5 | **Bring it in, take it out**: import wizard v2 (column mapping, fix-it errors, update mode with diff, undo) and a full-data export archive that re-imports cleanly | New customers, anyone worried about lock-in | M | Low-medium | Gus G5, Eli 10 |
| 6 | **API keys and outbound webhooks**, free on every install | Integrators, IT | M | High: key storage, scopes, SSRF on webhooks | Eli 11, Will 7 |
| 7 | **Alerts and digests**: low stock, late PO, count overdue, days of supply and shortage watch; in-app, email digest, webhook | Buyers, planners, supervisors | M | Medium: noise, needs an outbound channel | Gus G9, Eli 8 |
| 8 | **Sales orders, reservations and shipping**: customers, orders, available vs on hand, pick and ship through the ledger, packing slip | Plants that also sell and ship | L | Medium: scope | Will 10, Gus G6+G7 |
| 9 | **Multi-site and in-transit transfers**: sites above locations, ship then receive, goods-in-transit report | Plants with several buildings | M-L | Medium: data model | Gus G3+G4 |
| 10 | **Costing and valuation**: FIFO or weighted average, valuation as of a date, accounting-ready CSV exports (QuickBooks/Xero formats: verify) | Owners, accountants | L | Medium-high | Will 8+9, Eli valuation |
| 11 | **Inventory aging and count accuracy**: days since last movement, value tied up, ABC count schedule, accuracy by location | Buyers, CFO, count teams | S-M | Low | Eli 5 + count accuracy |
| 12 | **Scrap and yield trends** by work center, item and reason code | Plant managers | M | Medium: needs a short reason list | Eli 6 |
| 13 | **Supplier scorecard**: on time, in full, lead-time drift (descriptive) | Buyers, CFO | M | Low-medium | Eli 7 |
| 14 | **Downtime log and OEE-lite** per work center | Operators, supervisors | S-M | Medium: data quality | Eli 4 |
| 15 | **Schedule board**: work orders sequenced per work center with load bars | Planners | M | Medium: needs run times | Eli appendix |
| 16 | **Offline-tolerant Floor queue** with a visible sync state and idempotent posting | Plants and warehouses with dead zones | L | High | Will 11, Eli research |
| 17 | **Approvals framework**: rules such as "adjustments over $500 need an admin", PO approval, named approver and reason; auditor evidence pack | Controllers, ISO 9001 shops | M | Low-medium: don't over-claim compliance | Gus G8+G12 |
| 18 | **Shared-device sign-in**: badge or PIN quick login for plant tablets, auto sign-out, operator id on every action | Plant floor | M | Medium: auth change (needs Frida) | Gus G10 |
| 19 | **One-command self-host** with built-in backup and restore, upgrade safety copy, health check; plus **industry starter kits** (corrugated, small food plant, makers) | Owners of IT-light plants, new evaluators | M | Medium: restore must be proven | Eli 9+12, Gus G11 |
| 20 | **Faster receiving and scanning**: GS1-128 pallet/case labels (verify FNC1), multi-scan batch flows, Zebra ZPL printing | Docks, warehouses | M | Medium: ZPL needs a printer to test | Will 4+5+6 |

**Considered and left out for now:** kits as a light BOM (overlaps work orders), preventive maintenance with spare parts (a whole product category), Shopify/WooCommerce sync (only after 6 and 8), QuickBooks/Xero live sync (after 10).

## How we decide

1. Each of Gus, Will and Eli sends Gus an ordered top-10 from this list, with one line per pick on why.
2. Score: Borda count (1st pick = 10 points down to 10th = 1). Ties go to the item that is more buildable end to end this round.
3. Gus applies one guardrail before announcing: an item the team can't finish and verify in this round without hardware, a secret or an outside account is swapped for the next one on the tally, and the swap is explained.
