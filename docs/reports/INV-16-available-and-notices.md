# INV-16: reorder on available, ship notices to email and X12 customers, change a confirmed order

Owner: Eli. Branch: `inv-16/available-and-notices` (on main with INV-15). Approved by Gus (scope and the decision to move reorder logic to available).

## What it does

1. **Reorder, low-stock, Overview, Alerts and Purchasing suggestions use available.** One rule, `stockStatusOf` / `suggestedOrderQty` / `stockWhy` in `packages/shared/src/sales.ts`, used by the API and the web:
   - **out**: nothing physically in stock. **low**: free stock (on hand - on quality hold - reserved) at or under the reorder level, or over-promised (even with no level set). Otherwise ok.
   - Suggestions: back to twice the level on *free* stock, less what is already on order (the same function makes the draft order, so the screen and the order agree); an over-promised item with no level is suggested for what covers the promise; most urgent first (most over-promised, then lowest relative to the level).
   - Alerts: out / low / over-promised (critical) / days of supply (now on free stock), each with the same explanation ("12 on hand, 8 promised, 4 free, reorder at 10."). Overview rows show "39 free of 114".
   - The item page has a line saying why: "124 on hand, 85 promised, 39 free, reorder at 50: what is free is at or under the reorder level." Quality hold counts against available too.
2. **Ship notices to email and X12 customers** (`sales-notices.ts`): by the customer's trading partner: Invintel (Exchange notice, unchanged), X12 (an 856 through the existing mapper and bridge: ISA/GS, control numbers, the customer's own PO number or ours, exactly what shipped), email (the email bridge now carries ship notices: plain email, lines, carrier, tracking, "(TEST)" for test partners), any other bridge that carries one (canonical JSON), otherwise nothing. The ship dialog says how the customer will be told. A notice never blocks or undoes a shipment; a failed one says why and can be sent again. The same shipment is never sent twice; a transient failure is retried as the same message; one retrying can't fix (wrong address, unmapped unit, too-long PO number) goes out as a new message under the next key once fixed.
3. **Change a confirmed order** ("Change lines"): cancel-and-rewrite in one click, only while nothing has shipped (a shipment undone in Activity counts as not shipped). A draft copy is written first, then the original is cancelled (stock released); if the original can't be cancelled in that moment (someone shipped), the copy is withdrawn so there aren't two. The copy opens in the new draft editor (the Sales screen can now edit drafts); confirming it reserves again and an approval rule applies again.

## How to try it

`pnpm --filter @invintel/api seed:demo`, sign in. **Sales > SO-0001 > Change lines** (confirm, edit the quantity to 75, save, open the copy, Confirm). **Inventory > RSC-1296**: the item turns Low with the reason. **Overview / Purchasing / Alerts** show the same numbers. **Sales > SO-0002 > Ship**: Bluebird Packaging is an email customer, so a ship notice is written to the outbox folder (`INVINTEL_OUTBOX_DIR`, default the temp folder).

## Decisions I made

- **"Out" stays physical.** An item that is fully promised is *low*, not *out*: there is still stock to ship, and calling it out would hide what to do (ship it, or order more).
- **Over-promised always counts**, even without a reorder level; a back-order is a decision someone should be reminded of.
- **Customer ship notices are chosen by what the partner can carry**, not by where the order came from, so a manual order for an X12 or email customer is told too. An Invintel customer is only told for an order that came from them (the notice answers their order).
- **A plain email, no PDF** (the packing slip as a PDF waits for the PDF templates work).
- **Rewrite is cancel + copy**, not editing in place: a promise the customer may have been told about shouldn't change silently. For an order that came from the Exchange the confirm says so (the customer was told yes to the original).

## Tests

`available.test.ts` (18): the shared rules (status, suggestion arithmetic, the explanation), low/out/over-promised through the Overview, Alerts, suggestions and the item list, quality hold, suggestions with stock on order and the draft order from them; ship notices: email (headers, body, no attachment, never twice, a notice channel shown on the order), a down mail server retried as the same message and sent once, a wrong address fixed and sent as a new message, X12 (envelope, ids, control numbers per notice, PRF/LIN/SN1/REF, read back through the reader), an X12 notice that can't be written (long PO number, unmapped unit) fixed and resent, other bridges, no one to tell, fractional quantities, a switched-off partner; rewrite: copy and cancel and release, edit-then-confirm, every refusal (draft, part shipped, closed, other org, member), a shipment undone, the approval rule again, and a shipment racing a rewrite (always exactly one live order). Whole API suite (408), web (20), typecheck and build green. Clicked through at desktop and 375 px: Change lines > edit > confirm; item page, Overview, Purchasing and Alerts; shipping to the email customer (the email is in the outbox).

## Known limits

- Rewrite is not offered once something has shipped; close the order and write a new one for the rest.
- Rewriting an order that came from the Exchange doesn't tell the customer (the confirm says to).
- While a rewritten order waits for approval its stock is not reserved.
- The ship notice has no PDF packing slip, and an email customer's notice only goes to the partner's `to` / `cc` addresses.
