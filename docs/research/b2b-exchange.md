# Sending POs, invoices and payments to other businesses: architecture, payments, accounting and capture

Written 2026-10-18 by Gus. Companion to Eli's `b2b-standards.md` (document standards, EDI/Peppol/AS2, provider APIs). This one covers the shape of the thing we'd build, payments, accounting systems, invoice capture and the order we'd do it in.

Evidence is thin and mostly vendor material and forum posts from web searches on 2026-10-18; anything marked (unverified) must be checked against the vendor's own documentation before we build on it. No legal or compliance conclusions here: payments rules need a fintech lawyer before real money.

## 1. What "talking to another business" means

Four different jobs that people lump together:

1. **Send a document and get an answer**: a purchase order goes out, an acknowledgement and a shipping notice (ASN) come back, an invoice comes in, a remittance goes out.
2. **Ask a question**: what's your stock of X, what's the price, where is my order, can you quote this (an RFQ). In EDI this is a separate small family of documents; in modern APIs it's a request/response call.
3. **Move money**: pay a supplier's invoice (bank transfer, card, check) or get paid by a customer.
4. **Keep the books in step**: the bill or invoice also has to land in the accounting system.

Each partner is on a different channel: a big customer wants EDI over AS2 or a VAN, a mid-size supplier wants email with a PDF, a small shop wants a link, an Invintel user on the other side could take a direct API call. We can't pick one format. We need **one internal document model and a layer of bridges**.

## 2. Proposed shape: an "Exchange" layer with bridges

```
Invintel documents (PurchaseOrder, Invoice, Shipment, Quote...)       <- what the app already has, plus Invoice/Shipment
        |
  Exchange layer: partners, outbox/inbox, status, retries, audit
        |
  Bridges (adapters), one per channel:
   - Email + PDF (send), email capture + OCR (receive)
   - Invintel-to-Invintel (signed JSON over HTTPS + webhooks)
   - EDI / Peppol through a provider API (X12 850/855/856/810/820, UBL)
   - Accounting sync (QuickBooks first)
   - Payment rail (through a processor, never holding funds ourselves)
```

Design rules that fall out of the research:

- **Canonical internal model, mapping at the edge.** Our PurchaseOrder maps to an X12 850 or a Peppol/UBL order inside the bridge; nothing outside the bridge knows the wire format.
- **Partner profile** per business: their identifiers (EDI qualifier + ID, Peppol ID, email, API endpoint), preferred channel and format, test vs live, contacts, item cross-references (their part number, our SKU), default terms.
- **Message log** (outbox and inbox) with an idempotency key, state (queued, sent, delivered, acknowledged, rejected, failed), attempts, raw payload kept for audit, and a link to the Invintel document. Acknowledgements (EDI 997/999, Peppol message level responses, or an email read of the PO link) update the state. This is the same ledger-first idea we already use: record what happened, derive the status.
- **Everything is test-mode first.** Every bridge has a sandbox: Stripe/Dwolla/Moov test environments for money, Peppol test network and provider sandboxes for documents, Intuit's sandbox company for QuickBooks. A demo should never touch a real bank or a real partner.
- **Signed and audited.** Outbound webhooks and Invintel-to-Invintel messages are signed (HMAC, timestamp, replay window); every send and receive is an audit event.
- **Don't hold money.** See section 3.

## 3. Payments

What we found (vendor and aggregator pages, so treat prices as directional):

| Option | What it's for | Notes |
| --- | --- | --- |
| Stripe (ACH, Connect, Treasury) | Pay or collect if the business is already on Stripe | ACH about 0.8% capped at $5 and same-day ACH extra (aggregator, unverified); one SDK for cards and bank debits; Treasury is embedded accounts, a different product |
| Dwolla | White-label bank transfers (ACH, wires, RTP) | Negotiated flat fees from about $0.25 (unverified); one profile reports an acquisition by NMI in May 2026 (single aggregator source, verify) |
| Moov | Accept, store and send money via one API | Lists $0.25 per ACH and $0.50 per RTP, no monthly fee (unverified) |
| Modern Treasury | B2B payment operations: ACH, wires, RTP/FedNow, ledgering | Platform fee plus per-payment; for higher volume (vendor-described) |
| Plaid | Bank account linking and verification | Not a processor; pairs with one of the above |

