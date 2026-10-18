# INV-13: Invintel-to-Invintel exchange

Owner: Gus. Branch: `inv-13/invintel-exchange`. Ticket: INV-13. Built on Eli's B2B core (INV-12: trading partners, message log, bridges).

## What it does

Two Invintel businesses trade documents with each other directly, signed, with no EDI network in between:

- **Identity.** Every organization gets an exchange id (`ix_...`) and an Ed25519 signing key the first time it opens **Exchange**. The page shows the id and a short **fingerprint**, and a **Copy my invitation** button (public key, no secret).
- **Connect.** Paste a partner's invitation, say whether they are your supplier or your customer, and Connect. If they are on the same server they are connected back automatically, so both sides can trade at once. Check the fingerprint by phone: that's how you know the key is theirs. An invitation whose fingerprint doesn't match its key is refused as altered.
- **Purchase order out.** Open a placed purchase order: **Trade with your supplier > Send this order**. The supplier sees it under **Exchange > Orders from customers**.
- **Answer and ship.** An admin on the supplier side **Accepts** (with a promised date) or **Rejects**; anyone can **Ship** (carrier and tracking). Each goes back signed. The buyer's order dialog shows the whole story: order sent (acknowledged), supplier answered "accepted, promised 2026-11-03", supplier shipped "tracking 1Z...".
- **Questions.** **Ask a partner**: "Do you have this item?" or "Where is my order?". The partner answers automatically, but only what that partner was explicitly allowed: three switches per partner, all off by default (may ask if an item is in stock; and see the quantity; may ask where their order is). Answers say "in stock / low / out", the quantity only if allowed, and **never** the supplier's cost.
- **Same log as everything else.** Every message is a B2B message (INV-12): state, idempotency, retries, acknowledgements and audit.

## How to try it

In the demo (seed or `seed:demo`): sign in as the demo user. There are two organizations, "Demo Corrugated Co." (the plant, a buyer) and "Sunrise Paper Co." (the supplier); switch with the organization menu at the top of the sidebar. In the plant, open Purchasing, open a placed order for Sunrise, **Send this order**. Switch to Sunrise > Exchange, **Answer** and **Ship**. Switch back and watch the order's story fill in. Then **Ask a partner** from either side.

## How it's protected

- **Signed.** Each message is signed over a canonical form of its content; the receiver checks the signature against the key it was given at connect time. Change one character and it fails.
- **Replay and staleness.** Each message has a unique id; a repeat is recognised and stored once. Messages more than 10 minutes old (or from the future) are refused, which also limits how long a captured message could be replayed.
- **Addressing and roles.** A message must be addressed to this organization, from a connected partner, and of a kind that partner may send (only a customer sends orders; only a supplier sends answers, ship notices and invoices).
- **Quiet refusals.** Anything refused looks the same from outside (`422 Not accepted`), so nobody can probe which partners or keys exist. The inbox is rate-limited and size-limited.
- **Keys.** Private keys never leave the server. With `EXCHANGE_KEY_SECRET` set they are stored sealed (AES-256-GCM); without it they are stored as is, which is fine for a demo and not for real use.
- **Permissions default to nothing**, switches are admin-only and audited.

## Decisions I made

- **Delivery is a bridge** ("invintel") on Eli's B2B core, plus a small `registerInboundHook` I added to the core so a bridge can act on what it receives (answer a question, mark an order acknowledged). Nothing else in the core changed.
- **Same-server partners are delivered in process; others over HTTPS** to `<their address>/api/exchange/inbox`. The path is fixed, redirects are refused, there's an 8 second timeout. Failures that may pass (timeouts, 5xx, 429) are retryable; refusals are not.
- **Answers are separate messages**, not synchronous HTTP replies, so the asker finds them in their log like any other message, and the same code works across servers.
- **Quantities are decimals in the document** (converted from the stored units using the item's unit and decimals, INV-5), prices are cents per unit.
- **No sales orders yet.** An incoming order lives as a message with a Respond/Ship screen; it doesn't reserve stock or create a sales order. That's the next step if we want it.
- **Invoices** are a carried document type but not built until Will's INV-11 (supplier invoices) exists.

## Tests

`exchange-crypto.test.ts` (5) and `exchange.test.ts` (6): identity creation and stability, connect both ways, re-connect idempotent, own and tampered invitations refused; PO send (once), supplier answer and ship, buyer's message acknowledged and timeline of three documents; questions denied by default, then availability only, then quantity, cost never present, unknown SKU, order status through received, accepted and shipped; forged signature, tampered body, replay stored once, stale, misaddressed, unknown sender, wrong role, junk, partner switched off; HTTPS path with a stubbed network (URL, signature verifies with the sender's real key, 503 retryable and retried with the same id, 422 not retryable); organization isolation and role limits. Full suite green.

## Known limits

- No key rotation or revocation yet (disconnecting a partner switches it off; the key stays in the record).
- The invitation is trusted on first use plus a fingerprint you check by hand; there's no directory of businesses.
- No cross-server automated test (two real servers); the HTTPS path is tested with a stubbed network.
- Orders from partners don't reserve stock or become sales orders; no invoice or payment documents yet.
