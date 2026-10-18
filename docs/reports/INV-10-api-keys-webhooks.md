# INV-10: API keys and outbound webhooks

Owner: Will. Branch: `inv-10/api-keys-webhooks` (stacked on `inv-4/import-export-archive`, which carries INV-5 and main). Ticket: INV-10 on the Invintel board. **Needs Frida's review before Done** (key storage, scopes, SSRF on webhook targets). Everything here was built and tested against a local database and a local receiver: no real credentials, no outside services, no real data.

## What it does

**API keys.** Admins make keys in *Settings > API keys* for other software. Two kinds: *read only* and *read and write stock*. A key is shown once, works for one organization, can expire, can be revoked at once, and is rate limited. It can never delete anything, import, restore, or touch people, settings, approvals, the audit log, other keys or webhooks.

**Webhooks.** Admins add a receiver address and pick events in *Settings > Webhooks*. Invintel POSTs a signed JSON message when they happen, retries failures, shows a delivery log with a retry button, switches a webhook off after repeated failure, and can send a test. Addresses on private networks are refused.

## How to try it

1. Settings > API keys > New API key, "Read and write". Copy the key. `curl -H "Authorization: Bearer ivk_..." http://localhost:3001/api/orgs/<orgId>/items` works; `DELETE` an item, `GET /members`, `GET /api/orgs` answer 403; flip a character of the key and it answers 401.
2. Settings > Webhooks > Add: `https://169.254.169.254/latest/meta-data/` is refused ("a private or reserved address"). For local development start the API with `INVINTEL_WEBHOOKS_ALLOW_PRIVATE=true`, run any receiver on `http://127.0.0.1:PORT`, add it, press *Send test*, then create an item with the key: the log shows `webhook.test` and `item.created` as delivered, and the receiver can verify the `X-Invintel-Signature` (README has the code).

## How it works

- `api-keys.ts`: `ivk_` + 32 random bytes; stored as SHA-256 plus a short prefix for lookup; constant-time compare; revoked/expired/unknown all answer the same 401; per-key request window (default 600/min, `Retry-After`), per-address lockout after 20 wrong keys. `keyPermits(scope, method, path)` is an explicit allowlist of regexes (read: GET on items, locations, ledger, overview, rolls, purchasing reads, counts, lookup; write: create/patch items, adjust/transfer, receipts, moves, rolls receive/move/adjust, PO receive). Anything not on the list is denied, so a new route is private to keys until someone adds it. The organization middleware turns a key into a member of its one organization, so every route's existing role checks, approval rules and audit trail apply unchanged, and the actor is named "API key: <name>".
- `webhooks.ts`: `recordAudit` calls a per-store listener after an event is safely in the hash chain; `queueEvent` turns public events into delivery rows (one per matching webhook, with the exact body bytes). `deliverDue` claims rows atomically (lease), so two workers or two API processes never send the same delivery; `attempt` signs (`t=<unix>,v1=HMAC-SHA256(secret, "<t>.<body>")`), posts, and classifies. Retries after 1 m, 5 m, 30 m, 2 h, 6 h, then gives up; 10 gave-up deliveries in a row switch the webhook off and audit it. The same event id and bytes are sent on every retry. `startWebhookWorker` runs it every 5 s inside the API process.
- `webhook-safety.ts`: `isPublicIp` (all IPv4 special ranges, IPv6 unique-local, link-local, site-local, multicast, documentation, Teredo, 6to4, NAT64, and IPv4 mapped/compatible/NAT64 inside IPv6 judged by the IPv4 inside; global unicast 2000::/3 only). `validateWebhookUrl` (https only, no credentials, blocked name suffixes, IP-literal check; number-form tricks like `2130706433` are normalised by the URL parser then caught). `postJson` re-checks **every address the name resolves to at connect time** through a custom `lookup`, so a name that changes its answer after being saved is still blocked; literal IPs are checked before connecting; redirects are never followed; at most a few KB of the answer are read; 8 s timeout.
- Audit: `api_key.created/revoked`, `webhook.created/updated/deleted/secret_rotated/disabled`. The key and secrets are never written to the log. Only the curated public events are ever sent (not member changes, join codes, keys or webhooks).

