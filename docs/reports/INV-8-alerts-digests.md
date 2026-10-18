# INV-8: Alerts and digests

Owner: Gus. Branch: `inv-8/alerts`. Ticket: INV-8 on the Invintel board.

## What it does

An **Alerts** page (sidebar, with a count badge that turns red when something is urgent). It looks at the data every time you open it and lists what needs someone's attention:

| Alert | When | Severity |
| --- | --- | --- |
| Out of stock | quantity is zero | urgent |
| Low stock | at or under the item's reorder level | warning |
| Running out | at the last 30 days' usage (production "consume" lines), the stock lasts fewer than N days (default 7) | warning |
| Late order | a placed purchase order is past its expected date; urgent from 7 days late | warning / urgent |
| Count overdue | a place is overdue on the ABC count schedule (INV-3) and nobody is counting it now | warning |
| Machine down | a machine has been logged down for N minutes (default 60) (INV-9) | urgent |

Anyone can **Got it** (acknowledge), **snooze for 1 or 7 days**, or **reopen**. Acknowledging says "someone's on it" for everybody and shows who. An acknowledgement belongs to the problem: it stays until the problem is gone. When it's fixed the alert disappears, and if the same thing goes wrong again it comes back as a new open alert. A snooze ends by itself.

**Daily digest preview** at the bottom: exactly what a daily email or chat message would say ("Acme: 3 things need attention (1 urgent)", then "Needs action now" and "Keep an eye on" lists). There's a **Copy** button. **Nothing is sent**: that needs an email or chat account, which isn't connected, so this round ships the content and the page, not the delivery.

Admins set the two thresholds under the digest.

## Webhook-ready

Every acknowledge, snooze and reopen is written to the audit log (`alert.acknowledged`, `alert.snoozed`, `alert.reopened`, plus `alert.settings_changed`), and every alert has a stable `key` (`low_stock:<item id>`). When webhooks exist (INV-10), a subscriber can be told about audit events, and `GET /alerts` already returns the full current list in a stable shape for a poller.

## How to try it

Demo database: open **Alerts**. Try Got it on one; the badge drops. Receive stock for that item (Floor > Receive): the alert vanishes. Log a machine down for over an hour (or lower the minutes in Settings) and an urgent alert appears.

## Decisions I made

- **Alerts are computed, not stored.** Only acknowledgements and snoozes are stored. That means they can never go stale or be missed, and there's nothing to keep in sync with the ledger.
- **Acknowledgement is shared by the whole organization**, not per person, because on a plant floor the question is "is anyone dealing with this?".
- **Count overdue only for places with stock and no open count.**
- **"Running out" needs production usage history**, so it stays quiet for items that are never consumed in production. Shipping will feed it once sales orders exist.
- **No email, no push.** Said plainly on the page.

## Tests

`apps/api/src/alerts.test.ts` (5 tests): quiet when fine; out and low stock with severity and sort order; days-of-supply from backdated consume lines (fast item flagged, slow item not); late orders (future not flagged, 2 days warning, 10 days urgent), machine down at 30 vs 90 minutes, count overdue and cleared by an open count; acknowledge by a member visible to the owner, reopen, snooze with expiry, fixing the problem forgets the acknowledgement and a repeat is open again, a dead key is a 404, audit events; digest text and sections, admin-only validated settings, other organizations get 404. Full suite and typecheck green. Clicked through in a browser (list, badge, acknowledge, digest, settings).

## Known limits

- No delivery channel (email, chat, push), by design this round.
- Thresholds are organization-wide, not per item (items already have their own reorder level).
- Alerts depend on the Purchasing and Production feature switches: with them off, late orders and machine alerts don't appear.
