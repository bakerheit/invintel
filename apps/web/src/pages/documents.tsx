import { ACCENTS, DEFAULT_TITLES, DOC_LABELS, B2B_DOC_LABELS, type B2BMessage, type CapturedInvoice, type TradingPartner } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Handshake, Inbox, Mail, Plus, Upload } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { formatCents, formatDateTime } from "@/lib/format";
import { invalidateOrg, isAdmin, orgKey, useCurrentOrg } from "@/lib/org";
import { cn } from "@/lib/utils";

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");

function Field({ label, children, className, hint }: { label: string; children: ReactNode; className?: string; hint?: string }) {
  return (
    <label className={cn("grid gap-1 text-sm", className)}>
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

const STATE_STYLE: Record<string, string> = {
  queued: "bg-secondary text-secondary-foreground",
  sent: "bg-accent text-accent-foreground",
  delivered: "bg-accent text-accent-foreground",
  acknowledged: "bg-success-soft text-success",
  rejected: "bg-destructive/10 text-destructive dark:bg-destructive/20",
  failed: "bg-warning-soft text-warning",
  received: "bg-secondary text-secondary-foreground",
};
const SCENARIOS: [string, string][] = [
  ["acknowledge", "Receipt and accept the order"], ["change", "Receipt and accept with changes"], ["reject", "Receipt and reject the order"],
  ["syntax_error", "Refuse the document (malformed)"], ["ship", "Send a ship notice (856)"], ["invoice", "Send an invoice (810)"],
];

const StateBadge = ({ state }: { state: string }) => <Badge variant="secondary" className={cn("capitalize", STATE_STYLE[state])}>{state}</Badge>;

// ---------- partners ----------

function PartnerForm({ orgId, partner, onDone }: { orgId: string; partner?: TradingPartner; onDone: () => void }) {
  const qc = useQueryClient();
  const bridges = useQuery({ queryKey: orgKey(orgId, "b2b", "bridges"), queryFn: () => api.b2bBridges(orgId) });
  const suppliers = useQuery({ queryKey: orgKey(orgId, "suppliers"), queryFn: () => api.listSuppliers(orgId) });
  const [name, setName] = useState(partner?.name ?? "");
  const [kind, setKind] = useState<"supplier" | "customer">(partner?.kind ?? "supplier");
  const [bridge, setBridge] = useState(partner?.bridge ?? "email");
  const [supplierId, setSupplierId] = useState(partner?.supplierId ?? "");
  const [to, setTo] = useState(partner?.bridgeConfig.to ?? "");
  const [cc, setCc] = useState(partner?.bridgeConfig.cc ?? "");
  const [secretEnv, setSecretEnv] = useState(partner?.bridgeConfig.secretEnv ?? "");
  const [mode, setMode] = useState<"test" | "live">(partner?.mode ?? "test");
  const c = partner?.bridgeConfig ?? {};
  const [ourQual, setOurQual] = useState(c.ourQual ?? "ZZ");
  const [ourId, setOurId] = useState(c.ourId ?? "");
  const [theirQual, setTheirQual] = useState(c.theirQual ?? "ZZ");
  const [theirId, setTheirId] = useState(c.theirId ?? "");
  const [version, setVersion] = useState(c.version ?? "004010");
  const [transport, setTransport] = useState(c.transport ?? "loopback");
  const [uomMap, setUomMap] = useState(c.uomMap ?? "");
  const [ack997, setAck997] = useState(c.ack997 !== "off");
  const [docTemplates, setDocTemplates] = useState<NonNullable<TradingPartner["docTemplates"]>>(partner?.docTemplates ?? {});
  const save = useMutation({
    mutationFn: () => {
      const bridgeConfig: Record<string, string> =
        bridge === "email" ? { to, ...(cc ? { cc } : {}) }
        : bridge === "invoice-inbox" ? { secretEnv }
        : bridge === "x12" ? { ourQual, ourId, theirQual, theirId, version, ...(transport ? { transport } : {}), ...(secretEnv ? { secretEnv } : {}), ...(uomMap.trim() ? { uomMap: uomMap.trim() } : {}), ...(ack997 ? {} : { ack997: "off" }) }
        : {};
      const input = { name, kind, bridge, bridgeConfig, mode, supplierId: supplierId || null, docTemplates };
      return partner ? api.updateB2bPartner(orgId, partner.id, input) : api.createB2bPartner(orgId, input);
    },
    onSuccess: () => { toast.success(partner ? "Partner saved" : "Partner added"); void invalidateOrg(qc, orgId); onDone(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <form className="grid gap-3 rounded-lg border p-4 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} /></Field>
      <Field label="They are a">
        <select className={selectClass} value={kind} onChange={(e) => setKind(e.target.value as "supplier" | "customer")}>
          <option value="supplier">Supplier (we send them orders)</option>
          <option value="customer">Customer</option>
        </select>
      </Field>
      <Field label="Supplier record" hint="Links orders for this supplier to this partner.">
        <select className={selectClass} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="">None</option>
          {suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      <Field label="How documents travel">
        <select className={selectClass} value={bridge} onChange={(e) => setBridge(e.target.value)}>
          {bridges.data?.map((b) => <option key={b.id} value={b.id}>{b.id === "email" ? "Email (PDF and a confirmation link)" : b.id === "invoice-inbox" ? "Invoice inbox (receives invoices)" : b.id === "loopback" ? "Loopback (testing, nothing leaves)" : b.id === "x12" ? "X12 EDI (850, 855, 856, 810, 997)" : b.id}</option>)}
        </select>
      </Field>
      {bridge === "email" && (
        <>
          <Field label="Send orders to" hint="One or more addresses, comma separated."><Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="orders@supplier.example" /></Field>
          <Field label="Copy to (optional)"><Input value={cc} onChange={(e) => setCc(e.target.value)} /></Field>
        </>
      )}
      {bridge === "invoice-inbox" && (
        <Field label="Secret variable name" hint="The name of the server setting that holds the shared secret (never the secret itself)." className="sm:col-span-2"><Input value={secretEnv} onChange={(e) => setSecretEnv(e.target.value)} placeholder="ACME_INBOX_SECRET" /></Field>
      )}
      {bridge === "x12" && (
        <>
          <Field label="Our id (qualifier + id)" hint="How the partner knows us, e.g. ZZ and NWCORR.">
            <span className="flex gap-1"><Input className="w-16" value={ourQual} onChange={(e) => setOurQual(e.target.value)} maxLength={2} aria-label="Our qualifier" /><Input value={ourId} onChange={(e) => setOurId(e.target.value)} maxLength={15} aria-label="Our id" /></span>
          </Field>
          <Field label="Their id (qualifier + id)" hint="How we know them, e.g. ZZ and SUNRISEPM.">
            <span className="flex gap-1"><Input className="w-16" value={theirQual} onChange={(e) => setTheirQual(e.target.value)} maxLength={2} aria-label="Their qualifier" /><Input value={theirId} onChange={(e) => setTheirId(e.target.value)} maxLength={15} aria-label="Their id" /></span>
          </Field>
          <Field label="X12 version">
            <select className={selectClass} value={version} onChange={(e) => setVersion(e.target.value)}><option value="004010">004010</option><option value="005010">005010</option></select>
          </Field>
          <Field label="Transport" hint="There is no network transport yet; the built-in test partner answers for you.">
            <select className={selectClass} value={transport} onChange={(e) => setTransport(e.target.value)}><option value="loopback">Test partner (nothing leaves)</option><option value="">None set up yet</option></select>
          </Field>
          <Field label="Secret variable name (optional)" hint="Needed for the partner to post documents to us. The name of the server setting, never the secret."><Input value={secretEnv} onChange={(e) => setSecretEnv(e.target.value)} placeholder="SUNRISE_X12_SECRET" /></Field>
          <Field label="Extra unit codes (optional)" hint='JSON, e.g. {"sheet":"SH"}. Orders with a unit that has no code are not sent.'><Input value={uomMap} onChange={(e) => setUomMap(e.target.value)} placeholder='{"sheet":"SH"}' /></Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-3"><input type="checkbox" checked={ack997} onChange={(e) => setAck997(e.target.checked)} /> Send a receipt (997) for every document they send us</label>
        </>
      )}
      <details className="rounded-md border p-3 sm:col-span-3">
        <summary className="cursor-pointer text-sm font-medium">Document look for {name.trim() || "this partner"} <span className="font-normal text-muted-foreground">(optional: their own title, colour and terms)</span></summary>
        <div className="mt-3 space-y-4">
          {(kind === "customer" ? (["sales_order", "packing_slip", "invoice"] as const) : (["purchase_order"] as const)).map((k) => {
            const o = docTemplates[k] ?? {};
            const set = (patch: Partial<typeof o>) => {
              const next: Record<string, unknown> = { ...o, ...patch };
              for (const key of Object.keys(next)) if (next[key] === undefined || next[key] === "") delete next[key];
              setDocTemplates((d) => { const n = { ...d, [k]: next }; if (!Object.keys(next).length) delete n[k]; return n; });
            };
            return (
              <div key={k} className="grid gap-2 sm:grid-cols-2">
                <p className="text-sm font-medium sm:col-span-2">{DOC_LABELS[k]}</p>
                <Field label="Title" hint={`Empty: the organization's (${DEFAULT_TITLES[k]} unless changed in Settings > Documents).`}><Input value={o.title ?? ""} maxLength={40} onChange={(e) => set({ title: e.target.value })} /></Field>
                <Field label="Colour">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <button type="button" onClick={() => set({ accent: undefined })} className={cn("h-7 rounded-full border px-2 text-xs", !o.accent ? "border-foreground" : "text-muted-foreground")}>Same as ours</button>
                    {ACCENTS.map((a) => <button key={a.hex} type="button" aria-label={a.name} title={a.name} onClick={() => set({ accent: a.hex })} className={cn("size-6 rounded-full border-2", o.accent?.toLowerCase() === a.hex ? "border-foreground" : "border-transparent")} style={{ background: a.hex }} />)}
                  </span>
                </Field>
                <Field label="Terms for them" hint="Replaces the organization's terms on their documents." className="sm:col-span-2"><textarea rows={2} maxLength={800} className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={o.terms ?? ""} onChange={(e) => set({ terms: e.target.value })} /></Field>
              </div>
            );
          })}
        </div>
      </details>
      <Field label="Mode" hint="Test partners are marked TEST in what they receive. Switch to live when you are ready.">
        <select className={selectClass} value={mode} onChange={(e) => setMode(e.target.value as "test" | "live")}>
          <option value="test">Test</option>
          <option value="live">Live</option>
        </select>
      </Field>
      <div className="flex items-end gap-2 sm:col-span-3">
        <Button type="submit" disabled={save.isPending || !name.trim()}>{partner ? "Save" : "Add partner"}</Button>
        <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function Partners({ orgId, admin }: { orgId: string; admin: boolean }) {
  const qc = useQueryClient();
  const partners = useQuery({ queryKey: orgKey(orgId, "b2b", "partners"), queryFn: () => api.b2bPartners(orgId) });
  const [form, setForm] = useState<TradingPartner | "new" | null>(null);
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.updateB2bPartner(orgId, id, { enabled }),
    onSuccess: () => void invalidateOrg(qc, orgId),
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <div className="space-y-4">
      {admin && (form ? (
        <PartnerForm key={form === "new" ? "new" : form.id} orgId={orgId} partner={form === "new" ? undefined : form} onDone={() => setForm(null)} />
      ) : (
        <div><Button onClick={() => setForm("new")}><Plus /> Add trading partner</Button></div>
      ))}
      {partners.data?.length === 0 ? (
        <EmptyState icon={Handshake} title="No trading partners yet" description="A trading partner is a business you exchange documents with: send a supplier your orders by email, or receive their invoices." />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground"><tr><th className="p-2">Partner</th><th className="p-2">Via</th><th className="p-2">Mode</th><th className="p-2">Status</th>{admin && <th className="p-2" />}</tr></thead>
            <tbody className="divide-y">
              {partners.data?.map((p) => (
                <tr key={p.id}>
                  <td className="p-2"><span className="font-medium">{p.name}</span><span className="block text-xs text-muted-foreground"><span className="capitalize">{p.kind}</span>{p.bridgeConfig.to ? ` · ${p.bridgeConfig.to}` : ""}</span>
                    {(p.bridge === "invoice-inbox" || (p.bridge === "x12" && p.bridgeConfig.secretEnv)) && <span className="block break-all font-mono text-xs text-muted-foreground">POST {window.location.origin}/api/b2b/inbound/{p.id}</span>}
                    {p.bridge === "x12" && <span className="block text-xs text-muted-foreground">{p.bridgeConfig.ourQual}/{p.bridgeConfig.ourId} to {p.bridgeConfig.theirQual}/{p.bridgeConfig.theirId} · {p.bridgeConfig.version ?? "004010"}{p.bridgeConfig.transport ? ` · ${p.bridgeConfig.transport === "loopback" ? "test partner" : p.bridgeConfig.transport}` : " · no transport yet"}</span>}
                  </td>
                  <td className="p-2">{p.bridge}</td>
                  <td className="p-2"><Badge variant="secondary" className={p.mode === "live" ? "bg-success-soft text-success" : "bg-warning-soft text-warning"}>{p.mode}</Badge></td>
                  <td className="p-2"><Badge variant="secondary">{p.enabled ? "On" : "Off"}</Badge></td>
                  {admin && <td className="space-x-2 p-2 text-right"><Button size="sm" variant="ghost" onClick={() => setForm(p)}>Edit</Button><Button size="sm" variant="outline" onClick={() => toggle.mutate({ id: p.id, enabled: !p.enabled })}>{p.enabled ? "Switch off" : "Switch on"}</Button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- messages ----------

function MessageDetail({ orgId, m, admin }: { orgId: string; m: B2BMessage; admin: boolean }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: orgKey(orgId, "b2b", "message", m.id), queryFn: () => api.b2bMessage(orgId, m.id) });
  const retry = useMutation({ mutationFn: () => api.retryB2bMessage(orgId, m.id), onSuccess: () => { toast.success("Sent again"); void invalidateOrg(qc, orgId); }, onError: (e) => toast.error(errMsg(e)) });
  const ack = useMutation({
    mutationFn: (result: "accepted" | "rejected") => api.ackB2bMessage(orgId, m.id, { level: "business", result, detail: "Recorded by hand" }),
    onSuccess: () => { toast.success("Answer recorded"); void invalidateOrg(qc, orgId); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const partners = useQuery({ queryKey: orgKey(orgId, "b2b", "partners"), queryFn: () => api.b2bPartners(orgId) });
  const partner = partners.data?.find((p) => p.id === m.partnerId);
  const canPretend = admin && m.direction === "out" && m.docType === "order" && partner?.bridge === "x12" && partner.mode === "test" && partner.bridgeConfig.transport === "loopback" && m.state !== "failed" && m.state !== "queued";
  const [scenario, setScenario] = useState("acknowledge");
  const pretend = useMutation({
    mutationFn: () => api.testPartnerAnswers(orgId, m.id, scenario),
    onSuccess: (r) => { toast.success(`The test partner sent ${r.length} document${r.length === 1 ? "" : "s"}`); void invalidateOrg(qc, orgId); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const lastFail = [...m.attempts].reverse().find((a) => !a.ok);
  return (
    <div className="space-y-3 bg-muted/30 p-4 text-sm">
      <p className="text-xs text-muted-foreground">Key {m.idempotencyKey} · {m.rawBytes.toLocaleString()} bytes · fingerprint {m.rawHash.slice(0, 12)}…{m.providerMessageId ? ` · reference ${m.providerMessageId}` : ""}</p>
      {m.attempts.length > 0 && (
        <ul className="space-y-0.5">{m.attempts.map((a, i) => <li key={i}>{formatDateTime(a.at)}: {a.ok ? "handed over" : `failed: ${a.error}${a.retryable ? " (can be retried)" : ""}`}</li>)}</ul>
      )}
      {m.acks.length > 0 && <ul className="space-y-0.5">{m.acks.map((a, i) => <li key={i}>{formatDateTime(a.at)}: {a.level} answer: {a.result}{a.detail ? ` (${a.detail})` : ""}</li>)}</ul>}
      {admin && (
        <div className="flex flex-wrap gap-2">
          {m.state === "failed" && lastFail?.retryable && <Button size="sm" onClick={() => retry.mutate()} disabled={retry.isPending}>Try again</Button>}
          {(m.state === "sent" || m.state === "delivered" || m.state === "received") && (
            <>
              <Button size="sm" variant="outline" onClick={() => ack.mutate("accepted")}>Record as accepted</Button>
              <Button size="sm" variant="outline" onClick={() => ack.mutate("rejected")}>Record as rejected</Button>
            </>
          )}
        </div>
      )}
      {canPretend && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-background p-2">
          <span className="text-xs text-muted-foreground">Test partner:</span>
          <select aria-label="What the test partner does" className={cn(selectClass, "w-auto")} value={scenario} onChange={(e) => setScenario(e.target.value)}>
            {SCENARIOS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
          <Button size="sm" onClick={() => pretend.mutate()} disabled={pretend.isPending}>Let it answer</Button>
        </div>
      )}
      {admin && detail.data?.body && <pre className="max-h-64 overflow-auto rounded-md border bg-background p-2 text-xs">{detail.data.body.length > 4000 ? `${detail.data.body.slice(0, 4000)}\n… (${detail.data.body.length.toLocaleString()} characters)` : detail.data.body}</pre>}
    </div>
  );
}

function Messages({ orgId, admin }: { orgId: string; admin: boolean }) {
  const [direction, setDirection] = useState("");
  const [state, setState] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const msgs = useQuery({ queryKey: orgKey(orgId, "b2b", "messages", direction, state), queryFn: () => api.b2bMessages(orgId, { direction, state }) });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <select aria-label="Direction" className={cn(selectClass, "w-40")} value={direction} onChange={(e) => setDirection(e.target.value)}><option value="">Sent and received</option><option value="out">Sent</option><option value="in">Received</option></select>
        <select aria-label="State" className={cn(selectClass, "w-40")} value={state} onChange={(e) => setState(e.target.value)}><option value="">Any state</option>{["queued", "sent", "delivered", "acknowledged", "rejected", "failed", "received"].map((s) => <option key={s} value={s}>{s}</option>)}</select>
      </div>
      {msgs.data?.length === 0 ? (
        <EmptyState icon={Mail} title="No documents yet" description="Orders you send to a supplier and documents they send back show up here, with every attempt and answer." />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground"><tr><th className="p-2">When</th><th className="p-2">Partner</th><th className="p-2">Document</th><th className="p-2">State</th></tr></thead>
            <tbody className="divide-y">
              {msgs.data?.map((m) => (
                <Fragment key={m.id}>
                  <tr className="cursor-pointer hover:bg-muted/40" onClick={() => setOpen(open === m.id ? null : m.id)}>
                    <td className="whitespace-nowrap p-2">{formatDateTime(m.createdAt)}</td>
                    <td className="p-2">{m.partnerName}</td>
                    <td className="p-2">{m.direction === "out" ? "Sent" : "Received"}: {B2B_DOC_LABELS[m.docType]}{m.correlation.poNumber ? ` ${m.correlation.poNumber}` : ""}</td>
                    <td className="p-2"><StateBadge state={m.state} /></td>
                  </tr>
                  {open === m.id && <tr><td colSpan={4} className="max-w-0 p-0"><MessageDetail orgId={orgId} m={m} admin={admin} /></td></tr>}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- captured invoices ----------

const CONF: Record<string, { label: string; className: string }> = {
  read: { label: "read", className: "bg-success-soft text-success" },
  guess: { label: "check", className: "bg-warning-soft text-warning" },
  entered: { label: "entered", className: "bg-accent text-accent-foreground" },
  missing: { label: "missing", className: "bg-destructive/10 text-destructive dark:bg-destructive/20" },
};

function InvoiceCard({ orgId, inv, admin }: { orgId: string; inv: CapturedInvoice; admin: boolean }) {
  const qc = useQueryClient();
  const [number, setNumber] = useState(inv.invoiceNumber);
  const [po, setPo] = useState(inv.poNumber);
  const [date, setDate] = useState(inv.invoiceDate ?? "");
  const [due, setDue] = useState(inv.dueDate ?? "");
  const [total, setTotal] = useState(inv.totalCents === null ? "" : (inv.totalCents / 100).toFixed(2));
  const [input, setInput] = useState<Record<string, unknown> | null>(null);
  const save = useMutation({
    mutationFn: () => api.updateCapturedInvoice(orgId, inv.id, {
      invoiceNumber: number, poNumber: po, invoiceDate: date || null, dueDate: due || null,
      totalCents: total.trim() === "" ? null : Math.round(Number(total) * 100),
    }),
    onSuccess: () => { toast.success("Saved"); void invalidateOrg(qc, orgId); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const discard = useMutation({
    mutationFn: () => api.discardCapturedInvoice(orgId, inv.id, window.prompt("Why is this being discarded? (optional)") ?? ""),
    onSuccess: () => { toast.success("Discarded"); void invalidateOrg(qc, orgId); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const badge = (f: keyof CapturedInvoice["confidence"]) => <Badge variant="secondary" className={cn("ml-1", CONF[inv.confidence[f]]!.className)}>{CONF[inv.confidence[f]]!.label}</Badge>;
  const editable = inv.status === "captured";
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium">{inv.invoiceNumber || "(no invoice number found)"} <span className="text-sm font-normal text-muted-foreground">from {inv.partnerName} · {inv.source}</span></h3>
        <span className="text-xs text-muted-foreground">{formatDateTime(inv.createdAt)}{inv.from ? ` · ${inv.from}` : ""}</span>
      </div>
      {inv.subject && <p className="text-sm text-muted-foreground">Subject: {inv.subject}</p>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Field label="Invoice number"><span className="flex min-w-0 flex-wrap items-center gap-1"><Input disabled={!editable} value={number} onChange={(e) => setNumber(e.target.value)} />{badge("invoiceNumber")}</span></Field>
        <Field label="Order number"><span className="flex min-w-0 flex-wrap items-center gap-1"><Input disabled={!editable} value={po} onChange={(e) => setPo(e.target.value)} />{badge("poNumber")}</span></Field>
        <Field label="Invoice date"><span className="flex min-w-0 flex-wrap items-center gap-1"><Input disabled={!editable} type="date" value={date} onChange={(e) => setDate(e.target.value)} />{badge("invoiceDate")}</span></Field>
        <Field label="Due date"><span className="flex min-w-0 flex-wrap items-center gap-1"><Input disabled={!editable} type="date" value={due} onChange={(e) => setDue(e.target.value)} />{badge("dueDate")}</span></Field>
        <Field label="Total"><span className="flex min-w-0 flex-wrap items-center gap-1"><Input disabled={!editable} inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} />{badge("totalCents")}</span></Field>
      </div>
      {inv.lines.length > 0 && (
        <table className="w-full text-sm"><thead className="text-left text-xs text-muted-foreground"><tr><th className="py-1">Line</th><th className="py-1 text-right">Qty</th><th className="py-1 text-right">Price</th><th className="py-1 text-right">Amount</th></tr></thead>
          <tbody className="divide-y">{inv.lines.map((l, i) => <tr key={i}><td className="py-1">{l.description}</td><td className="py-1 text-right tabular-nums">{l.quantity}</td><td className="py-1 text-right tabular-nums">{formatCents(l.unitPriceCents)}</td><td className="py-1 text-right tabular-nums">{formatCents(l.lineTotalCents)}</td></tr>)}</tbody></table>
      )}
      <ul className="space-y-0.5 text-sm">
        {inv.match.notes.map((n) => <li key={n} className={cn(/above|below|already|No order|No order number/.test(n) ? "text-warning" : "text-muted-foreground")}>{n}</li>)}
        {inv.match.order && <li className="text-muted-foreground">Order {inv.match.order.number} from {inv.match.order.supplierName}: {formatCents(inv.match.order.totalCents)}</li>}
      </ul>
      {inv.files.length > 0 && <p className="text-sm">Files: {inv.files.map((f) => <a key={f.id} href={api.b2bFileUrl(orgId, f.id)} download className="mr-3 underline">{f.filename} ({Math.ceil(f.bytes / 1024)} KB)</a>)}<span className="text-xs text-muted-foreground"> PDFs are kept as they came; they are not read automatically.</span></p>}
      <div className="flex flex-wrap gap-2">
        {editable && <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>Save corrections</Button>}
        <Button size="sm" variant="outline" onClick={async () => setInput(await api.capturedInvoiceInput(orgId, inv.id))}>What invoice entry would get</Button>
        {editable && admin && <Button size="sm" variant="ghost" onClick={() => discard.mutate()}>Discard</Button>}
      </div>
      {input && <pre className="max-h-56 overflow-auto rounded-md border bg-muted/30 p-2 text-xs">{JSON.stringify(input, null, 2)}</pre>}
    </div>
  );
}

function UploadForm({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const partners = useQuery({ queryKey: orgKey(orgId, "b2b", "partners"), queryFn: () => api.b2bPartners(orgId) });
  const [partnerId, setPartnerId] = useState("");
  const up = useMutation({
    mutationFn: async (file: File) => {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return api.uploadInvoice(orgId, { partnerId: partnerId || partners.data![0]!.id, filename: file.name, contentType: file.type || "application/octet-stream", contentBase64: btoa(bin), note: "" });
    },
    onSuccess: () => { toast.success("Invoice added for checking"); void invalidateOrg(qc, orgId); },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (!partners.data?.length) return <p className="text-sm text-muted-foreground">Add a trading partner first, then upload their invoices here.</p>;
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border p-4">
      <Field label="Invoice from">
        <select className={cn(selectClass, "w-56")} value={partnerId || partners.data[0]!.id} onChange={(e) => setPartnerId(e.target.value)}>{partners.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      </Field>
      <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted">
        <Upload className="size-4" /> Upload a file (PDF, XML or JSON)
        <input type="file" className="sr-only" accept=".pdf,.xml,.json,application/pdf,application/xml,text/xml,application/json" onChange={(e) => { const f = e.target.files?.[0]; if (f) up.mutate(f); e.target.value = ""; }} />
      </label>
      <p className="basis-full text-xs text-muted-foreground">XML (UBL) and JSON invoices are read exactly. A PDF is kept as it is for you to read and type in; nothing is read from it automatically.</p>
    </div>
  );
}

function Invoices({ orgId, admin }: { orgId: string; admin: boolean }) {
  const [status, setStatus] = useState("captured");
  const list = useQuery({ queryKey: orgKey(orgId, "b2b", "invoices", status), queryFn: () => api.capturedInvoices(orgId, status) });
  return (
    <div className="space-y-4">
      <UploadForm orgId={orgId} />
      <select aria-label="Status" className={cn(selectClass, "w-48")} value={status} onChange={(e) => setStatus(e.target.value)}><option value="captured">To check</option><option value="converted">Handed on</option><option value="discarded">Discarded</option><option value="all">All</option></select>
      {list.data?.length === 0 ? (
        <EmptyState icon={Inbox} title="No invoices to check" description="Invoices that arrive by email (through a partner's invoice inbox) or that you upload appear here, with what could be read from them." />
      ) : (
        <div className="space-y-4">{list.data?.map((i) => <InvoiceCard key={i.id + i.updatedAt} orgId={orgId} inv={i} admin={admin} />)}</div>
      )}
    </div>
  );
}

// ---------- page ----------

const TABS = [{ id: "partners", label: "Partners" }, { id: "messages", label: "Documents" }, { id: "invoices", label: "Incoming invoices" }] as const;

export default function DocumentsPage() {
  const org = useCurrentOrg();
  const admin = isAdmin(org.role);
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("partners");
  return (
    <div className="space-y-6">
      <PageHeader title="Partners and documents" description="Send orders to your suppliers by email and take their invoices in. Everything sent or received is kept, with every attempt and answer. (Exchanging with another Invintel business is under Exchange.)" />
      <div role="tablist" className="flex gap-1 border-b">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium", tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>{t.label}</button>
        ))}
      </div>
      {tab === "partners" && <Partners orgId={org.id} admin={admin} />}
      {tab === "messages" && <Messages orgId={org.id} admin={admin} />}
      {tab === "invoices" && <Invoices orgId={org.id} admin={admin} />}
    </div>
  );
}

