# INV-4: Import v2 and full-data export

Owner: Will. Branch: `inv-4/import-export-archive` (stacked on `inv-5/units-of-measure`, with main merged in). Ticket: INV-4 on the Invintel board.

## What it does

**Bring it in.** The CSV import is now a wizard: map columns (auto-matched, fix by hand), choose *add*, *update* or *add and update*, see every row's outcome with field-by-field diffs, optionally skip problem rows and download them to fix, import, and **undo** the import later from the history.

**Take it out.** *Settings > Your data* downloads one JSON archive of everything the organization has, and the owner can restore it into an empty organization with every record re-created and every link rewritten.

## How to try it

1. Inventory > Import, choose a CSV whose headers aren't ours (`Part No, Product, Group, Price, Min, On shelf, Bin`). The wizard maps what it can and says "Choose which column holds the Name". Map *Product* to Name and *On shelf* to Quantity.
2. Pick *Add and update*, tick "skip problem rows". The preview shows `unit cost: $0.15 → $0.18`, a new item, and a problem row ("Unit cost "abc" isn't a number") you can download. Import, then **Undo this import**: the new item is gone and the edited ones are back as they were.
3. Settings > Your data > Download full archive. Create a second organization, open its Settings, choose the file, check the counts, Restore. Inventory matches the original.

## How it works

- `apps/api/src/item-import.ts`: `planImport` reads the file and works out creates, updates and problems without writing; `autoMap` guesses columns from headers; an explicit `mapping` (field to column) overrides it. Update mode compares only mapped, non-blank fields, and refuses unit or decimal changes. Barcode clashes are checked against the database and within the file. Applying inserts/updates with an optimistic check (an update is skipped if the item changed since the preview), records an `IMP-n` batch (what was created with its ledger lines, and each update's before and after) and audits it. Undo checks everything first and then acts: created items go through the same `deleteItem` path as the delete button (stock written off through the ledger), updated items get their old values back.
- `apps/api/src/archive.ts`: ids become `{ $oid }`, dates `{ $date }`. Restore validates the whole file, builds a map from old ids to new ones (unknown ids get throwaway ids), checks required fields and types per collection, inserts in chunks, advances the numbering counters, and on any database error deletes what it wrote and puts back the locations it removed.
- Web: `components/import-dialog.tsx` (wizard), `components/archive-card.tsx`, `lib/import-csv.ts` (problem-rows CSV).

## Decisions

- **Import never changes stock of an item that already exists.** Setting stock by file is a count, and counts have their own screen with approvals and variance. Updates cover descriptive fields, reorder level, cost and barcodes only.
- **Blank cell means "no change"**, never "clear it". There is no way to blank a field by import; that is deliberate, because spreadsheets are full of accidental blanks.
- **One bad row blocks everything by default**, with an explicit tick to skip them. The skipped rows come back with their original cells so they can be fixed and re-uploaded.
- **Undo is all or nothing and only while nothing has built on the import.** It refuses and says which items, rather than half-undoing.
- **The archive is a generic, tagged JSON dump**, not a hand-written schema per collection, so new collections only need to be listed. The cost is that validation is by field presence and type, not full schemas.
- **Restore only into an empty organization.** Merging two organizations' data is a different, much harder feature. Restoring into a new organization covers backup and move.
- **Not included in the archive:** the audit log (own hash chain and export), people and sessions, open approval requests and alert acknowledgements (they refer to ids as text).

## Tests

`apps/api/src/import-v2.test.ts` (17 tests): headers/mapping/sample in the preview; custom mapping; only mapped fields read; bad mappings refused (duplicate column, out of range, unknown field, missing SKU or name reported as `needs`, refused on apply); update diffs and blank cells; case-insensitive SKUs; stock of existing items untouched; update vs upsert vs unknown SKU; update with no name column; unit/decimals changes refused and reorder level read in the item's unit; barcode clashes with the database and within the file; stop vs skip on errors and a failed SKU's later lines; batch recorded, audited, listed; preview and no-op imports leave no batch; undo of create+update (ledger write-off visible, chain verifies, second undo refused); undo refused after stock moved, after an order, after a further edit (and nothing changes); admin-only and organization-scoped. `apps/api/src/archive.test.ts` (8 tests): full round trip into an empty organization comparing items, units, places by path, stock by place, ledger (counts, totals, transfer pairs, reversal link, no reused ids), rolls, orders, counts, work orders, settings, numbering continuing (PO-0002, U-000003) and the audit chain; archive of an archive is the same data; refused when the target has data, owner-only restore, admin-only download, other organizations get 404; refused files (not an archive, version, unknown collections, unknown settings, operator and odd field names, bad dates and ids, missing or wrong-typed fields, repeated ids); an archive pointing at another organization's record gets a throwaway id and the other organization is untouched; a database failure mid-restore leaves nothing and can be retried. Web: `lib/import-csv.test.ts`. Full API suite 253, web 20, typecheck and build clean.

Browser: the wizard on a messy supplier file at desktop and phone width (mapping, mode, skip, diffs, import, undo, history), Settings > Your data restore into a second organization (inventory and value matched).

## Known limits

- Only items are imported (not locations, suppliers or orders). Locations are matched by code, path or name and must exist.
- No import of stock changes for existing items (see decisions) and no way to clear a field.
- Restore is one request, so very large archives (hundreds of thousands of ledger lines) take a while and are limited to about 96 MB in the browser. The file is not streamed.
- The archive can't be merged into an organization that already has data.
- Undo of an update compares the fields it changed; it doesn't notice a change to an unrelated field, which stays.
- Not run against a real spreadsheet export from Excel with an odd encoding; the parser handles quotes, CRLF and a BOM.
