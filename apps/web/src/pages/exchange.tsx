import type { ExchangePermissions } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Handshake, Link2, Send, Truck, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type ExAnswer, type ExIncomingOrder, type ExPartner } from "@/lib/api";
import { formatCents, formatRelative } from "@/lib/format";
import { invalidateOrg, isAdmin, orgKey, useCurrentOrg } from "@/lib/org";

const copyText = async (text: string, what: string) => {
  try { await navigator.clipboard.writeText(text); toast.success(`${what} copied`); } catch { toast.error("Couldn't copy. Select it and copy by hand."); }
};

function Identity({ orgId, admin }: { orgId: string; admin: boolean }) {
  const qc = useQueryClient();
  const id = useQuery({ queryKey: orgKey(orgId, "ex-identity"), queryFn: () => api.exIdentity(orgId) });
  const inv = useQuery({ queryKey: orgKey(orgId, "ex-invitation"), queryFn: () => api.exInvitation(orgId) });
  const [addr, setAddr] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.exSetAddress(orgId, addr ?? ""),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: orgKey(orgId, "ex-identity") }); await qc.invalidateQueries({ queryKey: orgKey(orgId, "ex-invitation") }); setAddr(null); toast.success("Address saved"); },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!id.data || !inv.data) return <Skeleton className="h-40 rounded-xl" />;
  return (
    <Card>
      <CardHeader><CardTitle>Your exchange identity</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">Other Invintel businesses add you with your invitation. It holds your public key, not a secret. When someone gives you theirs, check the fingerprint with them by phone or in person.</p>
        <div className="grid gap-1 sm:grid-cols-[8rem_1fr]"><span className="text-muted-foreground">Exchange id</span><code className="font-mono">{id.data.exchangeId}</code><span className="text-muted-foreground">Fingerprint</span><code className="font-mono">{id.data.fingerprint}</code></div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void copyText(JSON.stringify(inv.data), "Invitation")}><Copy /> Copy my invitation</Button>
          {admin && (
            <form className="flex w-full flex-wrap items-center gap-2 sm:w-auto" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
              <Input aria-label="Public address of this server" className="h-8 w-full min-w-0 sm:w-72" placeholder="https://invintel.mycompany.com (only if partners are on other servers)" value={addr ?? id.data.baseUrl} onChange={(e) => setAddr(e.target.value)} />
              <Button size="sm" type="submit" disabled={addr === null || save.isPending}>Save address</Button>
            </form>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Connect({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"supplier" | "customer">("supplier");
  const connect = useMutation({
    mutationFn: () => api.exConnect(orgId, JSON.parse(text), kind),
    onSuccess: async (r) => { await qc.invalidateQueries({ queryKey: orgKey(orgId, "ex-partners") }); setText(""); toast.success(`Connected ${r.partner.name}. Fingerprint ${r.partner.fingerprint}. Check it with them.`); },
    onError: (e: Error) => toast.error(e instanceof SyntaxError ? "That isn't an invitation. Paste the whole thing they sent." : e.message),
  });
  return (
    <Card>
      <CardHeader><CardTitle>Connect to a business</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <label htmlFor="ex-invite" className="text-sm font-medium">Paste their invitation</label>
        <textarea id="ex-invite" rows={3} className="w-full rounded-md border bg-background p-2 font-mono text-xs" placeholder='{"protocol":"invintel-exchange/1", ...}' value={text} onChange={(e) => setText(e.target.value)} />
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span>They are my</span>
          {(["supplier", "customer"] as const).map((k) => (
            <label key={k} className="flex items-center gap-1.5"><input type="radio" name="ex-kind" checked={kind === k} onChange={() => setKind(k)} /> {k}</label>
          ))}
          <Button size="sm" disabled={!text.trim() || connect.isPending} onClick={() => connect.mutate()}><Link2 /> Connect</Button>
        </div>
        <p className="text-xs text-muted-foreground">A supplier is someone you send purchase orders to. A customer sends orders to you.</p>
      </CardContent>
    </Card>
  );
}

function PermissionBoxes({ p, onChange, disabled }: { p: ExchangePermissions; onChange: (n: ExchangePermissions) => void; disabled: boolean }) {
  const set = (patch: Partial<ExchangePermissions>) => onChange({ ...p, ...patch });
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      <label className="flex items-center gap-1.5"><input type="checkbox" disabled={disabled} checked={p.shareStock} onChange={(e) => set({ shareStock: e.target.checked, ...(e.target.checked ? {} : { shareStockQuantities: false }) })} /> may ask if an item is in stock</label>
      <label className="flex items-center gap-1.5"><input type="checkbox" disabled={disabled || !p.shareStock} checked={p.shareStockQuantities} onChange={(e) => set({ shareStockQuantities: e.target.checked })} /> and see the quantity</label>
      <label className="flex items-center gap-1.5"><input type="checkbox" disabled={disabled} checked={p.shareOrderStatus} onChange={(e) => set({ shareOrderStatus: e.target.checked })} /> may ask where their order is</label>
    </div>
  );
}

function Partners({ orgId, admin, partners }: { orgId: string; admin: boolean; partners: ExPartner[] }) {
  const qc = useQueryClient();
  const perm = useMutation({
    mutationFn: ({ id, p }: { id: string; p: ExchangePermissions }) => api.exPermissions(orgId, id, p),
    onSuccess: () => qc.invalidateQueries({ queryKey: orgKey(orgId, "ex-partners") }),
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Card>
      <CardHeader><CardTitle>Connected businesses</CardTitle></CardHeader>
      <CardContent>
        {!partners.length ? <EmptyState icon={Handshake} title="Nobody yet" description="Paste a partner's invitation above to trade with them. If they are on this same server, they are connected both ways at once." /> : (
          <ul className="divide-y">
            {partners.map((p) => (
              <li key={p.id} className="space-y-2 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{p.name}</span><Badge variant="secondary">{p.kind}</Badge><Badge variant="secondary">{p.mode}</Badge><code className="ml-auto font-mono text-xs text-muted-foreground">{p.fingerprint}</code></div>
                <PermissionBoxes p={p.permissions} disabled={!admin || perm.isPending} onChange={(n) => perm.mutate({ id: p.id, p: n })} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function IncomingOrders({ orgId, admin }: { orgId: string; admin: boolean }) {
  const qc = useQueryClient();
  const orders = useQuery({ queryKey: orgKey(orgId, "ex-orders"), queryFn: () => api.exOrders(orgId), refetchInterval: 20_000 });
  const [open, setOpen] = useState<string | null>(null);
  const [date, setDate] = useState("");
  const [tracking, setTracking] = useState("");
  const done = async (msg: string) => { await invalidateOrg(qc, orgId); toast.success(msg); setOpen(null); };
  // Accepting a customer's order promises stock: it becomes a sales order that reserves it. If that can't be done the answer isn't sent.
  const [problem, setProblem] = useState<{ id: string; text: string } | null>(null);
  const respond = useMutation({
    mutationFn: (v: { id: string; status: "accepted" | "rejected" | "changed"; backorder?: boolean }) => api.exRespond(orgId, v.id, { status: v.status, promisedDate: date || null, note: "", backorder: v.backorder }),
    onSuccess: (r, v) => {
      setProblem(null);
      if (r.approvalRequired) { void qc.invalidateQueries({ queryKey: orgKey(orgId, "ex-orders") }); toast.success(`${r.approval?.number ?? "A request"} sent for approval. ${r.salesOrder?.number ?? "The order"} is reserved and the customer is told when an admin approves.`); setOpen(null); return; }
      return done(r.salesOrder && v.status !== "rejected" ? `Answered: ${v.status}. ${r.salesOrder.number} reserves the stock.` : `Answered: ${v.status}`);
    },
    onError: (e: Error, v) => { if (v.status !== "rejected") setProblem({ id: v.id, text: e.message }); else toast.error(e.message); },
  });
  const ship = useMutation({ mutationFn: (id: string) => api.exShip(orgId, id, { carrier: "", tracking }), onSuccess: () => done("Ship notice sent"), onError: (e: Error) => toast.error(e.message) });
  const list = orders.data ?? [];
  return (
    <Card>
      <CardHeader><CardTitle>Orders from customers</CardTitle></CardHeader>
      <CardContent>
        {!list.length ? <p className="text-sm text-muted-foreground">Nothing yet. Orders your connected customers send arrive here.</p> : (
          <ul className="divide-y">
            {list.map((o: ExIncomingOrder) => (
              <li key={o.messageId} className="space-y-2 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-medium">{o.order?.poNumber ?? "?"}</span><span>from {o.partner}</span><span className="text-xs text-muted-foreground">{formatRelative(o.receivedAt)}</span>
                  <span className="ml-auto flex gap-1.5">
                    {o.response && <Badge variant="secondary" className={o.response.status === "rejected" ? "bg-destructive/10 text-destructive" : "bg-success-soft text-success"}>{o.response.status}{o.response.promisedDate ? ` for ${o.response.promisedDate}` : ""}</Badge>}
                    {o.salesOrder && <Link to={`/o/${orgId}/sales`} className="inline-flex"><Badge variant="secondary" className="bg-accent text-accent-foreground">{o.salesOrder.number}{o.salesOrder.state === "confirmed" ? " · stock reserved" : o.salesOrder.state === "draft" ? " · not reserved yet" : ` · ${o.salesOrder.state}`}</Badge></Link>}
                    {o.shipped && <Badge variant="secondary">shipped</Badge>}
                  </span>
                </div>
                {o.order && <p className="text-xs text-muted-foreground">{o.order.lines.map((l) => `${l.quantity} ${l.unit} ${l.sku}${l.unitPriceCents ? ` @ ${formatCents(l.unitPriceCents)}` : ""}`).join(", ")}{o.order.requestedDate ? `. Wanted by ${o.order.requestedDate}.` : ""}</p>}
                {problem?.id === o.messageId && (
                  <div role="alert" className="space-y-2 rounded-lg border border-warning/40 bg-warning-soft p-3 text-warning">
                    <p>{problem.text}</p>
                    {admin && problem.text.includes("Not enough available") && <Button size="sm" variant="outline" onClick={() => respond.mutate({ id: o.messageId, status: "accepted", backorder: true })} disabled={respond.isPending}>Accept anyway (back-order)</Button>}
                  </div>
                )}
                {open === o.messageId ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {!o.response && admin && <><Input aria-label="Promised date" type="date" className="h-8 w-40" value={date} onChange={(e) => setDate(e.target.value)} /><Button size="sm" onClick={() => respond.mutate({ id: o.messageId, status: "accepted" })}><Check /> Accept</Button><Button size="sm" variant="outline" onClick={() => respond.mutate({ id: o.messageId, status: "rejected" })}><X /> Reject</Button></>}
                    {o.response && !o.shipped && o.salesOrder && o.salesOrder.state !== "cancelled" && <Link to={`/o/${orgId}/sales`} className="inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-sm font-medium hover:bg-muted"><Truck className="size-4" /> Ship from Sales ({o.salesOrder.number})</Link>}
                    {o.response && !o.shipped && !(o.salesOrder && o.salesOrder.state !== "cancelled") && <><Input aria-label="Tracking number" className="h-8 w-48" placeholder="Tracking number (optional)" value={tracking} onChange={(e) => setTracking(e.target.value)} /><Button size="sm" onClick={() => ship.mutate(o.messageId)}><Truck /> Send ship notice</Button></>}
                    <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>Close</Button>
                  </div>
                ) : (!o.shipped && (admin || o.response)) && <Button size="sm" variant="outline" onClick={() => setOpen(o.messageId)}>{o.response ? "Ship" : "Answer"}</Button>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Ask({ orgId, partners }: { orgId: string; partners: ExPartner[] }) {
  const qc = useQueryClient();
  const [partnerId, setPartnerId] = useState("");
  const [kind, setKind] = useState<"stock" | "order_status">("stock");
  const [value, setValue] = useState("");
  const answers = useQuery({ queryKey: orgKey(orgId, "ex-answers"), queryFn: () => api.exAnswers(orgId), refetchInterval: 15_000 });
  const ask = useMutation({
    mutationFn: () => api.exAsk(orgId, partnerId || partners[0]!.id, kind === "stock" ? { kind: "stock", sku: value.trim() } : { kind: "order_status", poNumber: value.trim() }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: orgKey(orgId, "ex-answers") }); setValue(""); },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!partners.length) return null;
  const text = (a: ExAnswer) => {
    if (!a.answer) return a.state === "failed" ? "Couldn't be delivered." : "Waiting for an answer...";
    if (!a.answer.ok) return a.answer.reason ?? "No answer.";
    if (a.answer.stock) { const s = a.answer.stock; return `${s.description}: ${s.availability.replace("_", " ")}${s.quantity !== undefined ? `, ${s.quantity} ${s.unit}` : ""}`; }
    if (a.answer.order) { const o = a.answer.order; return `${o.poNumber}: ${o.status}${o.promisedDate ? `, promised ${o.promisedDate}` : ""}`; }
    return "";
  };
  return (
    <Card>
      <CardHeader><CardTitle>Ask a partner</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (value.trim()) ask.mutate(); }}>
          <select aria-label="Who to ask" className="h-9 rounded-md border bg-background px-2" value={partnerId || partners[0]!.id} onChange={(e) => setPartnerId(e.target.value)}>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <select aria-label="Kind of question" className="h-9 rounded-md border bg-background px-2" value={kind} onChange={(e) => setKind(e.target.value as "stock" | "order_status")}><option value="stock">Do you have this item?</option><option value="order_status">Where is my order?</option></select>
          <Input aria-label={kind === "stock" ? "Their item code" : "Our PO number"} className="h-9 w-48" placeholder={kind === "stock" ? "Item code (SKU)" : "PO number"} value={value} onChange={(e) => setValue(e.target.value)} />
          <Button type="submit" size="sm" disabled={!value.trim() || ask.isPending}><Send /> Ask</Button>
        </form>
        <ul className="divide-y">
          {(answers.data ?? []).slice(0, 8).map((a) => (
            <li key={a.messageId} className="py-2"><p><span className="font-medium">{a.partner}</span> <span className="text-xs text-muted-foreground">{formatRelative(a.askedAt)} · {a.question.kind === "stock" ? `item ${a.question.sku}` : `order ${a.question.poNumber}`}</span></p><p className={a.answer && !a.answer.ok ? "text-muted-foreground" : ""}>{text(a)}</p></li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export default function ExchangePage() {
  const { id: orgId, role } = useCurrentOrg();
  const admin = isAdmin(role);
  const partners = useQuery({ queryKey: orgKey(orgId, "ex-partners"), queryFn: () => api.exPartners(orgId) });
  const list = partners.data ?? [];
  return (
    <>
      <PageHeader title="Exchange" description="Trade purchase orders, answers and ship notices with other Invintel businesses, signed so nobody can forge or change them." />
      <Identity orgId={orgId} admin={admin} />
      {admin && <Connect orgId={orgId} />}
      <Partners orgId={orgId} admin={admin} partners={list} />
      <IncomingOrders orgId={orgId} admin={admin} />
      <Ask orgId={orgId} partners={list} />
    </>
  );
}
