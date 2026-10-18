# INV-12: Trading partners, B2B message log, email + PDF bridge, invoice capture

Owner: Eli. Branch: `inv-12/email-bridge` (main merged in, including Gus's INV-13 exchange which uses the same core). Ticket: INV-12 on the Invintel board.

## What it does

- **Core (already merged earlier, extended here).** Trading partners, one B2B message per document sent or received, bridges as adapters (`email`, `invoice-inbox`, `loopback`, Gus's Invintel exchange), idempotency keys, forward-only states (queued, sent, delivered, acknowledged, rejected, failed, received), immutable raw payload with hash, an unauthenticated inbound route with size and rate limits, audit events on everything.
- **Email + PDF orders.** "Email to supplier" in the purchase order dialog builds a canonical order, renders a PDF (our own small writer, no dependency), builds the MIME email (header-injection safe) and sends it through `mail.ts`. Preview PDF shows exactly what goes out. Sending again makes a new revision (`po:<id>:rev:<n>` idempotency key) and switches the old supplier link off. A failed send can be retried.
- **Mail transport.** Default is an outbox: `.eml` files written to `INVINTEL_OUTBOX_DIR` (or the temp folder), so nothing leaves the machine. SMTP is there for later (`INVINTEL_SMTP_URL`, STARTTLS or implicit TLS); it refuses plain-text auth unless `INVINTEL_SMTP_ALLOW_PLAIN_AUTH=1`. Test partners say TEST in the subject.
- **Supplier page** (`/b2b/s/:token`, no account). Confirm (optional ship date and note), decline with a reason, send a ship notice (date, carrier, tracking). Token stored hashed, 60 day expiry, rate limited, uniform not-found for bad tokens. Answers are stored as received `order_response` / `despatch_advice` messages and mark the sent order acknowledged. They don't change the order or stock.
- **Invoice capture.** Upload (PDF, UBL XML, JSON) or post to a partner's invoice inbox (secret from the env var named in `bridgeConfig.secretEnv`). XML and JSON are read exactly; a PDF is kept as it came and typed in by a person. Each field is marked read, guessed or missing; the page shows whether the total matches the order, what has been received, and duplicate invoice numbers. Edit, discard, download the file (always as an attachment, nosniff). A captured invoice never becomes a payable by itself: `GET /b2b/invoices/:id/invoice-input` gives the shape for Will's invoice entry (INV-11), `POST /b2b/invoices/:id/converted {invoiceId}` links it afterwards.
- **Documents page** (`/o/:id/documents`, nav "Documents"): Partners (add, edit, switch off), Documents (message log with state filter, retry), Incoming invoices.

## How to try it

`pnpm --filter @invintel/api seed:demo`, sign in, **Purchasing > PO-0001 (Midwest Paper Mill) > Email to supplier**. Open the `.eml` in the outbox folder, open the link in it, confirm and send a ship notice. Look at **Documents** (log) and **Documents > Incoming invoices** (MWP-20418 is waiting for the same order).

## Decisions I made

- **Outbox by default.** No network, no account, nothing can reach a real supplier by accident. SMTP is opt-in by env.
- **No OCR and no bank details.** A PDF invoice is a file for a person; machine reading only for structured formats. Bank details on an invoice are a fraud vector and are never read.
- **Supplier answers are information, not edits.** They are recorded and shown; a person changes the PO.
- **Captured invoices stop at a draft.** The payable is Will's INV-11 and needs a person plus the 3-way match.
- **One canonical order** (`canonicalOrderSchema`) that the email bridge renders now and X12 (INV-14) will render next.

## Found while verifying in the browser

The supplier page showed "Internal Server Error" on Confirm. Cause was my dev API process being gone (killed from outside), not the code: the same request against a restarted API returned 201 and the page showed the answer. Header fields on Incoming invoices overlapped at tablet width; the grid now wraps (2 columns, 5 on wide screens).

## Tests

`b2b.test.ts` (13), `b2b-email.test.ts` (20), `invoice-capture.test.ts` (15). Failure cases covered: bad or expired or revoked tokens, a second send revoking the first link, wrong or missing inbox secret, oversized and malformed payloads, XML with DOCTYPE/ENTITY, `1.234,50` amounts read strictly, duplicate invoice numbers, header injection in subject and addresses, SMTP refusing plain auth, retry of a failed send, idempotent resend, member vs admin access, other organizations. Whole API suite, typecheck and build green. Clicked through in a browser at desktop and phone width: Partners, email send (`.eml` with PDF and link), supplier page confirm and ship notice, Documents log, Incoming invoices; no horizontal overflow at 375 px.

## Known limits

- No automatic retry schedule yet (manual retry only).
- SMTP client is minimal and untested against a real server in this phase.
- PDF invoices are not read; XML is UBL only, JSON is our own shape.
- PDF writer is Helvetica / WinAnsi only (no other scripts).
