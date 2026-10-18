# INV-18: addresses on partners and documents, and a complete archive

Owner: Eli. Branch: `inv-18/addresses-archive` (main merged in first, so it sits on Will's INV-10 and INV-11). Scope per Gus: (1) customers and suppliers get an address (bill-to, ship-to) that shows on the PO, confirmation, packing slip and invoice PDFs and in the email/X12 documents where there is a slot (N1/N3/N4); (2) the full-data archive carries the new settings so an export is complete, proven by a round trip into a scratch database; additive, old records still render; nothing in Will's areas touched.

## What it does

- **One structured address** (`address.ts`): place name, street, second line, city, state/province, postal code, country. Blank means none; "not given" is kept apart from "blank" so an API call that doesn't mention an address leaves it alone and one that sends a blank clears it.
- **Where it lives**: supplier `address`; trading partner `billTo` and `shipTo`; sales order `billTo` and `shipTo` (copied from the partner when the order is made, ship-to falling back to bill-to, editable on the order, frozen after); letterhead `company.address` (structured, wins over the old free-text lines, which still print when they are all there is).
- **PDFs**: PO (To supplier + Deliver to), confirmation (Customer, or Bill to + Ship to), packing slip (Ship to), invoice (Bill to + Ship to, as issued).
- **X12**: 850 N1/N3/N4 for BY, SE, ST (read back too); 856 ST; 810 BT and ST. Strict writers: state as a code, country two letters (or a small name table), city required with any N4 part, 55/30/15 length limits refused rather than truncated; reserved separator characters cleaned from street text. The email canonical documents carry the addresses.
- **UI**: shared `AddressFields`; Purchasing supplier create and **edit**; partner form Addresses with "Ship to same"; sales order dialog prefilled from the chosen customer, shown on the order; Settings > Documents structured letterhead address.
- **Archive**: new collections `tradingPartners` and `docLogos`; setting `documentProfile` (letterhead + templates); issued-invoice numbers (nested counter) and X12 control-number counters carried; every new record validated on restore (addresses, per-partner document looks, the invoice documents, the logo re-read from its bytes with type and size recomputed); raw bytes accepted only inside the logo; counters for partners not in the file ignored.

## Round trip

`addresses.test.ts` builds an organization that uses everything (letterhead with address, two templates, logo, an EDI and an email customer with addresses and their own document looks, a supplier with an address, shipped and invoiced orders), exports it, restores into a **second database**, exports again and compares the two files with ids renamed by first appearance: equal. It then checks the restored organization in use (settings, logo bytes identical, partners, issued invoices still render) and that numbering continues (SO-0003, INV-0003, X12 control numbers not reused).

## Tests

API 515 (18 new in `addresses.test.ts`): address type and blank handling; supplier and partner create/edit/clear/refuse and older records; sales order copy/own/explicit-none/snapshot/edit/rewrite and a pre-address order; text extracted from all four PDFs, with and without addresses, structured vs legacy letterhead; X12 write/read for 850/856/810, refusal cases with their messages, end-to-end through the x12 bridge (and a refusal before anything is sent), goldens `850-order-addresses`, `856-ship-addresses`, `810-invoice-addresses`; archive validation (bad address, bad look, bad invoice, SVG/damaged/second/odd logo, bytes elsewhere, a logo that lies about its size, crafted counters), blocked restore when partners or a logo exist, and an older archive without any of this restoring fine. Existing X12 goldens are unchanged. Web typecheck clean, 20 web tests.

## Browser check (desktop and 375 px, seeded demo)

Supplier edit with address saves and shows on the list; partner form Addresses; new sales order prefilled from Bluebird (bill-to and separate ship-to); order detail shows both; 375 px: dialogs stack, no horizontal overflow on Sales, Purchasing, Documents. Invoice and PO PDFs looked at as images: addresses where expected, no overlap.

## Known limits

- **Not archived**: Invintel-exchange partners (tied to this organization's identity), the B2B message log, captured supplier invoices, the exchange identity. A restored organization sets exchange partners up again.
- A supplier's address lives on the supplier record; the PO documents use that. A supplier-kind trading partner's own bill-to/ship-to fields are not used for POs (they exist for customers).
- X12 is deliberately strict about state/country: an address saved as "Ohio" is fine for PDFs but an EDI order to that supplier is refused until it says OH. The error says so.
- 856 and 810 name the ship-to party from the address place name, else the customer name; a long customer name over 60 characters is refused by X12 (not shortened).
- Tax per line, multiple currencies, an address book per customer (several ship-tos) are not here: one bill-to and one ship-to per customer, and per order.