## Decisions

- **Keys are scoped by an allowlist, not by hiding routes.** Deny by default.
- **Keys act as a member, not an admin.** A leaked key can't manage anything or approve its own work.
- **No delete, ever, for a key.** Consistent with the rule that deleting data needs a person.
- **SHA-256, not a slow hash, for keys.** They are 256 random bits, not passwords, so brute force isn't the threat and every API call has to be fast.
- **Webhook secrets are stored recoverable** (an HMAC key must be). They are shown once and never returned by the API. A database leak would expose them; encrypting them at rest with a server key is the next step and needs a place to keep that key.
- **https and public addresses only**, with an environment switch for local development that is off by default and documented as never for production.
- **At-least-once delivery.** A receiver should treat `X-Invintel-Event-Id` as an idempotency key.

## Tests

`apps/api/src/webhook-safety.test.ts` (9): public vs every private/reserved IPv4 and IPv6 range including mapped, NAT64, 6to4, Teredo, zones; refusal of non-addresses; URL rules (https only, credentials, names, odd number forms, bracketed IPv6); the dev switch being exact. `apps/api/src/integrations.test.ts` (22): key creation (admin only, shown once, stored as a hash and nowhere else, never in the audit log, validation); a read key reads and nothing else; a write key works, is named in the ledger, and gets 403 on delete, members, audit, keys, webhooks, archive, export, import, restore, join code, modules, locations, org summary, approvals, settings; keys belong to one organization (404 elsewhere, 403 for listing or creating organizations, 401 on session-only routes); revoked, expired, flipped, malformed and wrong-scheme keys all 401 with an identical body; per-key rate limit with `Retry-After` and address lockout after 20 wrong keys (even the right key waits); approval rules apply to a key (`202`). Webhooks: admin-only management, secret shown once, bad events refused; private and unsafe addresses refused when saved and on edit; per-organization isolation; signed delivery verified with an independent HMAC (and a wrong secret fails), correct headers, no snapshot, once only; event filtering, never sending non-public events, nothing when switched off; retry timing and unchanged event id/bytes, giving up after the last attempt, manual retry; switch-off after 10 in a row with audit and a clean restart; redirects not followed (the target gets nothing); timeout and an endless answer; never connecting to a private address even if one slipped in or a name later resolves privately (DNS answer faked); test event to a switched-off webhook; secret rotation (old signature fails); removal clears the log; two concurrent workers never double-send (12 events, 12 distinct deliveries); the background worker. Full API suite 284 tests, web 20, typecheck and build clean.

Browser (desktop and phone): created a write key (shown once with Copy), used it from curl (read 200, adjust 200 and named "API key: Shopify sync" in the ledger, delete / members / list organizations 403, wrong key 401); the metadata address was refused with a clear message; with the development switch, an independent receiver script verified the signature of a real `item.created` delivered by the background worker, *Send test* showed "The receiver answered 200", and the log listed both deliveries.

## Known limits

- **Not reviewed by Frida yet.** Please check: the allowlist in `keyPermits`, the lookup-time address check in `postJson`, and the choice to store webhook secrets recoverably.
- Webhook secrets are not encrypted at rest.
- Rate limits and lockouts are in memory per process (reset on restart, not shared across several API processes), like the existing login limiter.
- No per-key IP allowlist, no per-key scopes finer than read/write, no webhook payload versioning yet (`type` names are the contract).
- Delivery order isn't guaranteed (retries can arrive after later events); `seq` and `createdAt` in the body let a receiver order them.
- Requires the API process to stay up for retries; a delivery due while it is down is sent when it returns.
- IPv6-only receivers aren't tested against a real network; the address logic is unit tested.
- A receiver that is slow for 8 seconds on every event delays that worker's other deliveries (four run at once).
