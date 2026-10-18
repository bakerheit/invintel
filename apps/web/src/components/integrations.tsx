import { WEBHOOK_EVENTS, type ApiKey, type ApiKeyCreated, type ApiScope, type Webhook, type WebhookDelivery, type WebhookWithSecret } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Plus, Send, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { orgKey } from "@/lib/org";
import { cn } from "@/lib/utils";

const selectClass = "h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm";

/** A secret shown exactly once, with a copy button. */
function ShownOnce({ title, value, onDone }: { title: string; value: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      toast.error("Couldn't copy. Select the text and copy it by hand.");
    }
  };
  return (
    <div role="status" className="space-y-2 rounded-lg border border-warning/50 bg-warning-soft p-3 text-sm">
      <p className="font-medium">{title}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 select-all break-all rounded bg-background px-2 py-1.5 font-mono text-xs">{value}</code>
        <Button type="button" size="sm" variant="outline" onClick={() => void copy()}>{copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}</Button>
      </div>
      <p className="text-muted-foreground">Keep it somewhere safe. It is not stored in a form that can be shown again.</p>
      <Button type="button" size="sm" onClick={onDone}>I've saved it</Button>
    </div>
  );
}

const keyStatus = (k: ApiKey) => (k.revokedAt ? "Revoked" : k.expiresAt && new Date(k.expiresAt) <= new Date() ? "Expired" : "Active");

