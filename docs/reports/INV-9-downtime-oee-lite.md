# INV-9: Downtime log and OEE-lite

Owner: Gus. Branch: `inv-9/downtime`. Ticket: INV-9 on the Invintel board.

## What it does

- **Floor mode > Downtime** (a tile that follows the Production feature switch). Pick the machine by scanning its work-center code or name, or tap it in the list (machines that are down show why). If it is running, tap one of the big reason buttons ("Breakdown", "Changeover", "Waiting for material", "No operator", "Planned maintenance", "Quality hold", "Other"). If it is down, the screen shows the reason, how long, and who started it, with one big **Back up and running** button.
- **Reports > Downtime and availability.** Pick 7, 30 or 90 days. By machine: availability, minutes down, number of stops, biggest reason, and a "Down now" tag. A bar chart of minutes lost by reason (the Pareto: what to fix first), and the latest stops. Admins edit the reason list and the scheduled hours per day right under it.
- Every start and end is in the audit log; changing the settings is too.

## How to try it

Demo database, signed in, phone-width window: Floor mode > Downtime > Corrugator 1 > a reason; then Back up. On the desk open Reports > Downtime and availability.

## Decisions I made

- **Availability = (scheduled hours - logged downtime) / scheduled hours**, over every calendar day in the window, with scheduled hours per day set by an admin (default 8). It is **availability only**, so it is "OEE-lite", not OEE: no speed (performance) or quality factor. The page says so. Weekends and shifts aren't modelled; if a plant runs 5 days a week, set the hours per day accordingly for now.
- **One open stop per machine**, enforced by a unique index, so two operators can't both log the same breakdown (the second gets "already down since ..."). Anyone can end it.
- **A fixed pick-list, no free text for the reason**, so the Pareto means something. A free-text note exists in the API for later.
- **Stops that cross the start of the window count only the part inside it**, and a stop still running counts up to now.
- **Reason matching is case-insensitive**, stored as the list spells it.
- Lives under the Production feature switch: switched off, its API answers 403 and the tile and report disappear.

## Tests

`apps/api/src/downtime.test.ts` (4 tests): the window maths (clipped start, still-running, outside the window); start/end with the pick-list, one open stop per machine, a second start refused, ending twice refused, other organizations get 404, audit events; admin-only settings and validation (duplicate reasons); a summary over several machines with backdated events (minutes per machine, availability to one decimal, top reason, down-now, reasons ranked, an old event only appearing in the 30-day window). Full suite and typecheck green. Clicked through on a phone-sized window (start, down screen, back up) and on the desktop report.

## Known limits

- Not linked to work orders yet, so you can't see downtime per order.
- No planned-vs-unplanned split in the figure; "Planned maintenance" counts as downtime.
- No edit or delete of a logged stop (a wrong one can only be ended).
- No scheduling of shifts, breaks or holidays.
