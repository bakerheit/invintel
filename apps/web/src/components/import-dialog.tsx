import { IMPORT_FIELDS, IMPORT_FIELD_LABELS, type ImportBatch, type ImportField, type ImportMode, type ImportResult, type ImportRowStatus } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileSpreadsheet, Undo2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { invalidateOrg, orgKey } from "@/lib/org";
import { cn } from "@/lib/utils";

const STATUS: Record<ImportRowStatus, { label: string; className: string }> = {
  create: { label: "New", className: "bg-accent text-accent-foreground" },
  update: { label: "Update", className: "bg-success-soft text-success" },
  stock: { label: "Stock", className: "bg-accent text-accent-foreground" },
  skip: { label: "Skipped", className: "bg-secondary text-secondary-foreground" },
  error: { label: "Problem", className: "bg-destructive/15 text-destructive" },
};

const MODES: { value: ImportMode; label: string; hint: string }[] = [
  { value: "create", label: "Add new items", hint: "Items already here are left alone, so running the file twice is safe." },
  { value: "update", label: "Update existing items", hint: "Changes what the file fills in. Blank cells change nothing. Stock is never changed for existing items." },
  { value: "upsert", label: "Add and update", hint: "New SKUs are added, existing SKUs are updated." },
];

/** A spreadsheet cell: quoted if it needs to be. */
const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The rows that had problems, with the original cells and a "problem" column, ready to fix and upload again. */
export function problemRowsCsv(result: ImportResult): string {
  const rows = result.rows.filter((r) => r.status === "error" && r.cells);
  return [[...result.headers, "problem"], ...rows.map((r) => [...r.cells!, r.message])].map((line) => line.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Import wizard: pick a CSV, check which column is which, choose how to apply it, see exactly what would
 * happen, then import. Nothing is written until "Import", and an import can be undone from the history.
 */
export function ImportDialog({ orgId, open, onOpenChange }: { orgId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [mapping, setMapping] = useState<Partial<Record<ImportField, number>> | undefined>();
  const [mode, setMode] = useState<ImportMode>("create");
  const [onErrors, setOnErrors] = useState<"stop" | "skip">("stop");
  const [done, setDone] = useState<ImportResult | null>(null);

  const history = useQuery({ queryKey: orgKey(orgId, "imports"), queryFn: () => api.listImports(orgId), enabled: open });

  const reset = () => {
    setFile(null);
    setPreview(null);
    setMapping(undefined);
    setMode("create");
    setOnErrors("stop");
    setDone(null);
  };
  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const run = useMutation({
    mutationFn: (v: { text: string; dryRun: boolean; mapping?: Partial<Record<ImportField, number>>; mode: ImportMode; onErrors: "stop" | "skip"; filename: string }) =>
      api.importItems(orgId, { csv: v.text, dryRun: v.dryRun, mode: v.mode, onErrors: v.onErrors, filename: v.filename, ...(v.mapping ? { mapping: v.mapping } : {}) }),
    onSuccess: async (result, v) => {
      if (v.dryRun) {
        setPreview(result);
        setMapping((m) => m ?? result.mapping);
        return;
      }
      await invalidateOrg(qc, orgId);
      setDone(result);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const preflight = (over: Partial<{ mapping: Partial<Record<ImportField, number>>; mode: ImportMode; onErrors: "stop" | "skip" }> = {}) =>
    file && run.mutate({ text: file.text, dryRun: true, mapping: over.mapping ?? mapping, mode: over.mode ?? mode, onErrors: over.onErrors ?? onErrors, filename: file.name });

  const undo = useMutation({
    mutationFn: (id: string) => api.undoImport(orgId, id),
    onSuccess: async (r) => {
      await invalidateOrg(qc, orgId);
      toast.success(`Undid ${r.batch.number}: ${r.removed} removed, ${r.restored} restored`);
      setDone(null);
    },
    onError: (e: Error) => toast.error(e.message, { duration: 10000 }),
  });

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 1_900_000) return toast.error("That file is too big. Split it into smaller files.");
    const text = await f.text();
    setFile({ name: f.name, text });
    setPreview(null);
    setMapping(undefined);
    setDone(null);
    run.mutate({ text, dryRun: true, mode, onErrors, filename: f.name });
  };

  /** One column's field, from the field -> column mapping. */
  const fieldOf = (col: number): ImportField | "" => (IMPORT_FIELDS.find((f) => mapping?.[f] === col) ?? "");
  const assign = (col: number, field: ImportField | "") => {
    const next: Partial<Record<ImportField, number>> = { ...(mapping ?? {}) };
    for (const f of IMPORT_FIELDS) if (next[f] === col) delete next[f];
    if (field) next[field] = col; // a field can only come from one column, so this takes it from any other
    setMapping(next);
    preflight({ mapping: next });
  };

  const changed = (preview?.itemsToCreate ?? 0) + (preview?.itemsToUpdate ?? 0);
  const blocked = !!preview?.needs?.length;
  const canImport = !!file && !!preview && !blocked && changed > 0 && !run.isPending && (preview.errors === 0 || onErrors === "skip");

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import items from CSV</DialogTitle>
          <DialogDescription>
            Pick a file, check which column is which, and see what would happen before anything is written. Export your inventory to see the exact format.
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <ImportDone result={done} onUndo={() => done.batchId && undo.mutate(done.batchId)} undoing={undo.isPending} />
        ) : (
          <>
            <input ref={fileInput} type="file" accept=".csv,text/csv" className="sr-only" aria-label="Choose a CSV file" onChange={(e) => void onFile(e.target.files?.[0])} />
            <Button type="button" variant="outline" className="h-16 border-dashed" onClick={() => fileInput.current?.click()}>
              <FileSpreadsheet /> {file ? file.name : "Choose a CSV file"}
            </Button>

            {!file && <History batches={history.data} onUndo={(id) => undo.mutate(id)} undoing={undo.isPending} />}

            {preview && (
              <div className="max-h-[60vh] space-y-4 overflow-auto pr-1">
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">1. Which column is which?</h3>
                  <div className="overflow-auto rounded-lg border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted text-left text-xs text-muted-foreground">
                        <tr><th className="p-2">Column in your file</th><th className="p-2">Example</th><th className="p-2">Use it as</th></tr>
                      </thead>
                      <tbody className="divide-y">
                        {preview.headers.map((h, i) => (
                          <tr key={i}>
                            <td className="p-2 font-medium">{h || <span className="text-muted-foreground">(no heading)</span>}</td>
                            <td className="max-w-48 truncate p-2 text-muted-foreground">{preview.sample.map((r) => r[i]).find((v) => v) ?? ""}</td>
                            <td className="p-2">
                              <select
                                aria-label={`Use ${h || `column ${i + 1}`} as`}
                                value={fieldOf(i)}
                                onChange={(e) => assign(i, e.target.value as ImportField | "")}
                                className="h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm"
                              >
                                <option value="">Don't import</option>
                                {IMPORT_FIELDS.map((f) => <option key={f} value={f}>{IMPORT_FIELD_LABELS[f]}</option>)}
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {blocked && (
                    <p role="alert" className="text-sm text-destructive">
                      Choose which column holds the {preview.needs!.map((f) => IMPORT_FIELD_LABELS[f]).join(" and ")}.
                    </p>
                  )}
                </section>

                <section className="space-y-2">
                  <h3 className="text-sm font-medium">2. What should it do?</h3>
                  <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Import mode">
                    {MODES.map((m) => (
                      <label key={m.value} className={cn("cursor-pointer rounded-lg border p-3 text-sm", mode === m.value && "border-primary bg-accent/50 ring-1 ring-primary")}>
                        <input type="radio" name="import-mode" className="sr-only" checked={mode === m.value} onChange={() => { setMode(m.value); preflight({ mode: m.value }); }} />
                        <span className="block font-medium">{m.label}</span>
                        <span className="block text-xs text-muted-foreground">{m.hint}</span>
                      </label>
                    ))}
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox" className="size-4" checked={onErrors === "skip"}
                      onChange={(e) => { const v = e.target.checked ? "skip" : "stop"; setOnErrors(v); preflight({ onErrors: v }); }}
                    />
                    If some rows have problems, import the rest and skip them
                  </label>
                </section>

                {!blocked && (
                  <section className="space-y-2">
                    <h3 className="text-sm font-medium">3. What would happen</h3>
                    <p className="text-sm">
                      <strong>{preview.itemsToCreate}</strong> new {preview.itemsToCreate === 1 ? "item" : "items"}
                      {preview.itemsToCreate > 0 && <> with <strong>{preview.units.toLocaleString()}</strong> units across {preview.stockLines} stock {preview.stockLines === 1 ? "line" : "lines"}</>},{" "}
                      <strong>{preview.itemsToUpdate}</strong> to update
                      {preview.skipped ? <>, {preview.skipped} left as they are</> : null}
                      {preview.errors ? <>, <span className="font-semibold text-destructive">{preview.errors} {preview.errors === 1 ? "problem" : "problems"}</span></> : null}.
                    </p>
                    <div className="overflow-auto rounded-lg border">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground">
                          <tr><th className="p-2">Line</th><th className="p-2">SKU</th><th className="p-2">Result</th></tr>
                        </thead>
                        <tbody className="divide-y">
                          {preview.rows.map((r) => (
                            <tr key={r.line}>
                              <td className="p-2 tabular-nums text-muted-foreground">{r.line}</td>
                              <td className="p-2 font-mono text-xs">{r.sku || "-"}</td>
                              <td className="p-2">
                                <Badge variant="secondary" className={cn("mr-2", STATUS[r.status].className)}>{STATUS[r.status].label}</Badge>
                                <span className={r.status === "error" ? "text-destructive" : "text-muted-foreground"}>{r.message}</span>
                                {r.changes && (
                                  <ul className="mt-1 space-y-0.5 text-xs">
                                    {r.changes.map((c) => (
                                      <li key={c.field}><span className="text-muted-foreground">{c.field}:</span> {c.from} <span aria-hidden>→</span><span className="sr-only">to</span> <strong>{c.to}</strong></li>
                                    ))}
                                  </ul>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}
              </div>
            )}

            <DialogFooter className="sm:justify-between">
              <div>
                {preview && preview.errors > 0 && (
                  <Button variant="outline" onClick={() => download("rows-to-fix.csv", problemRowsCsv(preview))}>
                    <Download /> Download the {preview.errors} problem {preview.errors === 1 ? "row" : "rows"}
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => close(false)}>Cancel</Button>
                <Button disabled={!canImport} onClick={() => file && run.mutate({ text: file.text, dryRun: false, mapping, mode, onErrors, filename: file.name })}>
                  <Upload />{" "}
                  {preview && preview.errors && onErrors === "stop"
                    ? "Fix the problems first"
                    : `Import${changed ? ` ${changed} ${changed === 1 ? "item" : "items"}` : ""}${preview?.errors ? `, skip ${preview.errors}` : ""}`}
                </Button>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ImportDone({ result, onUndo, undoing }: { result: ImportResult; onUndo: () => void; undoing: boolean }) {
  const bad = result.rows.filter((r) => r.status === "error");
  return (
    <div className="space-y-3">
      <p role="status" className="rounded-lg bg-success-soft p-3 text-sm font-medium text-success">
        Imported: {result.itemsToCreate} new, {result.itemsToUpdate} updated{result.errors ? `, ${result.errors} skipped with problems` : ""}.
      </p>
      {bad.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-destructive">{bad.slice(0, 5).map((r) => `line ${r.line}: ${r.message}`).join("; ")}{bad.length > 5 ? `; and ${bad.length - 5} more` : ""}</p>
          <Button variant="outline" onClick={() => download("rows-to-fix.csv", problemRowsCsv(result))}><Download /> Download the problem rows</Button>
        </div>
      )}
      <p className="text-sm text-muted-foreground">Changed your mind? Undo works until stock has moved or something has been built on these items.</p>
      <div className="flex gap-2">
        {result.batchId && <Button variant="outline" disabled={undoing} onClick={onUndo}><Undo2 /> Undo this import</Button>}
      </div>
    </div>
  );
}

function History({ batches, onUndo, undoing }: { batches?: ImportBatch[]; onUndo: (id: string) => void; undoing: boolean }) {
  if (!batches?.length) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">Recent imports</h3>
      <ul className="divide-y rounded-lg border text-sm">
        {batches.slice(0, 5).map((b) => (
          <li key={b.id} className="flex items-center justify-between gap-3 p-2">
            <span className="min-w-0">
              <span className="font-medium">{b.number}</span>{" "}
              <span className="text-muted-foreground">{b.filename || "CSV"} · {b.created} new, {b.updated} updated · {b.userName}, {new Date(b.at).toLocaleString()}</span>
            </span>
            {b.undoneAt ? <Badge variant="secondary">Undone</Badge> : <Button size="sm" variant="ghost" disabled={undoing} onClick={() => onUndo(b.id)}><Undo2 /> Undo</Button>}
          </li>
        ))}
      </ul>
    </section>
  );
}
