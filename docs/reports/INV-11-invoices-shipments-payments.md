# INV-11: Supplier invoices, shipments and payment records with three-way match

Owner: Will. Branch: `inv-11/invoices-payments` (stacked on `inv-10/api-keys-webhooks`, which carries INV-4 and INV-5; main merged in). Ticket: INV-11 on the Invintel board. Demo phase: nothing here moves money, talks to a bank or an accounting system, or uses a real partner; all data is fictional and local.

## What it does

A **Payables** area with three tabs:

- **Invoices** (admins): a supplier's invoice as a first-class document (lines against a purchase order, in each item's own unit, tax, freight, currency), matched three ways: invoice vs. the order's price and quantity vs. what actually arrived. Clean matches are ready to pay; anything else needs a person, who must say why before paying anyway. Approval rules (INV-7) can ask for a second person on invoices over a threshold.
- **Shipments** (anyone on the dock): a supplier's advance ship notice. Receiving against it goes through the ledger tagged with the shipment and the order, so the receipt record, the order and the match all agree.
- **Payments** (admins): payment records (method, date, reference) against one or several approved invoices of a supplier, with void, a printable remittance advice, and CSV exports of bills and payments for accounting.

Plus: per-supplier pay-to details (method and last four digits only) whose changes can require a second person's OK, and matching rules (currency, price tolerance, quantity tolerance, total tolerance).

## How to try it

1. Purchasing: make a supplier and a purchase order (say 100 bolts at $0.15 and 25 kg resin at $1.20/kg), place it, receive 60 bolts and 10.000 kg.
2. Payables > Enter invoice: the supplier, that order, an invoice number, then **Fill from what arrived**. Change the bolt price to $0.18 and save. The detail shows the problem next to the order price and the received quantity (`billed $0.18 each, ordered at $0.15 (+20.0%)`).
3. **Match it**: it goes to *Needs review*. Type a reason ("price confirmed by phone"), **Pay anyway: approve**. With a second admin, that person has to do this step for an invoice you entered.
4. **Record a payment**, then open **Remittance** and print it. *Bills CSV* and *Payments CSV* export the records.
5. Shipments > Record a shipment for the rest of the order, open it, **Receive what arrived**: the order shows fully received and the lot rides along.

## How it works

- `invoice-match.ts` is the match engine (read-only): duplicate invoice number (same supplier, trimmed and case-insensitive, among non-void invoices), currency, stated-vs-computed total, order not open or for another supplier, item not on the order, price above order (block) or below (info), nothing received, billed over received (counting other approved invoices on the same order line), billed over ordered. Quantities are compared in stored whole numbers and described with `formatQty` in the item's own unit; prices are per display unit and money is computed with `lineValueCents` (INV-5). Tolerances come from the organization's `invoiceSettings`.
- `invoices.ts`: routes, presenters, `approveInvoiceDirect` (re-runs the match, claims the status change atomically, records the override reason) and `applyPaymentDetails`, both also used when a second person approves an INV-7 request. The server computes all totals; the client never sends them. Editing resets an invoice to draft and withdraws a waiting approval request.
- `payments.ts`: allocation checks, then one guarded `findOneAndUpdate` per invoice (`status approved` and `paid + amount <= total` in the same atomic step) with rollback of earlier allocations if one fails; marks invoices paid when the balance reaches zero; void reverses the same way.
- `shipments.ts` plus an extraction of the order-receiving code from the purchasing route into `receiveAgainstOrder`, so a shipment's receipts take the identical path (including inspection holds and supplier lots) and are tagged `shipmentId` as well as `purchaseOrderId`. Status is derived from the ledger, so reversing a receipt reopens the shipment.
- Archive: invoices, shipments, payments and `invoiceSettings` are in the full archive (match snapshots and approval links are not carried over; numbering continues).
- Webhooks: `invoice.approved`, `invoice.voided`, `payment.recorded`, `shipment.received` can be subscribed to.

