# Round 2: the 10 we are building

Decided 2026-10-18 by Gus, Eli and Will. Each of us ranked a top 10 from `ideas-20.md`; a pick scored 10 points for 1st down to 1 for 10th.

| Idea | Gus | Eli | Will | Total |
| --- | --- | --- | --- | --- |
| #3 Lot genealogy and mock recall | 10 | 10 | 9 | **29** |
| #4 Quality hold and NCR | 8 | 9 | 8 | **25** |
| #11 Inventory aging and count accuracy | 6 | 8 | 7 | **21** |
| #5 Import v2 and full-data export | 7 | 7 | 6 | **20** |
| #1 Units of measure and fractional quantities | 9 | 0 | 10 | **19** |
| #12 Scrap and yield trends | 5 | 6 | 0 | 11 |
| #17 Approvals framework | 3 | 4 | 3 | 10 |
| #7 Alerts and digests | 2 | 3 | 5 | 10 |
| #14 Downtime log and OEE-lite | 4 | 5 | 0 | 9 |
| #6 API keys and webhooks | 0 | 0 | 4 | 4 |
| #19 Self-host and backup, #13 Supplier scorecard, #2 Lot on quantity items, #9 Multi-site | | | | 1 to 2 |

**Guardrails Gus applied.** (1) #6 API keys and webhooks took the tenth place, but Eli flagged it as the biggest security surface. It is built with hashed keys, scopes and a block on private-network webhook targets, tested against a local receiver, and is not "complete" until Frida has reviewed it. Nothing is exposed to the internet. (2) #1 changes how quantities are shown and entered, so it lands first as a small shared contract (stored whole numbers stay as they are; a per-item unit and decimals setting is applied at the edges through one shared formatter) so the other nine don't collide with it. (3) #3, #4 and #12 share reason codes and a supplier-lot field on receipts, so one person owns all three. (4) Email needs an outside account, so alerts ship in-app plus a digest page and webhook events.

## Owners and order

| Owner | Items | Order |
| --- | --- | --- |
| Eli | #3 Lot genealogy and mock recall, #4 Quality hold and NCR, #12 Scrap and yield trends | shared schema first (reason codes, supplier lot), then #4, #3, #12 |
| Will | #1 Units of measure, #5 Import v2 and export archive, #6 API keys and webhooks | #1 contract first, then #5, then #6 |
| Gus | #11 Inventory aging and count accuracy, #17 Approvals framework, #7 Alerts and digests, #14 Downtime log and OEE-lite | #11, #17, #14, #7 |

## Rules for every item

- One branch per item (`inv-<n>/<slug>`) in your own worktree; local commits; Gus merges to local `main`. No push without Andrew, no deploy, no spend, no credentials or customer data in files or tickets.
- Done means: tests (including the failure cases), typecheck and build clean, clicked through in a browser at desktop and phone width, README section, audit events where something changes, and a report at `docs/reports/INV-<n>-<slug>.md` (what it does, how to try it, decisions, tests, known limits).
- Each item has a Notion ticket (INV-n) on Patrick's board. Report status changes to Patrick, and put the report link on the ticket.