The structural question is **who holds the funds**:

- If we (or the software) move customers' money through an account we control, the rules for a "third-party sender" under the Nacha Operating Rules, and possibly state money-transmitter licensing, may apply. A processor sells licensing help for this (a Modern Treasury/Brico partnership is described), which tells you it's a real cost.
- If the processor holds and moves the funds and we only send instructions, we're closer to a "third-party service provider". Ottimate, an AP product, describes this model: it partners with a processor and says it never takes possession of funds. (Vendor statement; the 2020 article that explains the distinction is dated, so check the current rulebook.)

**Recommendation:** never hold funds; every real payment goes through a processor with the customer's own account on the processor. Before that, three lighter steps that move no money at all:

1. **Record a payment**: mark an invoice paid with method, date, reference and attach the remittance advice.
2. **Send a remittance advice** to the supplier (document, email, or 820 later).
3. **Export a bank file** (NACHA/ACH or a bank's batch CSV) for the owner to upload to their own bank. Zero custody, works with any bank, nothing to license.

Real payment initiation (Stripe/Moov/Dwolla sandbox first) comes after that and needs the compliance review.

## 4. Accounting systems

- **QuickBooks Online** is the realistic first target for small plants. API is OAuth 2.0 with access and refresh tokens, per-company "realm" ids, and rate limits (sources disagree on the numbers, around 500 requests a minute per company and a concurrency cap; check Intuit's docs). Bills, invoices and purchase orders can be created through the API per third-party guides; one connector vendor says it doesn't support customer invoice creation through its connector, so test the specific objects we need. Intuit has a sandbox. (All from third-party guides: unverified.)
- **Unified accounting APIs** (Merge, Codat, Unified.to, Chift) give one API over QuickBooks, Xero, NetSuite and others. Merge's public pricing as reported by one blog: free for the first 3 linked accounts, then about $650 a month plus $65 per linked account (unverified, from a single blog). Codat doesn't publish prices. These are worth it when we need many systems; for the first customer a direct QuickBooks integration is cheaper and more controllable. The same blog warns of hidden costs and custom-field gaps.
- **Rule:** sync is one-way per object with a clear owner (Invintel owns the PO; the accounting system owns the posted bill), and every sync failure is visible in the message log, not silent. (Eli's and Will's research found sync failures are the top complaint for inventory-to-accounting links.)
- **Cheapest useful start:** accounting-ready CSV/IIF-style exports (idea 10 in the round-2 list), then QuickBooks.

## 5. Getting invoices in: capture

Many suppliers will send a PDF whatever we do. Options found:

- **Mindee, Veryfi**: developer-first invoice OCR APIs, usage-priced. (Veryfi's 99.8% accuracy claim is its own marketing: unverified.)
- **Rossum**: invoice-specific AP automation platform; one source says self-serve starts around $18,000 a year (unverified), so more than we'd want early.
- **Azure AI Document Intelligence**: pay per page, free tier, and one listing says it can run as a Docker container, which matters if invoice data mustn't leave the building (unverified).
- **Amazon Textract (AnalyzeExpense)**: used in an AWS reference pipeline for invoice and receipt fields.
- No independent accuracy comparison and no open-source option came up in these searches; a follow-up should look for self-hosted OCR/LLM extraction.

Design: capture produces a **draft** invoice with a confidence flag per field. A person (or a matching rule: PO number, amount within tolerance, quantities received) approves it. Three-way match (PO, receipt, invoice) is something Invintel is unusually well placed to do because it owns the PO and the receipts.

## 6. Security and trust

- Keys and tokens (partner API keys, OAuth tokens, processor keys) are stored encrypted, never in documents or logs, scoped per organization; INV-10's hashed API keys and signed webhooks are the foundation.
- AS2 and some EDI partners require certificates and a known endpoint; a provider API hides this, which is a reason to use one.
- Inbound documents are untrusted input: validate against the schema, cap sizes, never execute anything in them, and never let an inbound message change a price or bank detail without a human approval (this is where our INV-7 approvals framework applies; bank-detail changes are the classic invoice-fraud route).
- Real money, real partners and real bank details are outside the demo lane: those need Andrew's yes and a compliance look.

## 7. What we'd build, in order

1. **Invoices and shipments as first-class documents** in Invintel (we have POs; add supplier invoice with three-way match, an ASN/receipt link, and payment records). No outside systems yet.
2. **Partners and a message log**, with the **email + PDF bridge** (send a PO as a PDF and a secure link, supplier can confirm online; capture inbound invoices from a mailbox into drafts, with OCR as an optional step). Works with anyone.
3. **Invintel-to-Invintel bridge**: signed JSON documents between two organizations (or two instances), including the "ask a question" calls (stock, price, order status). This is the cleanest demo of the whole idea: two demo orgs trading with each other end to end, with acknowledgements.
4. **EDI/Peppol bridge via a provider's sandbox** (Eli's research picks the provider). Map PO, acknowledgement, ASN, invoice.
5. **Accounting**: bank-file and CSV exports, then QuickBooks sandbox.
6. **Payments**: a processor sandbox (test mode) once 1 to 5 exist, with the no-custody rule, and a compliance review before any real money.

Why this order: 1 to 3 need no outside accounts, are fully testable here, and show the full loop; 4 to 6 each need an outside account or a sandbox key.

## 8. Questions for Andrew

- Who would the first real trading partners be (customers who send POs, suppliers we send them to), and what do they use today (EDI, email, a portal)? Kiwiplan-style plants often exchange EDI with big customers: is that the target?
- Which accounting system do those businesses run (QuickBooks, NetSuite, something else)?
- US only, or also Australia/New Zealand/EU (where Peppol is far ahead)?
- Is Invintel meant to be the network (partners join and trade inside it) or a client of existing networks?
- Do we ever want to move money, or is "record and export" enough for the foreseeable future?

## 9. Unverified or needs a primary source

Prices (Stripe, Dwolla, Moov, Merge, Rossum), the Dwolla/NMI acquisition, QuickBooks rate limits and which objects the API can write, Nacha third-party sender rules and state licensing thresholds, Peppol availability and access-point pricing in the US, the Azure container option, and every accuracy claim.

## Sources (web searches, 2026-10-18)

- ACH APIs: https://apidog.com/blog/best-ach-payments-api/ and https://toolradar.com/compare/modern-treasury-vs-dwolla
- Third-party sender vs service provider: https://www.moderntreasury.com/journal/the-difference-between-a-third-party-sender-and-a-third-party-service-provider-in-payments and https://support.ottimate.com/support/solutions/articles/14000097950-does-plate-iq-take-possession-of-funds-
- Unified accounting: https://satvasolutions.com/blog/hidden-costs-unified-accounting-apis and https://unified.to/blog/codat_vs_unified_which_should_you_use_for_accounting_integrations_in_2026.md
- QuickBooks API: https://zuplo.com/blog/2025/05/20/quickbooks-api and https://satvasolutions.com/blog/quickbooks-online-api-guide
- Invoice OCR: https://mindee.com/product/invoice-ocr-api, https://www.veryfi.com/technology/ai-powered-ocr-eliminates-manual-invoice-processing/, https://www.erpresearch.com/erp-add-ons/ocr/azure-document-intelligence, https://toolradar.com/guides/best-ocr-invoice-software
- Peppol: https://www.billdu.com/?p=54324 and https://www.ato.gov.au/businesses-and-organisations/einvoicing/einvoicing-for-businesses/getting-started-with-einvoicing-for-medium-and-large-businesses/costs-and-benefits-for-business-case-development
