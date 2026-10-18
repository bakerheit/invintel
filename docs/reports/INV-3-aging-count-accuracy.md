# INV-3: Inventory aging and count accuracy

Owner: Gus. Branch: `inv-3/aging-count-accuracy`. Ticket: INV-3 on the Invintel board.

## What it does

A new **Reports** area (sidebar) with two reports, both read-only and built from data the app already records.

**Stock aging** (`Reports > Stock aging`). For every item at every place, how many days since stock last moved there, the money tied up, and whether the item is on an active BOM (so "old" stock that production will need soon is marked). Stock is grouped into 0-30, 31-90, 91-180, 181-365 and over-a-year buckets, with a headline for value idle over 180 days. Filter by location. **CSV** export has every row.

**Counting** (`Reports > Counting`).
- *Which places to count.* Items are classed A/B/C by value on hand: the items making up the first 80% of total value are A, the next 15% B, the rest C. A place is counted as often as the most important class stored there: A every 30 days, B every 90, C every 180. Each place shows never counted, overdue, due soon or OK, and a **Start count** button that opens a count for that place.
- *Accuracy.* From posted counts only: the share of counted lines that matched the system, by place, by month (last six), and the items that miss the most by money.

## How to try it

Sign in to the demo (`MONGODB_DB=invintel_demo pnpm --filter @invintel/api seed:demo`, then `pnpm dev`), open **Reports**. On a fresh demo everything is new, so the aging report is mostly one bucket; back-date some movements in the database to see the older buckets, or use your own data. Post a count from **Counts** and the accuracy section fills in.

## Decisions I made

- **"Last movement" is per item and place**, from the newest ledger line of any type (receive, move, adjust, count, reversal). A count that confirms stock is a movement of attention, so it resets the age. If you'd rather only physical moves reset it, that is a one-line change.
- **No sales history yet, so ABC uses value on hand**, not annual usage. When sales orders exist this should switch to value consumed per year.
- **Intervals (30/90/180 days) are fixed constants** for now, not an org setting. Cheap to make configurable later.
- **Counts that haven't been posted aren't scored**, and a cancelled count never is. Accuracy is lines matched / lines counted, so one mismatched line out of ten is 90%; the money columns show how much it mattered.
- Unit-tracked items (rolls) are in the aging report through their stock rows but can't be counted by quantity yet, so they're out of count accuracy.

## Tests

`apps/api/src/reports.test.ts` (4 tests): aging buckets, ordering, value, idle value, location filter, move resets age, CSV header and a row, cross-organization 404; count accuracy by place/item/month and that open or cancelled counts are ignored; ABC classing, the three due states with backdated posts, never-counted, open-count flag and sort order. Full suite and typecheck are green. Clicked through in a browser at desktop width; the tables scroll sideways on a phone.

## Known limits

- The aging report lists the oldest 200 rows on screen (the CSV has all).
- ABC and intervals can't be tuned per organization yet.
- Counting by roll/pallet label isn't built, so those items can't be scored.
