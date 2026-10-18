# Sending POs, invoices and payments to other businesses: standards, bridges and a mapping layer

Author: Eli. Date: 2026-10-18. Branch: `research/b2b-standards`. Desk research from public sources only; no sign-ups, no data entered anywhere, nothing built. Part 1 (standards) and part 2 (transports and vendors) were researched by two sub-agents under my brief and then merged here; I read their summaries and structure but did not re-open every cited source myself. Part 3 (mapping layer) is my own design against Invintel's current code. Anything not confirmed from a primary page is marked **(unverified)**; vendor marketing is marked **(vendor claim)**.

## If we build one thing first, it should be...

**The transport-independent core, shipped with the lowest-friction real channel:**

1. **A canonical B2B document model and a message log** (a `B2BMessage` record per document sent or received, with state, raw payload, acknowledgements and retries) linked to the purchase orders we already have. Nothing else works without it, and it is vendor-neutral.
2. **One outbound path that works with every supplier on day one: send the PO by email with a PDF and a structured attachment, plus a one-click "confirm / give ship date / send tracking" page for the supplier** (no EDI, no account on their side). Its replies come back as the same message records (acknowledgement, ship notice). This covers the long tail the research keeps finding: plants and their suppliers exchange POs by email, PDF and portals far more often than by anything standardised (the standards research found no public evidence that corrugated plants use papiNet, and the only public hint for box makers is "email, fax, post or EDI").
3. **The X12 850 (and 855/856/810/997) mapping as pure functions with golden-file tests and a loopback test partner**, so the day a real partner asks for EDI we only need a transport.
4. **Then, when a real partner demands EDI, one API-first provider adapter** (Orderful or Stedi are the documented REST options; the customer brings their own account) before we ever operate AS2 ourselves.

Why this order: it proves the loop (PO out, acknowledgement back, receipt matched) with nobody's EDI infrastructure, it is demoable with fictional data, and it keeps the expensive, partner-specific work (AS2 certificates, VANs, Peppol access points) behind a decision we can make with a real partner in the room. Invoices and payments come after: they need tax and currency in the data model first, and the accounting integration Gus is covering decides where money records live.

**Honest uncertainties up front:** (a) we do not know who the first partner is or what they require; (b) Stedi publishes no price for general EDI (its pricing page is healthcare-only) and Orderful's per-partner pricing grows with each partner; (c) Peppol e-invoicing dates other than Belgium's come from vendor blogs; (d) I found no public evidence for what Kiwiplan or Apex-style plant systems exchange; (e) the standards and vendor research found almost no first-hand posts from plants.

---

# Part 1. Document standards (X12, EDIFACT, cXML, UBL and Peppol, papiNet)

## 0. Executive summary

