import type { ImportResult, ImportRowStatus } from "@invintel/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileSpreadsheet, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { invalidateOrg } from "@/lib/org";
import { cn } from "@/lib/utils";

const STATUS: Record<ImportRowStatus, { label: string; className: string }> = {
  create: { label: "New", className: "bg-accent text-accent-foreground" },
  stock: { label: "Stock", className: "bg-accent text-accent-foreground" },
  skip: { label: "Skipped", className: "bg-secondary text-secondary-foreground" },
  error: { label: "Error", className: "bg-destructive/15 text-destructive" },
};

/** Pick a CSV, see exactly what would happen, then import. Nothing is written until "Import". */
export function ImportDialog({ orgId, open, onOpenChange }: { orgId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);

  const close = (next: boolean) => {
    if (!next) {
      setFile(null);
      setPreview(null);
    }
    onOpenChange(next);
  };
  const run = useMutation({
    mutationFn: ({ text, dryRun }: { text: string; dryRun: boolean }) => api.importItems(orgId, { csv: text, dryRun }),
    onSuccess: async (result, { dryRun }) => {
      if (dryRun) return setPreview(result);
      await invalidateOrg(qc, orgId);
      if (result.errors > 0) {
        const bad = result.rows.filter((r) => r.status === "error").slice(0, 3).map((r) => `line ${r.line}: ${r.message}`).join("; ");
        toast.warning(`Imported ${result.itemsToCreate}, but ${result.errors} ${result.errors === 1 ? "row" : "rows"} had trouble (${bad}). Running the file again is safe.`);
      } else toast.success(`Imported ${result.itemsToCreate} ${result.itemsToCreate === 1 ? "item" : "items"}`);
      close(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 1_900_000) return toast.error("That file is too big. Split it into smaller files.");
    const text = await f.text();
    setFile({ name: f.name, text });
    setPreview(null);
    run.mutate({ text, dryRun: true });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import items from CSV</DialogTitle>
          <DialogDescription>
            Needs a SKU and a name column. Optional: category, notes, reorder level, unit cost, barcodes (separate with |), location (code or full path) and quantity.
            Items that already exist are left alone, so it's safe to run twice. Export your inventory to see the exact format.
          </DialogDescription>
        </DialogHeader>

        <input ref={fileInput} type="file" accept=".csv,text/csv" className="sr-only" aria-label="Choose a CSV file" onChange={(e) => void onFile(e.target.files?.[0])} />
        <Button type="button" variant="outline" className="h-20 border-dashed" onClick={() => fileInput.current?.click()}>
          <FileSpreadsheet /> {file ? file.name : "Choose a CSV file"}
        </Button>

        {preview && (
          <div className="space-y-3">
            <p className="text-sm">
              <strong>{preview.itemsToCreate}</strong> new {preview.itemsToCreate === 1 ? "item" : "items"},{" "}
              <strong>{preview.units.toLocaleString()}</strong> units across {preview.stockLines} stock {preview.stockLines === 1 ? "line" : "lines"}
              {preview.skipped ? <>, {preview.skipped} already here</> : null}
              {preview.errors ? <>, <span className="font-semibold text-destructive">{preview.errors} {preview.errors === 1 ? "problem" : "problems"}</span></> : null}.
            </p>
            <div className="max-h-64 overflow-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground">
                  <tr><th className="p-2">Line</th><th className="p-2">SKU</th><th className="p-2">Result</th></tr>
                </thead>
                <tbody className="divide-y">
                  {preview.rows.map((r) => (
                    <tr key={r.line}>
                      <td className="p-2 tabular-nums text-muted-foreground">{r.line}</td>
                      <td className="p-2 font-mono text-xs">{r.sku || "—"}</td>
                      <td className="p-2">
                        <Badge variant="secondary" className={cn("mr-2", STATUS[r.status].className)}>{STATUS[r.status].label}</Badge>
                        <span className={r.status === "error" ? "text-destructive" : "text-muted-foreground"}>{r.message}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>Cancel</Button>
          <Button
            disabled={!file || !preview || preview.errors > 0 || preview.itemsToCreate === 0 || run.isPending}
            onClick={() => file && run.mutate({ text: file.text, dryRun: false })}
          >
            <Upload /> {preview && preview.errors ? "Fix the problems first" : `Import ${preview?.itemsToCreate ?? ""} ${preview?.itemsToCreate === 1 ? "item" : "items"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
