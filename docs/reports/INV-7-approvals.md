# INV-7: Approvals framework

Owner: Gus. Branch: `inv-7/approvals`. Ticket: INV-7 on the Invintel board.

## What it does

A second person's OK for the actions that matter. Admins switch rules on in **Settings > Approvals**:

- **Stock adjustments** worth at least $X (|change| x unit cost).
- **Purchase orders** worth at least $X when placed.

Each rule says whether it applies to **members only** or **everyone, admins too**. When an action crosses a rule it does not happen. It becomes a request (`APR-0001`), the person sees "sent for approval", and the **Approvals** page (sidebar, with a count badge for admins) lists it with the plain sentence, the money, who asked and a link to the item or order. Another admin **approves** (the action is carried out once, as the person who asked, with the approver named in the Activity reason and the audit log) or **rejects** with a required reason. The asker can **cancel** their own waiting request.

## How to try it

Settings > Approvals: tick Stock adjustments, $50, members only; save. Join as a second user (the org's join code), open an item, Adjust by a quantity worth more than $50: you get "Sent for approval". As an admin open **Approvals** and approve; check Activity and the Audit log. Do the same with a purchase order over the threshold, placed by an admin, with another admin approving.

## Decisions I made

- **Four eyes.** You can't approve your own request. The exception is when you are the only admin or owner in the organization: then you can, and the audit entry says "own request: the only approver". Otherwise a small shop would be locked out of its own purchasing.
- **Carried out as the asker, approved by the approver.** The stock movement shows the asker's name (what actually happened is their request) and the reason ends "(approved by Adam, APR-0001)". The audit log has requested, approved and the stock event.
- **A request that can no longer run is marked "Couldn't run" with the reason** (for example, the stock fell before it was approved) and changes nothing. The asker has to ask again.
- **Asking again for the same purchase order doesn't make a second request.**
- **Only two kinds for now** (adjustments, purchase orders). Count posting is already admin-only, and variance approval on work orders already exists; they can move under this framework later.
- **No compliance claims.** This is a second-person check with a named approver and an audit trail. It is not an electronic-signature system and doesn't claim to meet any regulation.

## Tests

`apps/api/src/approvals.test.ts` (5 tests): no behaviour change without a rule and only admins set rules (duplicate kinds refused); under the line posts at once, over the line waits and nothing posts; the asker can't approve, an admin can, it runs exactly once with the right actor and reason, double-approve refused; reject needs a reason and posts nothing; only the asker cancels; an approved request that can't run is marked failed and changes nothing; members see only their own requests; purchase order held, repeat ask returns the same request, owner can't self-approve with two admins but can when alone; other organizations get 404. Full suite and typecheck green; clicked through in a browser (request, badge, approve, stock changed).

## Known limits

- Rules compare money at the item's current unit cost, so zero-cost items never trigger an adjustment rule.
- No email or push notification yet (INV-8 will add alerts). Admins see the badge in the sidebar.
- Requests don't expire.