export function ApiKeysCard({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const key = orgKey(orgId, "api-keys");
  const keys = useQuery({ queryKey: key, queryFn: () => api.listApiKeys(orgId) });
  const [adding, setAdding] = useState(false);
  const [made, setMade] = useState<ApiKeyCreated | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (v: { name: string; scope: ApiScope; expiresInDays: number | null }) => api.createApiKey(orgId, v),
    onSuccess: async (k) => { setMade(k); setAdding(false); setError(null); await qc.invalidateQueries({ queryKey: key }); },
    onError: (e: Error) => setError(e.message),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeApiKey(orgId, id),
    onSuccess: async () => { toast.success("Key revoked. It stops working right now."); await qc.invalidateQueries({ queryKey: key }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const days = String(f.get("expires"));
    create.mutate({ name: String(f.get("name")), scope: String(f.get("scope")) as ApiScope, expiresInDays: days === "never" ? null : Number(days) });
  };

  return (
    <div className="space-y-4">
      {made && <ShownOnce title={`Your new key "${made.name}". Copy it now:`} value={made.key} onDone={() => setMade(null)} />}

      {adding ? (
        <form onSubmit={onSubmit} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[2fr_1.4fr_1fr_auto] sm:items-end">
          <div className="grid gap-1.5"><Label htmlFor="key-name">What is it for?</Label><Input id="key-name" name="name" placeholder="Shopify sync" required maxLength={80} autoFocus /></div>
          <div className="grid gap-1.5">
            <Label htmlFor="key-scope">Access</Label>
            <select id="key-scope" name="scope" defaultValue="read" className={selectClass}>
              <option value="read">Read only</option>
              <option value="write">Read and write stock</option>
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="key-expires">Expires</Label>
            <select id="key-expires" name="expires" defaultValue="never" className={selectClass}>
              <option value="never">Never</option><option value="30">In 30 days</option><option value="90">In 90 days</option><option value="365">In a year</option>
            </select>
          </div>
          <div className="flex gap-2"><Button type="submit" disabled={create.isPending}>Create key</Button><Button type="button" variant="ghost" onClick={() => { setAdding(false); setError(null); }}>Cancel</Button></div>
          {error && <p role="alert" className="text-sm text-destructive sm:col-span-4">{error}</p>}
        </form>
      ) : (
        <Button variant="outline" onClick={() => { setAdding(true); setMade(null); }}><Plus /> New API key</Button>
      )}

      <Card className="gap-0 py-0">
        <CardContent className="divide-y p-0">
          {keys.data?.length === 0 && <p className="p-4 text-sm text-muted-foreground">No keys yet.</p>}
          {keys.data?.map((k) => {
            const status = keyStatus(k);
            return (
              <div key={k.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {k.name}
                    <Badge variant="secondary">{k.scope === "write" ? "Read and write" : "Read only"}</Badge>
                    <Badge variant="secondary" className={cn(status === "Active" ? "bg-success-soft text-success" : "bg-destructive/10 text-destructive")}>{status}</Badge>
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">{k.prefix}</p>
                  <p className="text-xs text-muted-foreground">
                    Made by {k.createdBy}, {formatRelative(k.createdAt)} · {k.lastUsedAt ? `last used ${formatRelative(k.lastUsedAt)}` : "never used"}
                    {k.expiresAt && status === "Active" ? ` · expires ${new Date(k.expiresAt).toLocaleDateString()}` : ""}
                  </p>
                </div>
                {status === "Active" && (
                  <Button size="sm" variant="ghost" className="text-destructive" disabled={revoke.isPending}
                    onClick={async () => { if (await confirm({ title: `Revoke "${k.name}"?`, description: "Anything using this key stops working straight away. This can't be undone.", confirmLabel: "Revoke", destructive: true })) revoke.mutate(k.id); }}>
                    Revoke
                  </Button>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        Send it as <code className="font-mono">Authorization: Bearer ivk_…</code> to <code className="font-mono">/api/orgs/{orgId}/…</code>. Write keys act like a member, so approval rules still apply.
      </p>
    </div>
  );
}

const DELIVERY: Record<WebhookDelivery["status"], { label: string; className: string }> = {
  delivered: { label: "Delivered", className: "bg-success-soft text-success" },
  pending: { label: "Waiting", className: "bg-secondary text-secondary-foreground" },
  retrying: { label: "Will retry", className: "bg-warning-soft text-warning" },
  failed: { label: "Gave up", className: "bg-destructive/10 text-destructive" },
};

export function WebhooksCard({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const key = orgKey(orgId, "webhooks");
  const hooks = useQuery({ queryKey: key, queryFn: () => api.listWebhooks(orgId) });
  const [adding, setAdding] = useState(false);
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState<{ title: string; secret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const create = useMutation({
    mutationFn: (v: { url: string; description: string }) => api.createWebhook(orgId, { ...v, events: all ? ["*"] : ([...picked] as never) }),
    onSuccess: async (h: WebhookWithSecret) => { setShown({ title: "Signing secret for the new webhook. Copy it now:", secret: h.secret }); setAdding(false); setError(null); await refresh(); },
    onError: (e: Error) => setError(e.message),
  });
  const update = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => api.updateWebhook(orgId, v.id, { enabled: v.enabled }),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteWebhook(orgId, id),
    onSuccess: async () => { toast.success("Webhook removed"); await refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const test = useMutation({
    mutationFn: (id: string) => api.testWebhook(orgId, id),
    onSuccess: async (d) => {
      if (d.status === "delivered") toast.success(`The receiver answered ${d.responseStatus}. It works.`);
      else toast.error(d.error ?? "The test didn't get through", { duration: 8000 });
      await refresh();
      await qc.invalidateQueries({ queryKey: orgKey(orgId, "webhook-deliveries") });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const rotate = useMutation({
    mutationFn: (id: string) => api.rotateWebhookSecret(orgId, id),
    onSuccess: (h) => setShown({ title: "New signing secret. The old one has stopped working. Copy it now:", secret: h.secret }),
    onError: (e: Error) => toast.error(e.message),
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (!all && !picked.size) return setError("Pick at least one event");
    create.mutate({ url: String(f.get("url")), description: String(f.get("description") ?? "") });
  };

  return (
    <div className="space-y-4">
      {shown && <ShownOnce title={shown.title} value={shown.secret} onDone={() => setShown(null)} />}

      {adding ? (
        <form onSubmit={onSubmit} className="space-y-3 rounded-lg border p-3">
          <div className="grid gap-1.5"><Label htmlFor="hook-url">Send to</Label><Input id="hook-url" name="url" type="url" inputMode="url" placeholder="https://example.com/hooks/invintel" required autoFocus /></div>
          <div className="grid gap-1.5"><Label htmlFor="hook-desc">Note (optional)</Label><Input id="hook-desc" name="description" maxLength={200} placeholder="Our ERP" /></div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">What should it hear about?</legend>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={all} onChange={(e) => setAll(e.target.checked)} /> Everything below</label>
            {!all && (
              <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2" role="group" aria-label="Events">
                {WEBHOOK_EVENTS.map((ev) => (
                  <label key={ev} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="size-4" checked={picked.has(ev)} onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(ev); else n.delete(ev); return n; })} />
                    <code className="font-mono text-xs">{ev}</code>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2"><Button type="submit" disabled={create.isPending}>Add webhook</Button><Button type="button" variant="ghost" onClick={() => { setAdding(false); setError(null); }}>Cancel</Button></div>
        </form>
      ) : (
        <Button variant="outline" onClick={() => { setAdding(true); setShown(null); }}><Plus /> Add a webhook</Button>
      )}

      <Card className="gap-0 py-0">
        <CardContent className="divide-y p-0">
          {hooks.data?.length === 0 && <p className="p-4 text-sm text-muted-foreground">No webhooks yet.</p>}
          {hooks.data?.map((h) => <HookRow key={h.id} hook={h} orgId={orgId} open={open === h.id} onOpen={() => setOpen(open === h.id ? null : h.id)}
            onToggle={() => update.mutate({ id: h.id, enabled: !h.enabled })}
            onTest={() => test.mutate(h.id)} testing={test.isPending && test.variables === h.id}
            onRotate={async () => { if (await confirm({ title: "Change the signing secret?", description: "The old secret stops working at once, so update the receiver straight after.", confirmLabel: "Change it" })) rotate.mutate(h.id); }}
            onRemove={async () => { if (await confirm({ title: "Remove this webhook?", description: "Nothing more is sent, and its delivery log is cleared.", confirmLabel: "Remove", destructive: true })) remove.mutate(h.id); }} />)}
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        Only https addresses on the public internet are allowed. Failed deliveries are retried for about nine hours; after {10} give up in a row the webhook switches itself off.
      </p>
    </div>
  );
}

function HookRow({ hook, orgId, open, onOpen, onToggle, onTest, testing, onRotate, onRemove }: {
  hook: Webhook; orgId: string; open: boolean; onOpen: () => void; onToggle: () => void; onTest: () => void; testing: boolean; onRotate: () => void; onRemove: () => void;
}) {
  const qc = useQueryClient();
  const deliveries = useQuery({ queryKey: orgKey(orgId, "webhook-deliveries", hook.id), queryFn: () => api.webhookDeliveries(orgId, hook.id), enabled: open });
  const retry = useMutation({
    mutationFn: (id: string) => api.retryDelivery(orgId, hook.id, id),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: orgKey(orgId, "webhook-deliveries", hook.id) }); await qc.invalidateQueries({ queryKey: orgKey(orgId, "webhooks") }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const last = hook.lastDelivery;
  return (
    <div className="space-y-2 p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            <span className="break-all">{new URL(hook.url).host}<span className="text-muted-foreground">{new URL(hook.url).pathname}</span></span>
            <Badge variant="secondary" className={cn(hook.enabled ? "bg-success-soft text-success" : "bg-warning-soft text-warning")}>{hook.enabled ? "On" : "Off"}</Badge>
            {last && <Badge variant="secondary" className={DELIVERY[last.status].className}>Last: {DELIVERY[last.status].label.toLowerCase()}</Badge>}
          </p>
          <p className="text-xs text-muted-foreground">
            {hook.events.includes("*") ? "Everything" : hook.events.join(", ")}{hook.description ? ` · ${hook.description}` : ""}
          </p>
          {hook.disabledReason && <p className="text-xs text-warning">{hook.disabledReason}. Fix the receiver, send a test, then switch it on.</p>}
        </div>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="outline" onClick={onTest} disabled={testing}><Send /> {testing ? "Sending…" : "Send test"}</Button>
          <Button size="sm" variant="ghost" onClick={onOpen} aria-expanded={open}>{open ? "Hide log" : "Log"}</Button>
          <Button size="sm" variant="ghost" onClick={onToggle}>{hook.enabled ? "Switch off" : "Switch on"}</Button>
          <Button size="sm" variant="ghost" onClick={onRotate}>New secret</Button>
          <Button size="sm" variant="ghost" className="text-destructive" aria-label="Remove webhook" onClick={onRemove}><Trash2 /></Button>
        </div>
      </div>
      {open && (
        <div className="rounded-lg border">
          {deliveries.data?.length === 0 && <p className="p-3 text-muted-foreground">Nothing sent yet. Send a test.</p>}
          <ul className="divide-y">
            {deliveries.data?.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 p-2">
                <span className="min-w-0">
                  <Badge variant="secondary" className={cn("mr-2", DELIVERY[d.status].className)}>{DELIVERY[d.status].label}</Badge>
                  <code className="font-mono text-xs">{d.type}</code>
                  <span className="text-xs text-muted-foreground"> · {formatRelative(d.createdAt)} · {d.attempts} {d.attempts === 1 ? "try" : "tries"}{d.responseStatus ? ` · answered ${d.responseStatus}` : ""}</span>
                  {d.error && d.status !== "delivered" && <span className="block text-xs text-destructive">{d.error}</span>}
                </span>
                {d.status === "failed" && <Button size="sm" variant="ghost" disabled={retry.isPending} onClick={() => retry.mutate(d.id)}>Try again</Button>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
