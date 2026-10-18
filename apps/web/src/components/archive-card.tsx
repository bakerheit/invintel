import { ARCHIVE_COLLECTIONS, type ArchiveRestoreResult } from "@invintel/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, FileJson, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm";
import { Button, buttonVariants } from "@/components/ui/button";
import { api } from "@/lib/api";
import { invalidateOrg } from "@/lib/org";
import { cn } from "@/lib/utils";

/**
 * Settings > Your data. Admins download a full archive (everything but the audit log and people).
 * The owner can restore one into an organization that has no data yet.
 */
export function ArchiveCard({ orgId, isOwner }: { orgId: string; isOwner: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; archive: unknown } | null>(null);
  const [check, setCheck] = useState<ArchiveRestoreResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const verify = useMutation({
    mutationFn: (archive: unknown) => api.restoreArchive(orgId, archive, true),
    onSuccess: setCheck,
    onError: (e: Error) => { setCheck(null); setError(e.message); },
  });
  const restore = useMutation({
    mutationFn: () => api.restoreArchive(orgId, file!.archive, false),
    onSuccess: async (r) => {
      await invalidateOrg(qc, orgId);
      toast.success(`Restored ${Object.values(r.counts).reduce((a, b) => a + b, 0).toLocaleString()} records from "${r.organizationName}"`);
      setFile(null);
      setCheck(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    setCheck(null);
    try {
      const archive = JSON.parse(await f.text());
      setFile({ name: f.name, archive });
      verify.mutate(archive);
    } catch {
      setFile(null);
      setError("That file isn't JSON. Choose an archive downloaded from Invintel.");
    }
  };

  const total = check ? Object.values(check.counts).reduce((a, b) => a + b, 0) : 0;
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <a href={`/api/orgs/${orgId}/data/archive.json`} className={cn(buttonVariants({ variant: "outline" }))} download>
          <Download /> Download full archive
        </a>
        <p className="text-sm text-muted-foreground">
          Items, locations, stock, rolls and pallets, the whole ledger, suppliers, purchase orders, recipes, work orders, counts, quality holds, downtime and your settings.
          The audit log, people and open approval requests are not included (the audit log has its own export).
        </p>
      </div>

      {isOwner && (
        <div className="space-y-3 border-t pt-5">
          <h3 className="text-sm font-medium">Restore from an archive</h3>
          <p className="text-sm text-muted-foreground">
            Works only in an organization with no data, such as a new one. Every record gets a new id, and nothing is changed until you confirm.
          </p>
          <input ref={input} type="file" accept=".json,application/json" className="sr-only" aria-label="Choose an archive file" onChange={(e) => void onFile(e.target.files?.[0])} />
          <Button type="button" variant="outline" onClick={() => input.current?.click()}>
            <FileJson /> {file ? file.name : "Choose an archive file"}
          </Button>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {check && (
            <div className="space-y-3 rounded-lg border p-3 text-sm">
              <p>
                From <strong>{check.organizationName}</strong>, {new Date(check.exportedAt).toLocaleDateString()}: <strong>{total.toLocaleString()}</strong> records.
              </p>
              <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                {Object.entries(check.counts).filter(([, n]) => n > 0).map(([k, n]) => (
                  <li key={k} className="flex justify-between"><span className="text-muted-foreground">{ARCHIVE_COLLECTIONS[k as keyof typeof ARCHIVE_COLLECTIONS] ?? k}</span><span className="tabular-nums">{n.toLocaleString()}</span></li>
                ))}
              </ul>
              {check.blocked ? (
                <p role="alert" className="text-destructive">{check.blocked}</p>
              ) : (
                <Button
                  disabled={restore.isPending}
                  onClick={async () => {
                    setError(null);
                    if (await confirm({ title: "Restore this archive?", description: `${total.toLocaleString()} records will be added to this organization. This organization has no data now, so there is nothing to overwrite.`, confirmLabel: "Restore" })) restore.mutate();
                  }}
                >
                  <Upload /> Restore into this organization
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