- The real world of PO flow for a US manufacturing plant is **X12 EDI** (850/855/856/810/997, sometimes 820/860/830/862) over **AS2, SFTP or a VAN**, plus a long tail of email/PDF and customer portals. For a small ERP vendor the practical path is: implement X12 parse/generate for a small core, and put a managed EDI provider (or the buyer's portal) in front for transport.
- **cXML** matters if customers run SAP Ariba or Coupa. It is plain XML over HTTPS, so it is the easiest of the "big buyer" formats to implement. Punchout is a catalog feature (sell-side web store), not needed for a plant taking POs.
- **Peppol / UBL** is the right answer for Europe, Australia/NZ, Singapore, Japan. Invoicing is where it is mandated and mature. Order / Order Response / Despatch Advice exist but I found no public volume figures. In the US, Peppol-style networking exists (DBNAlliance) but is small and voluntary. Do not build your own access point; use a certified one.
- **EDIFACT** is the European/global EDI equivalent of X12. Only needed if you sell to European retailers/OEMs that have not moved to Peppol.
- **papiNet** is real, open, and aimed at paper/forest/packaging. I found **no public evidence** that corrugated box plants use it day to day. It is mainly mill-to-merchant/printer/converter. Treat as optional/later.
- Recommendation order for a small open-source ERP: (1) internal canonical PO/ASN/invoice model; (2) X12 850/855/856/810/997 via adapter; (3) cXML OrderRequest/Confirmation/ShipNotice/InvoiceDetail; (4) UBL/Peppol via a hosted access point; (5) EDIFACT and papiNet on demand.

---

## 1. EDI ANSI X12

**What it is.** The dominant North American EDI syntax. Maintained by ASC X12, an ANSI-chartered body (x12.org says "over 40 years"). The standard is published once a year in January; access to the specs is through licensing/subscriptions with Commercial, Internal and Developer tiers (prices not listed publicly). Source: https://www.x12.org/about

**Who uses it.** US/Canada retail, CPG, distribution, automotive, healthcare (HIPAA), transportation. Large retailers such as Kroger, KeHE, Sprouts, Home Depot publish X12 requirements; typical required sets are 850, 855, 856, 810, 997 (some also 860, 820, 846). Sources: https://edi.kroger.com/EDIPortal/ProgramAndRequirements/Fredmeyer/PR_QuickResponse.html , https://www.spscommerce.com/community/articles/ready-to-ship-at-kehe-from-edi-855-to-edi-753 , https://endlesscommerce.com/edi/requirements/home-depot/ (the last is a vendor page, **(vendor claim)**).

### 1.1 Transaction sets relevant to a PO flow

| Set | Name | What it does |
|---|---|---|
| 850 | Purchase Order | Buyer sends PO to seller |
| 855 | PO Acknowledgment | Seller accepts/rejects/changes lines, dates, prices |
| 860 | PO Change Request (buyer initiated) | Buyer changes a PO already sent (qty, dates, items) |
| 865 | PO Change Acknowledgment (seller) | Seller's reply to 860 (from my general knowledge, **(unverified)** in this research) |
| 856 | Ship Notice/Manifest (ASN) | Seller tells buyer what is shipping: hierarchical shipment / order / pack / item |
| 810 | Invoice | Seller invoices buyer |
| 820 | Payment Order/Remittance Advice | Buyer tells seller what a payment covers, or an instruction to a bank. See note below |
| 846 | Inventory Inquiry/Advice | Seller reports stock levels to buyer (vendor-managed inventory style) |
| 830 | Planning Schedule with Release Capability | Buyer's forecast/material release, sent periodically (weekly/monthly); common in OEM/automotive style supply |
| 862 | Shipping Schedule | Buyer's firm shipping releases; each newer 862 supersedes the previous for the same order/shipment |
| 940 / 945 | Warehouse Shipping Order / Warehouse Shipping Advice | 3PL/warehouse flow: owner tells warehouse to ship (940), warehouse confirms what shipped (945). Only relevant if Invintel talks to a 3PL |
| 997 | Functional Acknowledgment | Syntax-level receipt of a functional group (accepted/rejected) |
| 999 | Implementation Acknowledgment | Newer, more detailed replacement for 997 (adds implementation guide errors) |
| TA1 | Interchange Acknowledgment | Envelope (ISA/IEA) level receipt |

Names for 810, 820, 830, 846, 850, 855, 856, 860, 862, 940, 945, 997, 999 confirmed on Stedi's X12 reference: https://www.stedi.com/edi/x12 . Descriptions of 830/862/860/820 summarised from TrueCommerce/SPS explainers: https://www.truecommerce.com/edi-transaction-codes/edi-862/ , https://www.1edisource.com/resources/edi-transactions-sets/edi-860/ , https://www.spscommerce.com/community/articles/explaining-edi-800-transaction-codes .

**820 note (honest).** The 820 serves two jobs: an instruction to a bank (often alongside ACH) and a remittance advice to the seller. How much it is used between small manufacturers and their customers is unclear from public sources. Some retailers (Sprouts, KeHE) list 820 as required or used (https://www.spscommerce.com/community/articles/ready-to-ship-at-kehe-from-edi-855-to-edi-753). My understanding that many mid-market B2B payments are ACH/check with remittance by email or portal is general knowledge, **(unverified)** here.

**997 vs 999.** In 4010-era trading, 997 is the acknowledgment; 999 arrived with 5010 and is the HIPAA standard acknowledgment. Some retailers ask for 999 or accept either. Kroger and Walmart-style guides ask for a 997 within 24 h (https://edi.kroger.com/... , Walmart info via vendor blog https://aayutechnologies.com/blog/walmart-edi-requirements/ **(vendor claim)**). Neither the 997 nor the AS2 MDN says the business content is valid; they only say it parsed/was received.

### 1.2 Envelope structure

```
ISA ... IEA   Interchange envelope (fixed-width ISA header, 106 chars including terminator)
  GS ... GE   Functional group (one transaction type, e.g. PO for 850s)
    ST ... SE   One transaction set (one PO, one ASN, ...)
```

- ISA is fixed-width: 16 elements (ISA01..ISA16) with set lengths (e.g. sender ID 15 chars, padded; control number 9 digits). Total 106 characters including the segment terminator. Source: https://www.stedi.com/edi/x12/segment/ISA (I derived 106 from the field table).
- **Delimiters** are declared inside ISA, not fixed by the standard: the character right after "ISA" is the element separator; ISA16 is the sub-element (component) separator; the character after ISA16 is the segment terminator; in 5010+ ISA11 is the repetition separator (in 4010 ISA11 is a standards identifier, usually "U"). Common choices: `*` element, `~` segment, `>` or `:` component, `^` repetition. Never hard-code them; read from ISA.
- GS identifies functional group code (PO = purchase orders, PR = ack, SH = ship notice, IN = invoice, FA = 997, etc. functional codes from my general knowledge, **(unverified)** except PO), sender/receiver application codes, date/time, group control number, version (e.g. 004010).
- ST carries the set ID (850) and a control number; SE gives segment count including ST and SE and echoes the control number. GE/IEA carry counts and echo control numbers. Mismatched counts or control numbers cause 997/999 rejection.
- Control numbers must be unique per sender and incrementing; receivers use them for duplicate detection.

### 1.3 Versions in common use

- X12 releases are named like 003040, 004010, 005010, 006020 ... 008010. The 8010 release was published in 2020 (Stedi reference).
- **4010** (1997 era draft) is a very old release, but is widely reported as still used between trading partners in non-healthcare supply chains. **I could not find a primary source that quantifies this** (Retailers' guides are partner-specific and were not conclusively found). So: "4010 still common in supply chain EDI" is **(unverified)** here; it is a widely held view among EDI practitioners but not backed by a number.
- **5010** is mandated in US healthcare (HIPAA) and supports 999. Walmart's portal reportedly supports 5010 (2019 blog; **(unverified/stale)**: https://stemedhub.org/members/6276/blog/2019/04/walmart-edi-and-edi-collaboration-with-walmart ).
- Practical rule: **the trading partner's implementation guide dictates the version**, and the guide customises the base standard heavily (qualifier codes, required segments). A small vendor must accept "each customer is a mapping project."
- Newer releases (6020, 8010) exist; Stedi's reference is built around 8010, but customers do not demand it generally **(unverified)**.

### 1.4 Minimal 850 (fictional)

Buyer "Northwind Beverages" (ID `NWBEV`) orders 5,000 boxes from "Sunrise Box Co" (ID `SUNRISEBOX`). Delimiters: `*` element, `~` segment, `>` component. Version 004010. Line breaks added for readability; real files are often one long line or one segment per line.

```
ISA*00*          *00*          *ZZ*NWBEV          *ZZ*SUNRISEBOX     *261018*0930*U*00401*000000101*0*T*>~
GS*PO*NWBEV*SUNRISEBOX*20261018*0930*101*X*004010~
ST*850*0001~
BEG*00*SA*PO-48213**20261018~
DTM*002*20261105~
N1*ST*Northwind Beverages Plant 2*92*PLANT2~
PO1*1*5000*EA*0.82**BP*RSC-12X9X7-32ECT~
PID*F****Regular slotted container 12x9x7 32 ECT~
CTT*1*5000~
SE*8*0001~
GE*1*101~
IEA*1*000000101~
```

What it says:
- BEG01 `00` original, BEG02 `SA` stand-alone order, BEG03 PO number, BEG05 PO date.
- DTM `002` = delivery requested date (qualifier list from general knowledge, **(unverified)**).
- N1 `ST` = ship-to party, `92` = id assigned by buyer.
- PO1: line 1, qty 5000, unit EA, unit price 0.82, buyer's part number (`BP`) RSC-12X9X7-32ECT.
- PID: free-form product description.
- CTT: 1 line item, hash total of quantities 5000.
- SE counts 8 segments (ST through SE). The ISA line is exactly 106 characters.

Typical 850 body structure per vendor specs: header (BEG, CUR, REF, PER, DTM, N1 loops, FOB, ITD/payment terms), detail loop PO1 with PID, REF, DTM, SCH (schedule lines), N9/MSG, summary CTT/SE. Sources: https://get.coupa.com/rs/950-OLU-185/images/EDI_850.pdf , https://www.opentext.com/assets/documents/en-US/pdf/850-purchase-order-edi-guidelines-documentation.pdf , https://host.astera.com/resources/edi-knowledge-center/edi-supply-chain/edi-850-purchase-order/ .

### 1.5 Transport

X12 does not specify transport. Common options: **AS2** (HTTP(S), signed/encrypted, returns an MDN receipt; retailers like Walmart and Home Depot reportedly require it, vendor blogs **(vendor claim)**), **SFTP** (simple, no native delivery receipt), **VAN** (third-party mailbox, fees per character/message/subscription). Many small suppliers use a web-EDI portal or managed service. Sources: https://orderful.com/blog/as2 , https://www.ediconnect.ro/en/web-edi/as2-vs-sftp , https://aayutechnologies.com/blog/van-vs-as2/ (all vendors; **(vendor claim)**).

### 1.6 Adoption, honestly

- Entrenched and not going away in US retail/CPG/distribution. Customers force it on suppliers (chargebacks for bad ASNs, e.g. carton labels and SSCC in the 856 per retailer guides).
- Heavy per-partner customisation, certification/testing cycles (Walmart reportedly up to six weeks, Home Depot about 15 business days; both vendor-blog numbers **(vendor claim)**).
- Existing open-source X12 libraries in JS/TS are thin: `node-x12` (TypeScript parser/generator/mapper, author says maintenance mode as of 2021, successor `js-edi`; license not confirmed by me) https://github.com/aaronhuggins/node-x12 ; the `x12` npm package (MIT per jsDelivr listing, simple parser). Commercial: IPWorks X12 (/n software). Check licenses and maintenance before adopting. Stedi (hosted) is an API-first EDI service **(vendor)**.

---

## 2. UN/EDIFACT

**What it is.** The UN's EDI standard (ISO 9735 syntax **(unverified from fetched sources; general knowledge)**), maintained by UN/CEFACT. Directories are released twice a year and named like D.96A, D.01B, D.14B, D.16A. Messages are segment-based with `UNB/UNZ` interchange envelope, `UNH/UNT` message envelope. I could not fetch unece.org (403), so details are from vendor docs.

**Messages for a PO flow.**
- `ORDERS` purchase order, `ORDRSP` order response, `ORDCHG` order change, `DESADV` despatch advice (ASN), `RECADV` receiving advice, `INVOIC` invoice, `REMADV` remittance advice (the EDIFACT analogue of X12 820), `CONTRL` syntax ack (analogue of 997). BGM qualifiers per one vendor: 220 order, 231 order response, 351 despatch advice, 380 commercial invoice **(vendor table, verify in implementation guide)**.
- Sources: https://editelgroup.com/blogs/what-are-edifact-messages , https://ecosio.com/en/blog/what-is-a-remadv-message/ , https://www.ediconnect.ro/en/web-edi/edifact-messages

**EANCOM.** A GS1 subset of EDIFACT used heavily in retail/FMCG. One vendor says D.01B is the standard version in retail and distribution in Romania and Europe and warns against older D.96A **(vendor claim, regional)**: https://docs.ediconnect.ro/en/ediconnect/formats/edifact.html . Another says older retailers still run D96A, newer ones D14B/D16A **(vendor claim)**.

**Who uses it.** European (and global) retail, manufacturing, automotive (ODETTE), logistics, customs. Not common in the US apart from multinationals.

**REMADV note.** One source says REMADV is rarely used compared with other EDI documents, though large enterprises increasingly ask for it **(vendor claim)**: https://ecosio.com/en/blog/what-is-a-remadv-message/

**Adoption trend.** In EU, invoicing is being pulled toward EN 16931 formats (UBL, CII) and Peppol; EDIFACT INVOIC persists in retail/industry. Orders/despatch in EDIFACT continue. I found no numbers.

**For Invintel.** Only if a customer in Europe demands it. Same envelope/mapping problem as X12; a generic segment tokenizer can serve both.

---

## 3. cXML (Commerce XML)

**What it is.** An XML protocol for procurement documents between buyer procurement systems, supplier systems and commerce hubs. Created by Ariba (now SAP Ariba); the cxml.org page I fetched does not state the owner, so "SAP Ariba" is general knowledge, **(unverified in fetched sources)**. Reported current version 1.2.071, updated 14 Aug 2026 per https://cxml.org/ . DTDs, reference guide (PDF) and examples are downloadable there; a license agreement page exists (terms not reviewed).

**Documents (cxml.org says the order confirmation and ship notice documents are the cXML counterparts of EDI 855 and 856):**
- `OrderRequest` (original / update / delete): buyer -> supplier PO, over HTTPS POST.
- `ConfirmationRequest`: supplier -> buyer, accept/reject/detail changes (defined in `Fulfill.dtd`).
- `ShipNoticeRequest`: supplier -> buyer ASN (also Fulfill.dtd).
- `InvoiceDetailRequest`: supplier -> buyer invoice (separate `InvoiceDetail.dtd`).
- Also `PunchOutSetupRequest/Response`, `PunchOutOrderMessage`, catalog documents, `ProfileRequest`, etc.

**Structure.** `<cXML payloadID timestamp>` root, `<Header>` with `<From>`, `<To>`, `<Sender>` (each with `<Credential domain="...">` identities and a SharedSecret on Sender for auth), `<Request>` containing a payload. An OrderRequest has `<OrderRequestHeader>` and `<ItemOut quantity lineNumber>` lines. Source: https://tradecentric.com/blog/cxml-examples/ (vendor blog, structure only partly shown); https://punchoutcommerce.com/guides/transactions/cxml-confirmation-request/ . A reply is a short `<Response><Status code="200"/></Response>` (general knowledge, **(unverified)**). Store the `payloadID` for later change/cancel orders.

**PunchOut.** A procurement-system feature: the buyer's user clicks into the supplier's web store from their own procurement app. Flow: buyer system POSTs `PunchOutSetupRequest` (includes `BuyerCookie` and return URL) -> supplier replies with a start-page URL -> user shops on supplier site -> supplier sends the cart back as a `PunchOutOrderMessage` (via the user's browser) -> cart becomes a requisition/PO in the buyer's system -> later an `OrderRequest` is sent. Source: https://punchoutcommerce.com/guides/ , https://help.cimcloud.com/help-center/punchout-via-cxml-base . For a plant receiving POs, punchout is relevant only if Invintel sells catalog items online to Ariba/Coupa customers.

**Who uses it.** Buyers on SAP Ariba, Coupa, Jaggaer, Oracle procurement etc. who send POs to suppliers over cXML, and suppliers with Ariba Network or direct cXML endpoints. Coupa's docs position the Coupa Supplier Portal (free for suppliers per customer pages; low/medium volume) versus cXML integration (higher volume/automation); one customer says a cXML connection can take several weeks to enable **(vendor/customer claim)**: https://compass.coupa.com/en-us/products/product-documentation/supplier-resources/for-suppliers/coupa-supplier-portal/set-up-the-csp/purchase-orders/about-purchase-orders , https://www.organon.com/suppliers/coupa-faqs/ . I found no public data on Ariba Network supplier fees; I will not guess.

**Transport.** HTTPS POST of XML (no VAN/AS2 needed), plus the hub's own onboarding/testing.

**Difficulty / adoption.** Mature, very widespread in enterprise indirect/MRO procurement. It is less typical for retail-chain supply (that is X12). Some middleware connectors do not support Confirmation/ShipNotice **(unverified)**.

---

## 4. UBL 2.x, Peppol BIS, and the Peppol network

### 4.1 UBL

- **UBL (Universal Business Language)**: OASIS XML library. UBL 2.4 is an OASIS Standard approved 20 June 2024, superseding 2.3 (15 June 2021); 93 schemas incl. Order, OrderResponse, OrderChange, OrderCancellation, DespatchAdvice, ReceiptAdvice, Invoice, CreditNote, RemittanceAdvice, Catalogue, Forecast, Statement. Source: https://docs.oasis-open.org/ubl/UBL-2.4.html . Peppol uses 2.1 syntax (general knowledge/other sources; JP PINT cites UBL 2.1 syntax). UBL 2.1 as ISO/IEC 19845 is general knowledge, **(unverified)** here.
- Free and open, XML Schema based, no license cost. Easiest to generate with plain XML libs.

### 4.2 Peppol documents

OpenPeppol "Post-Award" (PoAcc) profiles. From the (DEV 2026-Q2) docs: Order T01 v3.7, Order Response T76 v3.3, Despatch Advice T16 v3.5, Order Change T114, Order Cancellation T115, Order Response Advanced T116, Order Agreement T110, Catalogue T19, Punch Out T77, Message Level Response T71, Invoice Response T111. Source: https://docs.peppol.eu/poacc/upgrade-3/ (dev release pages; versions can change). The Finnish retail guide describes "Ordering" profile (Order + Order Response) vs "Order only" and says Finnish retailers generally expect Despatch Advice: https://www.valtiokonttori.fi/en/maaraykset-ja-ohjeet/peppol-ordering-implementation-guide-for-finnish-retail-sector/ .
- **Peppol BIS Billing 3.0**: invoice and credit note CIUS of EN 16931, UBL 2.1 syntax. The only really mandated Peppol document.
- **Remittance:** UBL has a RemittanceAdvice schema, but I found **no evidence of a mainstream Peppol BIS remittance profile**; Peppol is invoicing-centred. **(unverified)**. Payment info in invoices is via PaymentMeans (IBAN etc.).
- **PINT**: Peppol International Invoicing Model, a framework for jurisdiction variants (PINT A-NZ, PINT-SG, JP PINT). Per ecosio, PINT A-NZ became mandatory profile 15 Nov 2024 and older A-NZ profiles dropped 15 May 2025 **(secondary source)**: https://ecosio.com/en/blog/e-invoicing-in-australia-rules-formats-and-timelines/

### 4.3 Network model (four corners)

- Corner 1 sender, corner 2 sender's **Access Point (AP)**, corner 3 receiver's AP, corner 4 receiver.
- **SML** (Service Metadata Locator): one central DNS-style lookup that points to the right SMP; **SMP** (Service Metadata Publisher): decentralised registers listing what document types a participant accepts, the AS4 endpoint, and certificate. Sender's AP resolves participant ID -> SMP -> receiver's AP and delivers via **AS4 over TLS** with an SBDH envelope. Sources (summarised from search results, direct fetch of the German government page 404'd): https://e-rechnung-bund.de/en/faq_category/data-transmission-via-the-peppol-network/ , https://econnect.eu/en/docs/knowledge/peppol/what-is-peppol/peppol-explained .
- Participant IDs: scheme-qualified (e.g. GLN, VAT, national IDs).
- To be an AP you must be OpenPeppol member and certified. Fees (from 1 Jul 2025 for new members; existing members from 1 Jan 2026): Access Point-only provider 1-10/11-50 employees sign-up EUR 1,050, annual EUR 1,850, certification EUR 1,500; AP+SMP S1 sign-up 1,800, annual 2,750, certification 2,500. Source: https://peppol.org/join/fees/
- Open-source building blocks: **phase4** (Java AS4 library with Peppol support, Apache-2.0; a library, not a certified AP) https://github.com/phax/phase4 ; **Oxalis** (Java, LGPL-3.0, development frozen, README points to Oxalis-NG) https://github.com/OxalisCommunity/oxalis . There is no TypeScript AP I found. Building and certifying an AP is a project in its own right; a German government guide says it is complex (https://e-rechnung-bund.de/app/uploads/2025/09/Leitfaden-Uebertragungskanal-Peppol_092025.pdf).
- Practical for Invintel: use a certified AP provider's API (Storecove, Tickstar, etc. are vendors **(vendor)**) and speak UBL JSON/XML to it.

### 4.4 Where Peppol and e-invoicing are mandated or growing

Dates below come largely from vendor blogs plus a few official pages; verify with the national tax authority before relying on them.

| Jurisdiction | State | Source / confidence |
|---|---|---|
| **EU (ViDA)** | VAT in the Digital Age adopted by Council 11 Mar 2025. Structured EN 16931 e-invoicing mandatory for cross-border B2B from 1 Jul 2030; transaction-level digital reporting; member-state alignment up to 1 Jan 2035. EN 16931 revision approved by CEN 13 Feb 2026. | Vendor blogs (https://www.banqup.com/en-be/resources/blog/vida-adopted-everything-you-need-to-know-about-the-new-e-invoicing-and-reporting-requirements , https://www.truecommerce.com/blog/vida-e-invoicing-requirements/). **(unverified against EUR-Lex)** |
| **Belgium** | B2B e-invoicing mandatory for VAT-liable domestic B2B from **1 Jan 2026**; Peppol BIS Billing 3.0 is the primary format and transmission; alternatives only by mutual agreement and a Peppol route must always remain available. Penalties not stated on the page. A vendor mentions a 3-month tolerance to 31 Mar 2026 **(unverified)**. | EC factsheet: https://ec.europa.eu/digital-building-blocks/sites/display/DIGITAL/eInvoicing+in+Belgium (primary) |
| **Germany** | Everyone must be able to *receive* structured e-invoices since 1 Jan 2025; *issuing* mandatory from 1 Jan 2027 for businesses with turnover above EUR 800,000, and from 1 Jan 2028 for all. Formats XRechnung / ZUGFeRD (EN 16931); Peppol is one transport; public bodies use XRechnung via Peppol. | Secondary: https://econnect.eu/en/blog/mandatory-e-invoicing-in-2026-which-countries-are-affected-0 , vendor blogs; **not confirmed on a BMF page** |
| **France** | Reform: from **1 Sep 2026** all VAT-liable firms must be able to *receive* e-invoices and large/mid-size firms must *issue* (e-invoicing and e-reporting); SMEs/micro issue from **1 Sep 2027**. Based on accredited platforms (PA, formerly PDP) and the state directory (PPF annuaire); Peppol is only one possible interoperability path (a vendor says DGFiP was named Peppol authority in July 2025: **(unverified)**). | Secondary FR sources e.g. https://www.legifiscal.fr/vie-affaires/facturation-electronique-plateformes-agreees.html ; sources disagreed in places; verify with impots.gouv.fr |
| **Poland** | KSeF national platform (not Peppol): large taxpayers from 1 Feb 2026, others except micro from 1 Apr 2026, micro from 1 Jan 2027. | Vendor blogs (https://www.lleverage.ai/blog/eu-e-invoicing-manufacturers-2026-guide), **(unverified)** |
| **Other EU** | Italy (SdI), Croatia, others have national systems; I did not research. | n/a |
| **Australia** | ATO is the Peppol Authority. Federal agencies had to be able to receive Peppol e-invoices from 1 Jul 2022. No B2B mandate; ATO promotes voluntary use. PINT A-NZ required profile since 15 Nov 2024. Business E-invoicing Right is a Treasury policy idea; sources conflict on its status. | ecosio https://ecosio.com/en/blog/e-invoicing-in-australia-rules-formats-and-timelines/ ; ATO page returned 403 so not verified: https://www.ato.gov.au/Business/eInvoicing/Peppol/ |
| **New Zealand** | MBIE is Peppol Authority. Central government agencies mandated in 2022; agencies will require large suppliers to send e-invoices from 1 Jan 2027. | Secondary (banqup/Fonoa): **(unverified)** |
| **Singapore** | IRAS/IMDA run InvoiceNow on Peppol (Singapore joined Peppol May 2018). GST InvoiceNow data-transmission phased in: new voluntary GST registrants from 1 Nov 2025 (all new voluntary registrants from 1 Apr 2026), new compulsory registrants and small existing ones from 1 Apr 2028, larger existing ones phased 2029-2031. | Vendor blogs (Comarch, Fonoa, Thomson Reuters summary); **(unverified, check IRAS)** https://www.comarch.com/trade-and-services/data-management/legal-regulation-changes/singapore-expands-mandatory-gst-invoicenow-reporting-to-all-registered-businesses/ |
| **Japan** | Digital Agency is the Peppol Authority (set up Sep 2021); JP PINT is the Japanese spec based on PINT. Official page lists updates (e.g. 9 Dec 2024). Tax Qualified Invoice System is separate; e-invoicing is recommended not mandated; one vendor claims a "mandatory from 9 Mar 2026" for a spec version which conflicts with others. | https://www.digital.go.jp/en/policies/electronic_invoice (primary, thin); vendor sources conflict. **(unverified)** mandate status |
| **United States** | No federal B2B e-invoicing mandate. Market-led: the Business Payments Coalition (Federal Reserve facilitated) grew into the **DBNAlliance** (Digital Business Networks Alliance): non-profit incorporated Jan 2024, four-corner model similar to Peppol, UBL-derived (PINT-based), AS4, federated governance with no national authority, US identifiers (EIN, DUNS, GLN). First production exchange Apr 2024, "10+ certified access points", early adopters in energy; adoption described as limited. Some providers are on both Peppol and DBNA and can bridge. | https://econnect.eu/en/docs/knowledge/regulations/united-states , https://storecove.com/blog/en/digital-business-network-alliance , https://www.storecove.com/blog/en/how-the-dbna-and-peppol-architecture-are-modernizing-u-s-b2b-e-invoicing/ (all vendor/secondary; **(vendor claim)**). I found no evidence of a GSA/Treasury Peppol pilot; one aggregator says federal agencies have been directed to use e-invoicing since 2015 **(unverified)**. |

**Peppol scale.** One vendor cites 1.4 million registered companies and 20 countries with their own Peppol Authority **(vendor claim, date unclear)**: https://www.truecommerce.com/en-gb/blog/the-future-of-peppol/ ; another says 65+ countries reached **(vendor claim)**. I found no breakdown of transaction volumes by document type (invoice vs order vs despatch). Invoice is where the mandates are; Order and Despatch Advice use appears national/sector-driven (e.g. Nordic/Finnish retail, Italian NSO for health) **(unverified generalisation)**.

---

## 5. papiNet and how plants actually exchange POs

### 5.1 papiNet

- **What:** A global, open, XML e-business standard for paper, forest products and bioproducts, "available and usable without charge". Current versions V2.40 (with namespace) and V2.31 (without), backward compatible to V2.0, no plans for V3, new builds roughly twice a year. Transport is not specified (internet/any messaging service). Source: https://papinet.org/materials/faqs/general-information-about-the-standard
- **Documents:** I confirmed `DeliveryMessage` (plus `InitialShipmentAdvice`, `DeliveryMessageBook`) and `OrderConfirmation` (plus a wood variant) in the V2.31 PDFs. Others (product order, invoice, statement/ price/forecast documents) exist per my general knowledge; **names (unverified in this research)**. See https://www.papinet.org/fileadmin/user_upload/v2r31/20260520/pdf/DeliveryMessageV2R31_20260520_2026-06-04.pdf and https://www.papinet.org/fileadmin/user_upload/v2r31/20260520/pdf/OrderConfirmationV2R31_20260520_2026-06-04.pdf
- **User groups:** Forest Wood Supply & Bioproducts, Label Stock, N.A. Fine Paper, Packaging, Paper, Pulp, Recovered Paper, WoodX, XBITS (Book), Logistics. A "Packaging" segment group exists, but the site gives no corrugated detail and no adoption numbers. Source: same FAQ page and https://en.wikipedia.org/wiki/PapiNet (Wikipedia, secondary).
- **Who:** Mills, merchants, printers/publishers, logistics. A 2026 Cepi webinar (chair from Stora Enso) promotes it to printers/publishers; the PDF would not render for me, so contents unverified: https://www.cepi.org/wp-content/uploads/2026/03/Cepinar_PapiNet-for-Printers-Publishers_022026.pdf . papiNet lists testimonials from packaging companies (Neupack, Mayr-Melnhof Karton, SCA Packaging) but I saw no implementation details **(search-result level)**.
- **Honest verdict:** it is the right standard if a corrugator buys board/paper from a mill that offers papiNet (paper-side purchasing, delivery messages with roll/reel identification), but I found **no public evidence that corrugated box plants receive customer POs by papiNet**. Customers of box plants (food/bev/retail) speak X12/EDIFACT/cXML, not papiNet. Treat as an *inbound-material* (supplier) integration candidate, not a customer-PO one.

### 5.2 How corrugated / packaging plants exchange POs today

What I can actually show from public sources (thin):
- **Mixed channels.** DS Smith Sheetfeeding (UK) states orders "may be received via email, post, fax or through our AbbeyEDI platform", lists automatic order confirmations/amendments/cancellations and automated pre-delivery notification. Source: https://www.dssmith.com/sheetfeeding/offering/services (a supplier's own marketing).
- **Portals.** Corrugated Supplies Corp (small US plant) let customers place/edit orders on its website tied to inventory (older case study): https://paginas.fe.up.pt/~acbrito/laudon/ch4/casestudymain.htm . Old, not current practice.
- **Historic EDI.** A 1992 TAPPI paper describes a remote ordering system using EDI for a midwest box plant to get orders in faster and return status: https://imisrise.tappi.org/TAPPI/Products/COR/COR9227.aspx (abstract only).
- **ERP vendors.** Kiwiplan (Advantive) public product page lists Enterprise Sales Processing, "Kiwiplan Message Centre" (described as "automatically connecting and sharing information with customers, suppliers, and third-party systems") and "Transmission Links", but **does not mention EDI by name**: https://www.advantive.com/products/kiwiplan/ . So I cannot confirm any "Kiwiplan EDI module" from public sources. Amtech's EnCore reportedly has an optional EDI feature for trading partners such as sheet and paper suppliers (search snippet of an Amtech press release; page returned 403) **(vendor claim, unverified)**.
- **Retail/CPG customers.** Where a box plant sells into a big retailer or CPG, requirements about 850/855/856/810, 997, labels and ASNs appear in retailer guides (Kroger, KeHE, Sprouts). Those guides are for the retailer's direct suppliers, not box vendors; whether box plants face them is **(unverified)**. What is plausible is that big CPG buyers send box POs through their ERP's EDI or an Ariba/Coupa/SAP supply network (cXML/EDI), while smaller customers email PDFs or use phone/portal. This is my inference, not evidenced publicly.
- Where I found **no** public evidence: share of box plants on EDI, the breakdown of email/PDF vs EDI vs portal, any corrugated-specific EDI implementation guide (FBA or FEFCO), papiNet use by box makers, and specific supplier EDI requirements at large corrugated groups (Smurfit Westrock, International Paper searches returned nothing relevant).

---

## 6. Comparison

Difficulty rating is for a small software vendor shipping inside an open-source Node/TS ERP (my judgement).

| Standard | Document set (PO flow) | Typical users | Typical transport | Difficulty for small vendor | Recommendation for small open-source ERP |
|---|---|---|---|---|---|
| **X12** | 850, 855, 860, 856, 810, 820, 846, 830, 862, 940/945, 997/999 | US/Canada retail, CPG, distribution, auto, healthcare | AS2, SFTP, VAN | Parsing is easy; hard part is per-partner guides, certification testing, ASN hierarchy and label rules, control numbers, acks. Spec access costs money. Medium-high | **Build the core: 850 in, 855 out, 856 out, 810 out, 997/999 in/out.** Keep a partner-profile layer (version, qualifiers, delimiters). Use a managed transport (AS2/VAN provider) at first |
| **EDIFACT / EANCOM** | ORDERS, ORDRSP, ORDCHG, DESADV, RECADV, INVOIC, REMADV, CONTRL | European retail, auto (ODETTE), logistics | AS2, SFTP, VAN, OFTP2 (general knowledge) | Similar to X12; implementation guides vary by partner and directory version | **On demand only.** If a European customer asks; reuse segment tokenizer |
| **cXML** | OrderRequest, ConfirmationRequest, ShipNoticeRequest, InvoiceDetailRequest, PunchOut* | SAP Ariba / Coupa / other procurement-network buyers and their suppliers | HTTPS POST of XML | Low-medium: plain XML, DTDs and examples are public, but each network has its own onboarding and quirks | **Do second.** Good fit for Node; easy to test with sample payloads. Punchout later or never |
| **UBL 2.x / Peppol BIS** | Order, Order Response, Despatch Advice, Invoice, Credit Note (Billing 3.0 is the mandated piece) | EU public + (from 2026) Belgian B2B; AU/NZ, SG, JP; Nordics | Peppol AS4 via access points | Format: low-medium. Network: high if self-hosted AP; low if via a certified AP's API | **Do for invoices first, via a hosted AP.** Only if you have EU/APAC users. Do not build an AP. Model UBL as an export/import alternative to the internal model |
| **DBNAlliance (US)** | UBL invoice-centric | Early adopters, energy sector, US large firms | AS4 via certified APs | Same as Peppol | **Watch**; adoption limited, voluntary |
| **papiNet** | DeliveryMessage, OrderConfirmation and others (full list unverified) | Pulp, paper, merchants, printers/publishers; some packaging groups | Not specified; any messaging (HTTP/SFTP/email) | Low technically (free XSD/docs); the problem is demand, not difficulty | **Optional, later.** Only for inbound paper/board supplier integrations if a mill asks |
| **Email/PDF + portal** | Anything | Most small/mid customer relationships | Email, web | Easy to start; poor automation | **Do first** as baseline: PDF PO capture/attach, customer portal later; add EDI as the premium path |

### Suggested build order (opinion)

1. Canonical internal model: purchase order (header/lines/schedules), ack, shipment (with pack/carton hierarchy and SSCC fields), invoice, payment/remittance. Keep partner-specific mapping out of the core.
2. X12 adapter, 004010 first, with partner profiles. Use an AS2/VAN/web-EDI provider for connectivity (do not run your own AS2 unless needed). Always generate 997/999 and track control numbers.
3. cXML adapter (HTTPS).
4. UBL/Peppol invoice and (maybe) order/despatch through a certified AP's API.
5. EDIFACT / papiNet on customer demand.

---

## 7. Unverified / weak-evidence list

- 4010 vs 5010 share in manufacturing EDI today (no quantified source).
- X12 functional group codes beyond PO; DTM qualifier meanings beyond my example.
- 865 PO Change Acknowledgment (general knowledge).
- cXML owner (SAP Ariba) and PunchOutSetupResponse/StartPage details (general knowledge, cxml.org text did not detail them).
- Whether Peppol has any standard remittance advice profile.
- Germany, France, Poland, NZ, Singapore, Japan dates: from vendor blogs and secondary sources; only Belgium came from an official EC page. Poland and France are not Peppol-based.
- Australia B2B status wording (sources conflict); ATO page unreachable.
- DBNAlliance adoption numbers and dates (vendor/secondary only).
- Any Kiwiplan EDI capability. Public page does not mention EDI; Amtech EDI claim is a search snippet.
- papiNet document list for V2R40, and any corrugated usage.
- Retailer onboarding durations (Walmart six weeks, Home Depot about 15 business days) come from vendor blogs.

## 8. Source list

Primary or near-primary:
- https://www.x12.org/about
- https://www.stedi.com/edi/x12 and https://www.stedi.com/edi/x12/segment/ISA (vendor reference of X12, useful)
- https://cxml.org/
- https://docs.oasis-open.org/ubl/UBL-2.4.html
- https://docs.peppol.eu/poacc/upgrade-3/
- https://peppol.org/join/fees/
- https://ec.europa.eu/digital-building-blocks/sites/display/DIGITAL/eInvoicing+in+Belgium
- https://papinet.org/materials/faqs/general-information-about-the-standard
- https://github.com/phax/phase4 , https://github.com/OxalisCommunity/oxalis , https://github.com/aaronhuggins/node-x12
- https://www.digital.go.jp/en/policies/electronic_invoice

Secondary / vendor:
- https://ecosio.com/en/blog/e-invoicing-in-australia-rules-formats-and-timelines/
- https://econnect.eu/en/docs/knowledge/regulations/united-states
- https://econnect.eu/en/blog/mandatory-e-invoicing-in-2026-which-countries-are-affected-0
- https://econnect.eu/en/docs/knowledge/peppol/what-is-peppol/peppol-explained
- https://storecove.com/blog/en/digital-business-network-alliance
- https://www.comarch.com/trade-and-services/data-management/legal-regulation-changes/singapore-expands-mandatory-gst-invoicenow-reporting-to-all-registered-businesses/
- https://www.legifiscal.fr/vie-affaires/facturation-electronique-plateformes-agreees.html
- https://www.lleverage.ai/blog/eu-e-invoicing-manufacturers-2026-guide
- https://www.banqup.com/en-be/resources/blog/vida-adopted-everything-you-need-to-know-about-the-new-e-invoicing-and-reporting-requirements
- https://www.truecommerce.com/blog/vida-e-invoicing-requirements/
- https://ecosio.com/en/blog/what-is-a-remadv-message/ , https://editelgroup.com/blogs/what-are-edifact-messages , https://docs.ediconnect.ro/en/ediconnect/formats/edifact.html
- https://punchoutcommerce.com/guides/transactions/cxml-confirmation-request/ , https://tradecentric.com/blog/cxml-examples/ , https://help.cimcloud.com/help-center/punchout-via-cxml-base
- https://compass.coupa.com/en-us/products/product-documentation/supplier-resources/for-suppliers/coupa-supplier-portal/set-up-the-csp/purchase-orders/about-purchase-orders , https://www.organon.com/suppliers/coupa-faqs/
- https://www.spscommerce.com/community/articles/ready-to-ship-at-kehe-from-edi-855-to-edi-753 , https://edi.kroger.com/EDIPortal/ProgramAndRequirements/Fredmeyer/PR_QuickResponse.html
- https://www.truecommerce.com/edi-transaction-codes/edi-862/ , https://www.1edisource.com/resources/edi-transactions-sets/edi-860/
- https://orderful.com/blog/as2 , https://www.ediconnect.ro/en/web-edi/as2-vs-sftp
- https://www.dssmith.com/sheetfeeding/offering/services
- https://www.advantive.com/products/kiwiplan/
- https://imisrise.tappi.org/TAPPI/Products/COR/COR9227.aspx
- https://paginas.fe.up.pt/~acbrito/laudon/ch4/casestudymain.htm
- https://en.wikipedia.org/wiki/PapiNet


---

# Part 2. Transports, bridges and vendors

## 0. Top findings (read this first)

1. **Stedi's published pricing page is healthcare-only.** The page I fetched (stedi.com/pricing) is titled "pay-as-you-go pricing for Stedi's programmable healthcare clearinghouse" (eligibility, claims, ERA...). It lists no price for X12 850/810/856. The general EDI platform (JSON<->X12, partnerships, AS2/SFTP, webhooks) is real and documented, but I could NOT find a published price for it. Third-party listings quote "$500/month minimum" and "first 100 free" (unverified, and an older cached version of the page seemed to show a $500 "Getting Started" tier). Treat Stedi EDI cost as "ask sales".
2. **Orderful publishes the only clear per-partner EDI price I found**: Web EDI "Pixel" from $189/month per trading partner, Integrated "Mosaic" from $399/month (VERIFIED on their pricing page). Per-partner flat pricing is a bad fit if Invintel wants to embed it for many tiny customers, but the API is clean (REST, webhook with HMAC, test stream, demo partner).
3. **AWS B2B Data Interchange has real published pricing** (VERIFIED): $8 per active partnership per month, $0.01 per document per transformation step. No AS2 included in that page's pricing (AS2 via AWS Transfer Family, billed separately). Cheapest published unit economics I found, but it is AWS-only plumbing, not a network.
4. **Open-source AS2 is real and alive**: OpenAS2 (Java, GPL-3.0) had a release note for 4.9.0 dated 2026-07-27 per a merged PR (unverified that it's tagged). mendelson AS2 open edition is Java GPLv2 but I found no recent version evidence. The Node AS2 story is thin: `@mistweaverco/libas2` is a fork of an abandoned beta lib, "not certified". Realistic plan: run OpenAS2 as a sidecar (Docker), not roll our own in Node.
5. **Peppol is a different world (invoices/orders in Europe/AU/SG etc.), not US manufacturing EDI.** Becoming your own access point costs about EUR 1,050 signup + EUR 1,850/yr (small-company tier, includes EUR 1,500 certification) VERIFIED, plus real engineering and ops. Not realistic for Invintel itself in v1. Use a provider API (Storecove etc.) or let the customer pick their own.
6. **Other open-source ERPs mostly punt**: Odoo ships Peppol invoicing in Community (VERIFIED: Odoo acts as the AP/SMP), but X12/AS2 comes from paid third-party add-ons (~$626-$1,000 each, listing prices, unverified as current). ERPNext has no native EDI engine (vendor claim from Orderful; Frappe forum thread confirms users asking, no finished app). Dolibarr has Peppol modules of unclear status. No evidence of OFBiz or InvenTree EDI support found.

**Suggested architecture for Invintel (my opinion, not a fact):** internal canonical document model (PO, POAck, ASN, Invoice, Remittance) + a pluggable "transport/translator adapter" interface. Ship adapters in this order: (a) plain HTTPS/JSON webhook + CSV/SFTP drop (zero vendor), (b) one API-first EDI provider adapter (Orderful or Stedi, customer brings their own account), (c) OpenAS2 sidecar for customers whose partner demands AS2, (d) Peppol via provider API later. Never make Invintel a multi-tenant EDI intermediary itself in v1.

---

## 1. Transports

### 1.1 AS2 (RFC 4130)
**How it works.** HTTP(S) POST of an S/MIME-packaged payload (X12, EDIFACT, XML, binary) from one AS2 server to another. Each side has an AS2 ID, a URL, and an X.509 certificate; you exchange public certs with each partner. Messages are signed and optionally encrypted. The receiver returns an **MDN** (Message Disposition Notification), a signed receipt that gives non-repudiation. MDN can be synchronous (same HTTP response) or asynchronous (receiver calls you back at a URL you gave it, so you need an inbound public endpoint). Source: https://www.rfc-editor.org/rfc/rfc4130.html (VERIFIED via search result text). RFC recommends SHA-1 for signing, MD5 allowed; real partners now ask for SHA-256 (unverified from my sources, common practice). A rewrite, draft-petta-rfc4130bis, was posted Jan 2026 and is still a draft (per search result).

**Certs and ops pain (general industry knowledge, not from a source I fetched):** self-signed certs are normal; you swap them by email with each partner; expiry and rollover is the classic operational failure; many retailers require specific ports, IPs, and test cycles. I did not find a source in this session describing small-partner cert practice, so treat that as (unverified).

**Open-source implementations**
| Impl | Lang / license | State |
|---|---|---|
| OpenAS2 https://github.com/OpenAS2/OpenAs2App | Java 11+, GPL-3.0, 240 stars, 6 open issues (VERIFIED from repo page). Docker + env-var config, WebUI, REST API config key present. | Release notes for 4.8.3 (2026-06-26) and 4.9.0 (2026-07-27) seen in a merged PR diff (unverified they are tagged releases; GitHub release page in the snippet was stale). Looks actively maintained. |
| mendelson AS2 (open-source edition) https://www.sourceforge.net/projects/mec-as2 | Java, GPLv2 (per SourceForge listing). GUI-heavy. | No 2025-26 release evidence found (heise listing "updated March 2025"; winget shows build 1.1b69, undated). Maintenance state: (unverified). mendelson also sells a commercial version (not researched). |
| `@mistweaverco/libas2` (npm) | Pure JS/TS, fork of `libas2` | README says original is unmaintained and "not a certified library"; supports sign/encrypt/MDN. Version and activity not checked. Risky as a foundation. (unverified) |
| Other: pyas2 (Python), Apache Camel + Smooks route for AS2 + X12 | | Not evaluated. |

**Pros:** what big retailers and many manufacturers' customers actually require; signed receipts; works over normal HTTPS.
**Cons:** cert exchange per partner; public inbound endpoint (static IP/firewall work for a plant); async MDN complexity; every partner has quirks; interop testing per partner.
**Realism for Invintel:** Do NOT write AS2 in Node. Offer "bring your own AS2 box": an OpenAS2 Docker sidecar that drops/picks files in a folder or calls an HTTP hook on Invintel. GPL-3.0 sidecar is fine to ship as a separate process (license/legal check needed on distribution, I am not a lawyer).

### 1.2 SFTP / FTPS drops
**How it works.** Trading partner (or a provider) hosts an SFTP server; you push/pull files (850s in, 855/856/810 out) on a schedule. No receipt built in; acknowledgement is a separate document (X12 997 / EDIFACT CONTRL) or nothing. Stedi, DiCentral, Cleo, etc. all list SFTP/FTPS (Stedi docs: Connections = Stedi SFTP/FTPS, Remote SFTP/FTPS, AS2, Buckets VERIFIED; DiCentral AS2/sFTP/OFTP2 from a profile page (unverified)).
**Pros:** trivial to build in Node (`ssh2-sftp-client`), firewall-friendly (outbound only), plant IT understands it. Good "v1" transport and the way small customers' partners often work.
**Cons:** polling, partial-file races, no non-repudiation, credential/host-key management, each partner has own naming rules.
**Realism:** High. Build this natively as the first-class built-in transport.

### 1.3 VANs (value-added networks)
**What they do.** A VAN is a mailbox in the middle: you send to the VAN once; it routes to each partner's mailbox and handles protocol differences, interconnects with other VANs, keeps audit logs, and bills by volume. Typical vendors: OpenText (GXS), SPS, TrueCommerce, Kleinschmidt, Cleo.
**Pricing model.** Per vendor writeups: setup fee, monthly mailbox fee, and variable fees by **kilo-character (KC)** (1 KC = 1,000 chars) or per document. Worked examples only, not market rates:
- Mailbox: one provider's 2024 notice listed a flat $115/month per VAN mailbox with no volume fee up to 40,000 KC (https://sellercloud.com/?p=25244, snippet, one vendor's list price, (unverified) as a benchmark).
- KC example: $0.20/KC means a 250 KC file costs $50 (Crisp and Orderful both use this example; illustrative).
- Orderful's "hidden fees" list (KC rounding, envelope fees, archive retrieval, onboarding "several hundred dollars" per partner, "$1.20 to $3.00 per transaction" effective) is **(vendor claim)** from a competitor's blog: https://www.orderful.com/blog/edi-transaction-fees-explained.
**Interconnects.** VANs exchange traffic with each other so you only need one; some charge interconnect fees (general knowledge, not sourced here).
**Pros:** one connection, partner onboarding handled, no cert swapping.
**Cons:** per-document/KC bills that surprise small shippers; lock-in to mailbox IDs/qualifiers; the VAN is a tollbooth.
**Realism:** Invintel should treat a VAN as "just another SFTP/AS2 endpoint" the customer buys on their own. Do not resell.

### 1.4 Peppol (access points)
**What it is.** A network (run by OpenPeppol) where you reach any receiver through your Access Point (AP) using a shared addressing layer (SMP/SML) and the **AS4** transport. Mostly invoices and credit notes (BIS Billing 3.0 UBL), plus orders/despatch advice in some profiles. Strong in the EU, Nordics, Belgium (mandate), Singapore, Australia/NZ. Not a US manufacturing standard.
**How to connect.** (a) pick a certified AP provider and use their API/portal; (b) be your own AP.
**Being your own AP.** OpenPeppol Service Provider (Access Point only, category 2b), fees for members joining from 1 July 2025 (VERIFIED https://peppol.org/join/fees/):
| Org size | Sign-up | Annual (includes EUR 1,500 AP certification fee) |
|---|---|---|
| S1-S2 (1-50 employees) | EUR 1,050 | EUR 1,850 |
| S3 (51-250) | EUR 2,200 | EUR 3,100 |
| S4 (251-2,500) | EUR 2,550 | EUR 4,250 |
| S5 (>2,500) | EUR 2,950 | EUR 5,500 |
The page says the committee can change fees at any time; AP+SMP tier costs more. Membership also requires signing a Service Provider Agreement and passing certification/testing (process described in OpenPeppol's "how to set up a post-award Peppol AP" PDF; I did not read the test details).
**Open-source AP software**
- **phase4** (Java, Apache-2.0, 244 stars, 4,042 commits, embeddable AS4 lib incl. Peppol profile) https://github.com/phax/phase4 (VERIFIED repo page). Peppol.org lists it as open-source AS4 software but states it is **not accredited** by OpenPeppol (search result, VERIFIED listing text; accreditation is per operator, not per library).
- **phoss-AP** (same author, built on phase4 + Spring Boot; sender-AP-to-receiver-AP leg only, no C1/C4; Postgres/MySQL, filesystem or S3) https://github.com/phax/phoss-ap/wiki/Architecture-Overview. Certification status: not found.
- **Oxalis** (classic) https://github.com/OxalisCommunity/oxalis : LGPL-3.0, **"Further Development Frozen"** notice VERIFIED; points to **Oxalis-NG** (https://github.com/OxalisCommunity/oxalis-ng), per one blog (https://www.pistack.xyz/posts/2026-10-14-self-hosted-peppol-access-points-phoss-ap-oxalis-ng-mustangproject/, single non-official source) NG is the active line but heavy to operate.
**Pros:** one connection to a huge network, structured legal-grade invoice; free-ish via Odoo-style providers.
**Cons:** certification + annual fee + 24/7-ish ops duty; mostly invoices; geography-bound.
**Realism:** Own AP: no. Provider API: yes, optional later module, only if Invintel's customer base has EU/AU/SG buyers.

### 1.5 HTTPS / API (cXML, REST)
- **cXML** (https://cxml.org): XML over HTTPS POST. Used heavily by SAP Ariba and Coupa style procurement. Flow per Ariba supplier guides: HTTPS endpoint + shared secret for auth; PunchOut (PunchOutSetupRequest/Response) for catalogs; `OrderRequest` for POs. Secondary sources only (https://www.ingka.com/wp-content/uploads/2025/05/EMEA-PunchOut-Guide-Excel.pdf, https://eprocurement.nc.gov/media/95/open). I did not read the cXML spec itself so field-level claims are (unverified).
- **REST/JSON direct to the partner:** increasingly offered by big customers and by marketplaces. Each one is bespoke.
- **Provider REST APIs** (Stedi, Orderful, Storecove): see section 2.
**Pros:** easiest for a Node app; real-time; sync ack; standard TLS.
**Cons:** no universal schema; partner-specific; auth/secret handling.
**Realism:** High. Build generic "outbound webhook / inbound endpoint" with HMAC + templates, add cXML OrderRequest/ConfirmationRequest as a mapped format.

### 1.6 AS4
ebMS3/AS4 (OASIS) is the AS2 successor, SOAP/WS-Security based; mandatory for Peppol (One-Way/Push only exchange pattern, per OpenPeppol spec https://docs.peppol.eu/edelivery/as4/specification/). Outside Peppol/EU eDelivery, little use in US manufacturing. Libraries: phase4 (Java) is the main open one. **Realism:** only via Peppol, only via a provider or a Java sidecar.

---

## 2. Providers

Pricing columns say VERIFIED only when I saw it on the vendor's page. "Quote only" = no price published.

### 2.1 API-first

**Stedi** (https://www.stedi.com)
- Offers: general EDI platform ("EDI translation layer") + a separate healthcare clearinghouse. EDI platform components (VERIFIED from https://www.stedi.com/docs/edi-platform): Partnerships (trading-partner config: transaction sets + transport), Connections (Stedi SFTP/FTPS, remote SFTP/FTPS, AS2, Buckets), Guides (EDI guide framework using JSON Schema), Mappings (UI builder, API, JSONata), Fragments (split inbound/outbound), Webhooks and Events, monitoring/test-file generation/retries.
- JSON <-> X12: EDI Translate API, `POST https://edi-translate.us.stedi.com/2022-01-01/x12/to-json` (`input`, `guideId`) and `/x12/from-json` (adds `envelope`) (from search result quoting docs; endpoints (unverified) against live docs, but consistent with https://stedi.com/blog/translate-between-json-and-edi).
- Vendor claim: "can add a trading partner configuration in about 15 minutes" plus free onboarding call (VERIFIED that the page says it; it is a vendor claim as a fact).
- Integration style: REST + webhooks + SFTP/AS2; MCP server mentioned on pricing page (healthcare). Sample code: https://github.com/Stedi-Demos/bootstrap (partner profile creation via Partners API).
- **Pricing:** the published page covers healthcare only, tiered pay-as-you-go, no monthly minimum or setup fees (VERIFIED), e.g. claim submissions $0.30 down to $0.10; ERAs $0.20 to $0.08; 277CA free. **No 850/810/856 price found.** Third-party listings: "$500/month minimum, first 100 free" (unverified, https://us.fitgap.com/products/stedi). Stedi account docs: new accounts start as free sandbox, limited to test mode; upgrading needs MFA and a BAA (VERIFIED, but those steps are written for the healthcare flow).
- Sandbox: free, VERIFIED for healthcare accounts. Whether general EDI has its own test mode: Not confirmed on the pages I read.
- Fit for embedding: good developer model (pure API, JSON in/out) and customers could bring their own Stedi account. Open question: cost per tiny manufacturing customer, resale/partner terms. **Ask sales** before designing around it.
- Risks: price unknown for our use case; US-centric X12; vendor lock-in to guides/mappings (JSONata mappings are portable-ish).

**Orderful** (https://www.orderful.com, docs https://docs.orderful.com)
- Offers: cloud EDI network ("Orderful network" of pre-connected retailers/suppliers), X12 850/855/856/810 named in docs (VERIFIED), also 860.
- Integration style: REST API with `orderful-api-key` header, base `https://api.orderful.com`; `POST /v4/transactions` (Mosaic), `GET /v3/transactions`, `GET /v4/inbox` (VERIFIED from quick start, mixed v3/v4 endpoints noted by their own doc). Webhook (push) via Settings -> Communication Channels (HTTP), auth OAuth2 or Basic, **HMAC-SHA256 signature in `x-orderful-signature`** header, sync 200 auto-approves / async 202 then approve-or-fail endpoint, or polling inbox; hybrid recommended (VERIFIED from https://docs.orderful.com/reference/integration-patterns-architecture). Separate "Mosaic" (JSON) vs "Traditional (X12)" API sections.
- **Sandbox/test:** `stream: test` field; demo "Retail Scenario Testing Demo" partner under Integration Testing sends sample 850s and accepts 855/856/810 (VERIFIED from quick start). Whether the test stream costs anything: not stated.
- **Pricing (VERIFIED, https://www.orderful.com/pricing, page footer says 2025 so may be stale):** Labels from $99/mo; Web EDI Fulfillment $189/mo **per trading partner** (webforms, UCC-128 labels, AS2/FTP/VAN, no REST API); Integrated from $399/mo (adds REST API, SSO, integration support); Enterprise custom (>20 partners). No per-transaction fee listed.
- **Vendor claims (not verified):** "no transaction fees, no VAN charges, no separate mapping/support costs"; "typically reduces total EDI costs 40-60%"; "9-day average onboarding"; competitors charge $1,000-$5,000 setup per partner (https://www.orderful.com/blog/edi-pricing-guide). They also state ERPNext has no native EDI engine and advertise ERPNext/NetSuite connectors (vendor claim).
- Fit: great API for an ERP integration; the per-partner flat fee is predictable but multiplies fast. The **customer should hold the Orderful account**, Invintel is the integration, not the reseller.
- Risks: lock-in to their network IDs; fee scales with partner count; Integrated minimum $399 is heavy for a 3-person plant.

**AWS B2B Data Interchange** (https://aws.amazon.com/b2b-data-interchange/pricing/) -- not on your list, but has the clearest public price.
- VERIFIED: $8 per active partnership/month (prorated daily); $0.01 per document per transformation step; large docs billed per 200 KB; generative-AI mapping billed via Bedrock; no upfront costs. AS2 not included on that page; AWS example uses AWS Transfer Family at $0.30/endpoint-hour + $0.01 per inbound AS2 message (VERIFIED example). No free tier mentioned.
- Fit: cheap and API-driven but you operate more (S3, EventBridge, IAM). Doesn't give you a partner network. Fine as an optional backend adapter.

### 2.2 Traditional / managed EDI providers
| Provider | What | Integration style | Pricing | Sandbox | Small open-source ERP fit |
|---|---|---|---|---|---|
| **SPS Commerce** | Retail-focused EDI network (suppliers to big retailers), Fulfillment web EDI | Portal, ERP connectors, flat-file. Developer API: not found. | Quote only. Aggregators: entry tiers $20 / $99 / $349 per month and per-partner setup $1,000-$1,250 plus support fees (third-party reseller figures, **unverified**, https://erpresearch.com/erp-add-ons/edi/sps-commerce/pricing, https://support.owd.com/support/edi-costs). Reviews mixed on hidden fees. | Not found | Poor. Built for suppliers of retailers; no embed story. |
| **TrueCommerce** | EDI + ERP-integrated, "Foundry" cloud platform | Native ERP connectors (SAP B1, Dynamics, Acumatica...), APIs, flat files, Peppol | Mostly quote; their page shows an SMB integrations tier "From $99 per month" and a $179 SMB figure (search snippet of their pricing page, partially verified); third parties say Web EDI ~$20/mo, ERP-integrated $349-$1,200+/mo plus setup per partner (unverified) | Not found | Medium-poor. Has a connector business model, but no open dev docs found; you would be a "connector partner" negotiation. |
| **Cleo Integration Cloud** | Mid-market/enterprise integration + EDI, supports HTTPS/FTPS/SFTP/AS2/email | Platform, managed or self-service | Quote only. One reviewer says AS2 licensing was cost-prohibitive as partners grew (GetApp, unverified). GetApp "$99" figure is not reliable. | Not found | Poor for resale; enterprise-oriented. |
| **OpenText (GXS) Trading Grid / B2B Integration Essentials** | Large VAN and managed services | Enterprise integration, managed services | Quote only (ERP Research). Capterra "$9 usage-based" figure is unreliable. | Not found | Poor. Enterprise, quote-driven. |
| **Kleinschmidt** | Managed EDI, VAN, API/JSON integration, many industries incl. manufacturing | Managed service, JSON API payloads, flat files | Quote only; Capterra shows "$200 usage-based" (unverified; only 2 reviews) | Not found | Medium for a customer who wants it done for them; not embeddable. |
| **DiCentral** | Cloud EDI, AS2/sFTP/OFTP2, SAP B1 reseller add-ons | REST, file transfer, ERP connectors (per third-party profile) | Third-party shows "from $30/month" and negotiated tiers (unverified) | Not found | Medium-poor. Reseller/partner model. |
| **Babelway** (https://www.babelway.com/pricing/) | Cloud integration/B2B gateway, protocols Peppol, AS2, FTP, SFTP, email, REST client, VAN, HTTP, SAP | Portal config + APIs | **VERIFIED published plans:** Lite EUR 99/mo (200 msgs), Bronze EUR 300 ($350; 800), Silver EUR 675 ($800; 2,750), Jade EUR 1,300 ($1,500; 8,000), Gold EUR 2,000 ($2,500; 25,000) ... Diamond EUR 35,000. Message counts are not hard caps; overage rate not stated. Which protocols per plan: not stated. | "30-day trial" link, scope unknown | Medium. Flat monthly per-message-bucket is predictable and covers AS2+Peppol; but it's a hub for a company, not multi-tenant embed. |

**Lexmark:** no evidence it is an EDI provider; skipped. **Datamolino:** not researched/confirmed as an EDI vendor; skipped. (Both were flagged "only if real".)

### 2.3 Peppol access-point providers
| Provider | What I verified | Notes |
|---|---|---|
| **Storecove** (https://www.storecove.com/docs) | VERIFIED developer model: REST/JSON, `https://api.storecove.com/api/v2/`, Bearer API key, `POST /document_submissions` returns GUID, evidence endpoint, webhooks (push retries up to 5 days, or pull FIFO queue), discovery `POST /discovery/receives`, networks incl. Peppol, DBNAlliance, plus country regimes (Italy SDI, Poland KSeF, Spain FACe, Finland Finvoice...). Sandbox account by request form, with webhook simulation and test networks. | Pricing: **not found officially**. Only unreliable forum text (EUR 495/mo enterprise, per-invoice tiers), ignore. Doc didn't confirm credit notes; has order schemas. Best-fit "API-first Peppol" for an embeddable ERP (InvoiceNinja appears to use a Storecove proxy, from a forum title, unverified). |
| **Pagero** | Listed as a Peppol AP; Microsoft says Business Central's Peppol support uses APIs from Pagero and Avalara (https://learn.microsoft.com/en-ca/dynamics365/business-central/faq-electronic-invoicing). | No public API pricing found. Enterprise lean. |
| **Tradeshift** | Peppol AP, small-business heavy G2 audience. Microsoft says Tradeshift integration is no longer supported in Business Central and is planned for deprecation (same FAQ). | Status in flux; (unverified) forward direction. |
| **Basware** | Peppol AP, enterprise AP-automation. | No public API pricing found. |
| **eInvoice.sg** | Offers first 500 documents/month free (search snippet, unverified). | Singapore only. Example of low-cost AP. |
| **Odoo (as provider)** | VERIFIED: Peppol registration free in Odoo Community; Odoo acts as AP and SMP. | Invoices only, EU/eligible countries. |

---

## 3. Embedding patterns in other open-source ERPs

**Odoo.**
- Peppol e-invoicing: built in, Community included, no separate provider; sends customer invoices/credit notes (BIS 3.0, XRechnung, NLCIUS), receives vendor bills as drafts; test mode via `account_peppol.edi.mode` = `test`; orders not mentioned; one active receiver registration per endpoint ID, you must deregister before switching providers. VERIFIED, https://www.odoo.com/documentation/18.0/applications/finance/accounting/customer_invoices/electronic_invoicing.html. (I read the first 100k chars of 103k.)
- OCA `edi` repo (AGPL-3.0, 19.0 branch): modules for UBL generate/parse, invoice/order import, despatch advice import, base_edi. No AS2/SFTP/Peppol/X12 mentioned on the page I read (VERIFIED) https://github.com/OCA/edi.
- Third-party X12/EDIFACT/AS2 add-ons on the Odoo app store (paid): e.g. Vraja AS2+FTP X12 (850/860/855/856/810/846/832/997) $852.70 for v19, supplier-side X12 $626.14, Aski retailer connector $999 (v17, signed AS2 or SFTP) (listing prices, snapshot, unverified current). Examples: https://apps.odoo.com/apps/modules/19.0/as2_edi_ansi_x12_odoo_integration, https://apps.odoo.com/apps/modules/17.0/jjro_edi_connector.
- Community complaints: I did NOT find forum posts to cite. Visible pattern only: native EDI absent for X12, gap filled by paid per-version add-ons (each Odoo major version needs a re-purchased/ported module). Odoo SaaS docs say some features need Studio or Enterprise (e.g. extra Peppol fields need Studio, VERIFIED).

**ERPNext / Frappe.**
- No native EDI engine (Orderful says so, vendor claim). Frappe forum thread "EDI Integration Options" shows users asking for 850/855/856 and a carrier link; one reply built EDIFACT ORDERS/INVOIC (https://discuss.frappe.io/t/edi-integration-options/47130). Commercial ECOSIRE Peppol connector (paid, built for v15/v16, vendor claim) and Alumio iPaaS for X12 (middleware). Orderful advertises an ERPNext integration (vendor claim). No maintained open-source X12/AS2 app found.

**Dolibarr.** Wiki "Electronic Billing" points to Dolistore Peppol XML invoice module and a "Peppol Full Integration client" marked "to be confirmed"; DoliCloud says external format modules should be standard from early 2026 (that date has passed; status unchecked) (https://wiki.dolibarr.org/index.php/Electronic_Billing, https://www.dolicloud.com/are-dolicloud-and-dolibarr-ready-for-electronic-invoicing.php). No X12/EDIFACT/AS2 module found.

**InvenTree.** Only a supplier-cart plugin (`inventree-supplier-panel`: pushes a PO to Mouser/Digikey carts via their web APIs, creates a new cart each time, needs cleanup) https://inventree.org/SergeoLacruz/inventree-supplier-panel. Not EDI. No other EDI work found.

**Apache OFBiz.** Nothing found in this session. Search returned no OFBiz EDI/Peppol info; treat as "unknown", not "none".

**Take-aways for Invintel:** (1) nobody in open source ships a good X12 story; it is a gap Invintel can own but only by *connecting*, not by implementing the network; (2) the market pattern is "core stays free, connectors are paid/third-party"; (3) Peppol is the one area where an ERP can ship a free built-in path (Odoo did, by being the AP); (4) community pain is version churn, per-partner mapping work, and cost.

---

## 4. Comparison table

| Option | Transport | Document sets | Cost signal | Integration effort | Sandbox | Fit for small OSS ERP | Risks |
|---|---|---|---|---|---|---|---|
| Native SFTP drop (built in) | SFTP/FTPS | Any (X12/EDIFACT/CSV/XML via our mappers) | $0 software; partner/VAN may charge | Low-medium (Node `ssh2`) | Self-hosted test server | High | No ack/receipt; per-partner naming rules |
| Native HTTPS/webhook + cXML | HTTPS | PO, ack, ASN, invoice (cXML OrderRequest etc.) | $0 | Low | Self-hosted | High | Bespoke per partner; secret mgmt |
| OpenAS2 sidecar | AS2 | Any payload | $0 software, GPL-3.0; ops time | Medium (Docker, certs, async MDN, public endpoint) | Self-hosted loopback test | Medium-high | Cert expiry; GPL distribution; ops burden |
| mendelson AS2 (open) | AS2 | Any | $0, GPLv2 | Medium; GUI-centric | Self | Low-medium | Maintenance unclear |
| Node libas2 fork | AS2 | Any | $0 | High (beta, uncertified) | Self | Low | Unmaintained lineage |
| Stedi (EDI platform) | AS2, SFTP/FTPS, API | X12 translation, any set via guides | **Not published for EDI**; healthcare page only; third-party "$500 min" (unverified) | Medium (API + guides + webhooks) | Free sandbox (verified for healthcare accounts) | Medium-high if price OK | Unknown price; US-centric; lock-in to guides |
| Orderful | AS2/FTP/VAN/HTTP, REST | 850/855/856/810/860 + network of partners | From $189/partner/mo web EDI; from $399/mo integrated (verified, 2025 page) | Low-medium (clean REST + HMAC webhooks) | Test stream + demo partner (verified) | Medium (customer-held account) | Per-partner fee grows; network lock-in |
| AWS B2B Data Interchange | via AWS Transfer Family (AS2) / S3 | X12/EDIFACT <-> JSON/XML | $8/partnership/mo + $0.01/doc/step (verified) | Medium-high (AWS plumbing) | AWS accounts | Medium (optional adapter) | Not a network; AWS lock-in |
| Babelway | AS2, SFTP, Peppol, REST, VAN, etc. | Any (hub) | EUR 99-35,000/mo by message bucket (verified) | Medium (portal config) | 30-day trial (scope unknown) | Medium | Plan-to-protocol mapping unclear; single-tenant hub |
| SPS Commerce | VAN/network | Retail EDI | Quote; third-party tiers + $1k setup/partner (unverified) | Low (portal) / medium | Not found | Low | Per-partner setup, billing complaints |
| TrueCommerce | VAN, ERP connectors, API, Peppol | Broad | From ~$99/mo SMB, otherwise quote | Medium (connector program) | Not found | Low-medium | Connector gatekeeping; setup fees |
| Cleo / OpenText / Kleinschmidt / DiCentral | AS2, SFTP, VAN | Broad | Quote only (third-party hints unreliable) | Medium-high; managed | Not found | Low | Enterprise sales cycle, AS2 licensing cost, lock-in |
| Storecove (Peppol API) | Peppol AS4 + country networks | Invoices (orders schemas exist) | Not published (unverified numbers only) | Low-medium (REST + webhooks) | Yes, by request | Medium-high (EU/AU/SG customers) | Unknown pricing; Peppol-only coverage; legal entity setup |
| Odoo-style own AP (phase4/phoss-AP/Oxalis-NG) | AS4 | Invoices | EUR 1,050 + 1,850/yr small tier (verified) + ops | High (cert, ops, uptime) | Peppol test network (cert needed) | Low | Certification, ops, specs churn, Oxalis classic frozen |

---

## 5. Open questions to get from sales (not from public sources)
1. Stedi: price for X12 850/855/856/810 on the EDI platform; is there a free sandbox for non-healthcare; partner/reseller terms for an ERP embedding it for many small customers.
2. Orderful: partner/OEM pricing for an ERP vendor; whether test stream is free; Mosaic vs v3/v4 endpoint stability.
3. Storecove: real per-document pricing and whether a software vendor can onboard sub-accounts programmatically.
4. OpenAS2: confirm 4.9.0 is a tagged release and its REST API scope before building around it.
5. Which transports do Invintel's target customers' actual trading partners require? (Interview 5-10 plants; this determines everything.)

## 6. Source list
- Stedi pricing (healthcare): https://www.stedi.com/pricing
- Stedi EDI platform docs: https://www.stedi.com/docs/edi-platform
- Stedi accounts and billing: https://www.stedi.com/docs/edi-platform/accounts-and-billing
- Stedi JSON<->EDI blog: https://stedi.com/blog/translate-between-json-and-edi
- Stedi bootstrap demo: https://github.com/Stedi-Demos/bootstrap
- Orderful pricing: https://www.orderful.com/pricing
- Orderful docs: https://docs.orderful.com/reference/quick-start , https://docs.orderful.com/reference/integration-patterns-architecture
- Orderful blogs (vendor claims): https://www.orderful.com/blog/edi-transaction-fees-explained , https://www.orderful.com/blog/edi-pricing-guide , https://www.orderful.com/blog/erpnext-edi-integration
- AWS B2B Data Interchange pricing: https://aws.amazon.com/b2b-data-interchange/pricing/
- Babelway pricing: https://www.babelway.com/pricing/
- Storecove docs: https://www.storecove.com/docs
- OpenPeppol fees: https://peppol.org/join/fees/
- phase4: https://github.com/phax/phase4 ; phoss-AP: https://github.com/phax/phoss-ap/wiki/Architecture-Overview ; Oxalis: https://github.com/OxalisCommunity/oxalis
- Peppol AS4 spec: https://docs.peppol.eu/edelivery/as4/specification/
- OpenAS2: https://github.com/OpenAS2/OpenAs2App ; mendelson: https://www.sourceforge.net/projects/mec-as2
- RFC 4130: https://www.rfc-editor.org/rfc/rfc4130.html
- Odoo Peppol docs: https://www.odoo.com/documentation/18.0/applications/finance/accounting/customer_invoices/electronic_invoicing.html ; OCA edi: https://github.com/OCA/edi
- Odoo third-party EDI add-ons: https://apps.odoo.com/apps/modules/19.0/as2_edi_ansi_x12_odoo_integration
- Frappe forum: https://discuss.frappe.io/t/edi-integration-options/47130
- Dolibarr: https://wiki.dolibarr.org/index.php/Electronic_Billing
- InvenTree supplier panel: https://inventree.org/SergeoLacruz/inventree-supplier-panel
- Third-party pricing aggregators (unverified): https://erpresearch.com/erp-add-ons/edi/sps-commerce/pricing , https://erpresearch.com/erp-add-ons/edi/opentext-trading-grid/pricing , https://erpresearch.com/erp-add-ons/edi/cleo-integration-cloud/pricing , https://www.capterra.com/p/183675/Kleinschmidt-EDI-Integration/ , https://www.selecthub.com/edi-software/dicentral/ , https://us.fitgap.com/products/stedi
- VAN fees examples: https://sellercloud.com/?p=25244
- Microsoft BC e-invoicing FAQ: https://learn.microsoft.com/en-ca/dynamics365/business-central/faq-electronic-invoicing
- Self-hosted Peppol APs blog (single non-official source): https://www.pistack.xyz/posts/2026-10-14-self-hosted-peppol-access-points-phoss-ap-oxalis-ng-mustangproject/


---

# Part 3. Mapping layer design (my proposal)

## 3. How the mapping layer should look

This section is design, not research: it is my proposal for how Invintel could carry B2B documents, written against the code as it is today (`PurchaseOrderDoc`, `SupplierDoc`, the ledger, approvals, alerts, audit). Nothing here is built.

### 3.1 Principles

1. **Our PurchaseOrder stays the source of truth. A B2B message is a separate record about it.** The PO keeps its own states (draft, ordered, partial, received, cancelled); arrival still comes from the ledger. The message record says what we sent or received, when, over what, and what the other side answered. A failed send never changes a PO's stock meaning.
2. **One canonical JSON per document type, owned by us.** Standards (X12, EDIFACT, cXML, UBL) are adapters at the edge. We map PO <-> canonical <-> standard, never PO <-> standard directly. This keeps the number of mappings linear and lets us add a standard without touching the PO code.
3. **Transports are adapters behind one interface.** The mapping layer does not know whether the bytes go by AS2, SFTP, a provider's API, Peppol or email.
4. **Everything is idempotent and replayable.** Raw payloads are stored immutably, every send has an idempotency key, and any message can be re-sent or re-mapped from the stored canonical.
5. **Test mode is a first-class property of a partner, not a hack.** A partner is "test" or "live"; test traffic can never reach a live endpoint and vice versa.
6. **Start with the one document pair and one partner type that proves the loop** (see the recommendation at the top), keep the rest as a documented extension.

### 3.2 Records

```
TradingPartner (per organization)
  name, kind: supplier | customer, linked supplierId / customerId
  identifiers[]: { scheme, value }          // X12 ISA qualifier+id, GLN, DUNS, Peppol participant id, EDIFACT id
  channel: { transport, provider?, endpoint, credentialsRef }   // credentials never stored in the document: a secret reference
  documents[]: { type, standard, version, direction }          // e.g. order/X12/004010/out, order_response/X12/004010/in
  mode: "test" | "live"
  options: { ackRequired, retryPolicy, uomMap, shipToCodes, itemXref }   // see 3.4
  contact: who to tell when it fails
  enabled: boolean

B2BMessage (one per document sent or received)
  direction: out | in
  partnerId, docType, standard, version
  correlation: { poId?, poNumber, partnerPoNumber?, revision, controlNumbers[], providerMessageId? }
  canonical: the mapped JSON we hold (what we meant)
  raw: { body (immutable), hash, contentType }        // what actually went over the wire
  state: queued | sending | sent | delivered | acknowledged | accepted | rejected | failed | dead
  attempts[]: { at, result, httpStatus?, error? }
  acks[]: { level: transport | functional | business, at, result, detail }
  idempotencyKey, createdBy, createdAt

InboundDocument (when a partner sends us something that is not an answer: e.g. a customer's PO)
  stored as a B2BMessage; a separate step turns it into a draft in our own system (a sales order later), never straight into stock.
```

### 3.3 The pipeline

**Outbound PO.** A user places a PO (or it is placed by an approved rule) -> `PurchaseOrder` state ordered -> an *outbound intent* is created for the supplier's partner profile -> map PO to canonical order (resolve supplier part numbers, UoM codes, ship-to, dates) -> validate against the partner's document profile (required fields, code lists) -> render to the partner's standard (850, cXML OrderRequest, UBL Order) -> queue -> transport adapter sends -> record raw payload and transport result -> wait for acknowledgements.

**Acknowledgements, three levels, each a separate event on the message:**
- *Transport*: delivered (HTTP 2xx from the provider, AS2 MDN, SFTP put succeeded, Peppol transport receipt).
- *Functional*: the receiving system parsed it (X12 997/999, cXML status, Peppol Message Level Response). A rejection here means our document is malformed or not understood: we fix and resend, no human at the supplier is involved.
- *Business*: the supplier's decision (855 or Order Response: accepted, accepted with changes, rejected; per-line dates and quantities). Changes do **not** silently rewrite the PO: they become a **proposed change** that an authorised person approves (this reuses the approvals framework), then the PO is updated through the normal edit path and audited.

**Inbound documents** (855/Order Response, 856/Despatch Advice, 810/Invoice, 820/Remittance): receive through the partner's channel -> verify authenticity (signature, certificate or provider webhook secret) -> store raw -> parse to canonical -> match to our records (by PO number and partner id; unmatched goes to an "inbox needing attention") -> apply: an ASN becomes an *expected receipt* that pre-fills receiving (lot, quantities, pallet or roll labels as units), an invoice is matched against the PO and receipts (three-way match) and becomes a payable draft, a remittance marks payments received. None of these write stock by themselves: stock only moves through receiving.

### 3.4 Mapping details specific to us (gaps in today's model)

Today's PO line is `{ itemId, quantity, unitCostCents }` and a supplier has name and contact fields. An 850 or Order needs more. What would have to be added (all optional at first, filled from partner profile defaults):
- **Identifiers**: our supplier's EDI id or GLN or Peppol id (on the partner profile), our own id, and ship-to / bill-to locations with codes (GLN or the partner's own ship-to codes).
- **Item cross-reference**: the supplier's part number and, where used, GTIN per item and supplier (items only have SKU and barcodes today). Orders are mapped using the partner's number, not ours.
- **Units of measure**: map our UoM (now a real concept) to the standard's code list (X12 UOM codes, UN/ECE Rec 20) in the partner profile; refuse to send a line whose unit has no mapping.
- **Currency, payment terms and tax**: PO-level currency and terms; tax is needed for invoices and Peppol, so it should be modelled before invoices, not retrofitted.
- **Line numbers and revisions**: stable PO line numbers and a revision counter so a change (860 or Order Change) refers to the right line and can be replayed.
- **Dates**: per-line requested delivery date (today there is one expected date per PO).
- **Packaging-industry specifics** (corrugated and paper): roll and pallet attributes (width, diameter, grade, weight) are first-class in our units; they map to papiNet or to partner-specific fields, so the canonical order needs an `attributes` bag per line that adapters can render.

### 3.5 Acknowledgements, retries and failure handling

- **States are explicit and only move forward** (queued, sending, sent, delivered, acknowledged, accepted or rejected, failed, dead). A message in `failed` retries with exponential backoff (for example 1, 5, 30 minutes, 2 hours, 12 hours) up to a partner-set limit, then becomes `dead` and raises an alert (reuse the Alerts area: "PO-0042 could not be delivered to Acme Paper").
- **Idempotency**: our message id travels with the document (X12 control numbers, cXML payloadID, Peppol message id) and the provider call carries an idempotency key, so a retry after a timeout cannot create two orders. Inbound: dedupe by control number or provider message id; a duplicate is acknowledged but not applied twice.
- **No ack within a window** (partner-set, e.g. 24 hours for a 997, 2 business days for an 855): raise an alert, keep the PO as ordered, offer "resend" and "mark as confirmed by phone/email" (a manual business ack, audited).
- **Control numbers** for X12 (ISA13, GS06, ST02) are allocated atomically per partner (we already have an atomic counter helper) and never reused.
- **Everything is audited**: who enabled a partner, who changed a mapping, every send, every manual override.

### 3.6 Test and sandbox modes

- **Partner mode**: test partners use the test indicator where the standard has one (X12 ISA15 = T, a Peppol test network, a provider's sandbox keys) and can only be paired with a test endpoint. Going live is an explicit, audited switch that requires a successful test round trip.
- **Loopback partner** for demos and for our own tests: an in-process partner that accepts any valid order and answers with an acknowledgement after a delay, so the whole loop can be shown with fictional data and no outside account.
- **Fixtures and conformance tests**: for each mapping, golden files (canonical in, standard out, and back) with fictional companies, checked into the repo; a mapping change that alters a golden file must be deliberate.
- **Dry run**: "Preview what we would send" renders the document (and validation errors) without sending, for any PO and partner.
- **Provider sandboxes** (where available) are used for integration tests behind an opt-in switch, never in the default test run.

### 3.7 Security and operations

- Credentials, certificates and webhook secrets live in a secrets store or environment, referenced from the partner profile, never in the database in plain text and never in logs or audit entries.
- Inbound webhooks and endpoints verify signatures; outbound URLs supplied by users are checked against private-network ranges (the same SSRF rule as the planned webhooks).
- Per-organization isolation on every record; a partner belongs to exactly one organization; provider accounts are per organization or clearly shared with a stated tenancy model (open question, see below).
- Size and rate limits on inbound payloads, parse in a sandboxed library with entity expansion disabled for XML.
- Retention: raw payloads are kept (they are the legal record of what was exchanged); retention length is a setting, not a silent default.

### 3.8 Open questions for Andrew and the team

1. Who is the first partner, and what do they actually require (a specific standard, a portal, or just email with a PDF today)?
2. Will Invintel run the connection itself (AS2/SFTP, our certificates) or always go through a provider so we never operate EDI infrastructure for customers?
3. One provider account per customer organization, or a platform account we resell? This changes liability, cost and onboarding.
4. Sales side: do we also receive customers' POs (inbound 850) in this phase, or only send ours?
5. Where do invoices and payments sit relative to the accounting integration Gus is looking at (we should not build a ledger of money that duplicates the accounting system)?
