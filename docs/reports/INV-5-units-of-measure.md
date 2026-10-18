# INV-5: Units of measure and fractional quantities

Owner: Will. Branch: `inv-5/units-of-measure`. Ticket: INV-5 on the Invintel board.

## What it does

Items can be counted in kilograms, metres, litres or anything else, to 0 to 4 decimal places, and can have other units they are bought or counted in (`1 bag = 25 kg`). Floor receive, move, use-some-of-a-roll, count, and the desk item form, adjust, transfer, counts, purchasing and CSV import/export all read and write quantities in the item's own unit. Stock stays exact: nothing is ever stored as a fraction.

## How to try it

1. Inventory > New item. In **Unit of measure** pick *Kilograms* (3 decimal places) and add a unit `bag = 25`. Set reorder level `50.5` and starting quantity `1,250.25`. The table shows `1,250.250 kg`, cost per kg, value to the cent.
2. Floor mode > Receive, scan or type the SKU. The stepper moves by 1 kg. Type `2.5555`: "kg goes to 3 decimal places" and Next is disabled. Pick **bag**, type `2`: it shows `= 50.000 kg`.
3. Inventory > Export, edit a quantity, Import it as a new SKU with `unit` and `decimals` columns.
4. Try to change the decimals of that item once it has stock: refused with an explanation.

## How it works

- **Contract** (`packages/shared/src/units.ts`): stored quantities are whole numbers (counts of the smallest unit); an item has `unit`, `decimals` (0 to 4) and `altUnits` (`[{ name, factor }]`). `formatQty`, `parseQty`, `toStored`, `convertQty`, `lineValueCents`, `uomOf`, `qtyErrorMessage`. All exact: digit-by-digit text handling and BigInt arithmetic, no floats. `parseQty` never rounds. Document-line caps rose from 1,000,000 to 10^12 (`MAX_QTY`) so a 25,000 kg delivery at 3 decimals fits.
- **API:** item create/update accept `unit`, `decimals`, `altUnits`; old items read as `ea` / 0. Rolls (`StockUnit`), ledger entries (`ActivityEntry`), count lines, purchase order lines and suggestions, aging rows and the overview's attention list now carry `uom` so a screen can print them. Value calculations go through `lineValueCents`. Aggregate "units" totals (overview, location totals, import preview, net count change) are in display units.
- **Web:** `useQtyEntry` (state for one quantity box, parses against the item's current unit each render) and `QtyInput` (box + optional unit picker + "= 50.000 kg" preview + error text). `QtyStepper` on the floor uses it and reports 0 for anything that isn't a valid positive quantity so pages disable their button instead of posting a stale number.
- **Audit:** unit, decimals and other units appear in item created/updated events ("changed unit of measure from ea to kg").

## Decisions

- **Whole numbers stay on the wire.** Gus's contract: no migration, no fractions in the API, the ledger and hash chain stay exact. Conversion happens only at the edges.
- **Unit cost is per display unit** (per kg, not per gram), because that is how people quote prices. The cost is still whole cents per display unit, so a price like $0.0035/m can't be expressed yet.
- **Decimals lock instead of migrating.** Moving the point would rescale every quantity the item ever had across stock, ledger, units, orders and counts. The lock is checked on the server against everything that refers to the item.
- **Never round what a person typed.** `1.2345` for a 3-decimal item is refused. The same rule applies to unit conversions and to CSV import.
- **Zero, blank or invalid on the floor means "nothing yet"**, shown with a message, and the next button is disabled.

## Tests

`apps/api/src/uom.test.ts` (32 tests): formatter (whole items unchanged, point placement, trim/sign/unit options, bad input), parser (typed forms, thousands separators, trailing zeros, refuses rounding / junk / negatives unless signed / over-range), conversion (exact, refuses non-whole results, bad factors), `lineValueCents` (rounding, negatives, exact at large values), schema (defaults, bad units and factors, duplicate unit names), and through the API: old items default to ea/0, a kg item posts and sums exactly and refuses fractions on the wire, overview value uses display units, decimals change before history and are refused after (including with only a purchase order), PO totals, audit summary and chain verification, CSV round trip (unit and decimals columns, exported `1250.750`), CSV refuses too many decimals and bad unit/decimals columns, preview totals. `apps/web/src/lib/qty.test.ts` (6 tests): entry in own unit, bag conversion, fall back when the chosen unit disappears, refusals, whole-number items. Full API suite 196 and web 18 green, typecheck and build clean.

Browser (desktop 1280 and phone 390 wide): inventory table (125.500 kg, 150.50 m, 40, cost per unit, value), new item form with unit presets and error text, Floor receive with bag conversion, bad-input blocking, post 2.555 kg (stored 128055) and the receipt screen; a purchase order for 25.500 kg ($30.60) opened, received 10.5 kg (stored 10500, order went to partial); desk counts and the new-PO dialog were type-checked and covered by the API tests but not clicked through. 

## Known limits

- **Production is not converted.** BOMs, work orders, floor production and the production reports still treat quantities as plain numbers (they already used floats with rounding to 2 places, which doesn't fit this contract). Using a decimal item in production works at the API level (whole numbers of the smallest unit) but the production screens show stored counts, not display units. Needs a pass with Eli, who owns production and posting.
- **Roll and pallet screens** (units) show quantities correctly; labels pages show them via `formatQty`.
- Cost precision is whole cents per display unit.
- Totals across items mix units (they add display units).
- The server doesn't convert alternate units; the box does. API clients send the stored whole number.
- Decimals can't be changed on an item with history.
- Not run against a real browser camera or printer.