## Decisions

- **Invoices don't count against each other until approved.** An invoice still waiting for review may be the wrong one, so it doesn't make the right one look over-billed; approving it re-runs the match.
- **No payment of an unapproved invoice**, ever, and the amount is guarded atomically.
- **Bank details are not stored.** Only method, last four digits and a description; anything that looks like a full number is rejected. This keeps real bank data out of a demo database and out of the archive.
- **Override needs a reason, and a second person when you entered the invoice**, unless you are the only approver (same rule as INV-7).
- **Only price increases block.** A price below the order is information.
- **API keys can't reach payables.** Not on the read or write allowlist.
- **Does not duplicate accounting.** There is no ledger of money here: just invoices, payments and exports.

## Tests

`apps/api/src/payables.test.ts` (29 tests): totals worked out server-side in item units, admin-only and per-organization, input validation; editing returns to draft and a PATCH keeps the fields it leaves out (regression for the Zod `.partial()` default trap, caught while writing the tests); clean match auto-approves with an audit line; price above (and below) the order; not received, over-billed (in kg), cumulative billing across invoices; receipts made after entry, including through a shipment; duplicate numbers (from both sides, cleared by voiding, per supplier), currency, total mismatch and tolerance; no order, freight lines, items not on the order, draft and other-supplier orders; tolerances (admin-only, audited, validated); overriding needs a reason, a second person for your own invoice, and sole-approver works; approval rules (under and over the line, can't self-approve, approved/rejected/withdrawn, the match re-run on approval); supplier pay-to details (validation, refusal of full numbers, approval rule, no-op saves); payments (partial then full, multi-invoice, refusals incl. future date, other supplier, mixed currency, wrong state, over balance, nothing half-applied; six simultaneous payments of one invoice: exactly one succeeds; void restores the balance; remittance); shipments (reference unique per supplier, warnings, member can record and receive, receipts tagged both ways with lot, order and stock updated, reversal reopens, no-order shipments, inspection, cancel rules); CSV exports (per line, freight, formula guard, admin-only); archive round trip with numbering; API keys refused everywhere. Also `invoice-capture.test.ts` (+1): a captured invoice's shaped input is accepted by invoice entry, matched, and the capture closes. Merged with main (INV-12 to 17): full API suite 497, web 20, typecheck and build clean.

Browser (desktop, with a phone-width look): entered an invoice with the order auto-filled, saw the flagged price beside the order and received quantities, matched it, overrode with a reason, recorded a payment (invoice shows Paid and links the remittance), printable remittance, shipment received through its dialog (the order became fully received), the CSVs and the audit trail checked from the API.

## Known limits

- **Captured invoices** (INV-12 email/PDF bridge) feed in through `GET /b2b/invoices/:id/invoice-input` and close via `POST .../converted`; that shape matches `invoiceInputSchema` exactly (tested). Shipments (inbound ASNs) are not yet created from a received X12 856 or similar: a shipment is entered by hand. Main's sales-order shipments are a different thing (outgoing, embedded in the sales order); the tab here is called "incoming shipments".
- **No capture or OCR** (invoice entry is by hand) and no inbound email or EDI.
- **Tax is a per-line amount**, not a rate or a tax code. Currency is one per invoice and must equal the organization's currency to match cleanly; there is no conversion.
- **No credit notes, partial credits or disputes**, no payment terms (a due date is typed), no early-payment discount, no withholding.
- Matching is by item and price on the order's lines; two lines for the same item on one order would be merged by item.
- Payment details store no real account data by design; a "bank file" (NACHA/ACH) export isn't built.
- The bills CSV layout is generic; mapping to QuickBooks/Xero import formats needs verification against their documentation.
- Production screens still show stored counts for decimal items (INV-5 known limit), and shipments aren't yet offered on the floor receive screen.
- The member view is the Shipments tab only; invoices and payments are admin-only.
