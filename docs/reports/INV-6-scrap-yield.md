# INV-6: Scrap and yield trends

Owner: Eli. Branch: `inv-6/scrap-yield` (on main with INV-2 merged; uses INV-2's reason lists and `reasonCode` field). Ticket: INV-6 on the Invintel board.

## What it does

- **Reasons on the floor.** Floor mode > Production: when the scrap count (material at Report usage, or finished output at Report output) is above zero, the screen asks "Why was it scrapped?" with big buttons from the org's scrap list (Trim, Setup, Wrong size, Damaged, Machine fault, Other by default) and won't save without one. The reason is stored on the ledger's scrap line (`reasonCode`). Rolls and pallets get it too. Scrap decided from a quality hold (INV-2) already carries its reason.
- **Reports > Scrap and yield trends** (Reports area, under the Production switch). Window: last 7, 30, 90 or 180 days; optional work center filter.
  - Cards: **scrap value**, **yield**, the biggest reason, and scrap with **no reason** (what the list can't explain).
  - **By reason** bars, a **trend** (a bar per day, or per week from Monday for 90 and 180 days) with the yield beside it, a table **by work center** (scrap value, entries, good output, scrapped output, yield) and **by material** (quantity in its own unit, value, entries), and where the scrap came from (material used, output scrapped, quality hold).
  - **CSV** of every scrap entry (date, source, work order, work center, item, quantity, value, reason, who).
- Scrap that was **reversed** in Activity doesn't count.
- The API takes `scrapReason` on consume and output; it must be on the org's list (case-insensitive; stored with the list's spelling); a wrong one is refused (400) and nothing is booked.

## How to try it

`pnpm --filter @invintel/api seed:demo` (the demo has a finished run with scrap and reasons), sign in, **Reports > Scrap and yield trends**. Then Floor mode > Production > a work order > Report output, tap "More" under Scrapped: the reason buttons appear.

## Decisions I made

- **Value, not count, is the headline.** Quantities of different items can't be added; value (quantity x the item's current unit cost) can. The by-material table shows each item's own quantity. The page says value uses current cost.
- **Yield = good / (good + scrapped output)** of the finished item, per work center and per day. It counts the output that was reported scrapped, not material scrap (that is a cost, not a yield loss). Good output is the produce lines minus the scrapped output booked on the same work order, the same rule the variance view uses.
- **Reason required on the floor, optional in the API**, so existing clients and scripts keep working; a missing reason is its own "No reason given" row and card, so you can see how well the lists are being used.
- **Scrap from a quality hold has no work order**, so it appears under "Not on a work order" and is left out when you filter to one work center.
- **Weekly buckets start on Monday (UTC)**, daily for windows up to 31 days.
- **Reasons are the shared org list** (from INV-2), editable in one place.

## Also fixed on the way

Reversing a two-line stock entry in Activity where both lines are removals (a usage with scrap: used + scrap) crashed with a 500 **after** the stock had been put back and the reversal recorded, so the caller saw an error for something that had happened. Activity now describes any multi-line entry correctly ("consume entry of 2 lines"). Regression assertion in `scrap.test.ts`.

## Tests

`apps/api/src/scrap.test.ts` (6 tests): the totals on a two-press plant (scrap value, entries, good and scrapped output, yield, no-reason value), by reason / work center / material / source exactly, the quality-hold scrap in its own row; windows (an old line drops out of 30 days, appears in 180; weekly buckets start on Monday; work center filter removes hold scrap); reversed scrap ignored (and the reversal-crash regression); validation (days, work center id, unknown scrap reason on usage and output with nothing booked, a custom list, case-insensitive match); reasons on rolls; CSV, member access, other organizations, and the Production switch (403 when off). Whole API suite, typecheck and build green. Clicked through in a browser at desktop and phone width (report; floor reason picker appears when scrap goes above zero).

## Known limits

- Value uses each item's current unit cost, not the cost at the time.
- Yield ignores material scrap and rework, and mixes different output items by count.
- Scrap on unit-tracked output isn't recorded yet (so it can't be in the report).
- No target lines or alerts on yield; no per-operator or per-shift split.
- Old scrap (before reasons existed) shows as "No reason given".
