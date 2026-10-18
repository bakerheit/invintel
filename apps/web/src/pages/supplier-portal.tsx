import type { PortalOrder } from "@invintel/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { formatCents } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The page a supplier opens from the link in the order email. No account and no sign-in: the link is the key. It shows the
 * order and lets them confirm it (with a promised date), say they can't, or tell us it has shipped (date, carrier, tracking).
 */

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}

function Answers({ order }: { order: PortalOrder }) {
  if (!order.answers.length) return null;
  return (
    <Section title="What you've told us">
      <ul className="space-y-1 text-sm">
        {order.answers.map((a, i) => (
          <li key={i}>
            <strong>{a.action === "confirm" ? "Confirmed" : a.action === "reject" ? "Can't supply" : "Shipped"}</strong> · {when(a.at)}
            {a.promisedDate ? ` · promised ${a.promisedDate}` : ""}
            {a.shipDate ? ` · shipped ${a.shipDate}` : ""}
            {a.carrier || a.trackingNumber ? ` · ${[a.carrier, a.trackingNumber].filter(Boolean).join(" ")}` : ""}
            {a.note ? ` · ${a.note}` : ""}
          </li>
        ))}
      </ul>
    </Section>
  );
}

export default function SupplierPortalPage() {
  const { token = "" } = useParams();
  const qc = useQueryClient();
  const order = useQuery({ queryKey: ["portal", token], queryFn: () => api.portalOrder(token), retry: false });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [promised, setPromised] = useState("");
  const [note, setNote] = useState("");
  const [why, setWhy] = useState("");
  const [shipDate, setShipDate] = useState("");
  const [carrier, setCarrier] = useState("");
  const [tracking, setTracking] = useState("");

  const send = async (answer: Parameters<typeof api.portalAnswer>[1], done: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.portalAnswer(token, answer);
      setMessage(done);
      await qc.invalidateQueries({ queryKey: ["portal", token] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const o = order.data;
  return (
    <div className="min-h-svh bg-background">
      <main className="mx-auto w-full max-w-2xl space-y-4 p-4 pb-16">
        {order.isLoading && <p className="py-16 text-center text-muted-foreground">Loading…</p>}
        {order.isError && (
          <div className="mt-16 rounded-xl border bg-card p-6 text-center">
            <h1 className="text-xl font-semibold">This link isn't valid any more</h1>
            <p className="mt-2 text-muted-foreground">It may have expired or been replaced by a newer one. Please ask the buyer to send the order again.</p>
          </div>
        )}
        {o && (
          <>
            <header className="space-y-1">
              <p className="text-sm text-muted-foreground">Order from {o.buyerName}</p>
              <h1 className="text-3xl font-semibold tracking-tight">{o.poNumber}</h1>
              <p className="text-sm text-muted-foreground">For {o.supplierName}{o.expectedDate ? ` · requested by ${o.expectedDate}` : ""}</p>
              {o.note && <p className="rounded-lg bg-muted px-3 py-2 text-sm">{o.note}</p>}
            </header>

            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground"><tr><th className="p-2">#</th><th className="p-2">Item</th><th className="p-2 text-right">Quantity</th><th className="p-2 text-right">Price</th><th className="p-2 text-right">Amount</th></tr></thead>
                <tbody className="divide-y">
                  {o.lines.map((l) => (
                    <tr key={l.lineNo}><td className="p-2">{l.lineNo}</td><td className="p-2"><span className="font-medium">{l.name}</span>{l.sku && <span className="block font-mono text-xs text-muted-foreground">{l.sku}</span>}</td><td className="p-2 text-right tabular-nums">{l.quantity} {l.unit}</td><td className="p-2 text-right tabular-nums">{formatCents(l.unitPriceCents)}</td><td className="p-2 text-right tabular-nums">{formatCents(l.lineTotalCents)}</td></tr>
                  ))}
                </tbody>
                <tfoot><tr className="border-t bg-muted/30 font-medium"><td className="p-2" colSpan={4}>Total</td><td className="p-2 text-right tabular-nums">{formatCents(o.totalCents)}</td></tr></tfoot>
              </table>
            </div>

            <Answers order={o} />
            {message && <p role="status" className="rounded-lg bg-success-soft px-3 py-2 text-sm font-medium text-success">{message}</p>}
            {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">{error}</p>}

            {!o.open ? (
              <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">This order is closed, so it can't be answered here any more. Please contact the buyer.</p>
            ) : (
              <>
                <Section title="Confirm the order">
                  <Labelled label="When will you ship or deliver it? (optional)"><Input type="date" value={promised} onChange={(e) => setPromised(e.target.value)} /></Labelled>
                  <Labelled label="Anything we should know? (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Labelled>
                  <Button disabled={busy} className="h-11 w-full" onClick={() => void send({ action: "confirm", promisedDate: promised || null, note }, "Thank you. The order is confirmed.")}>Confirm order</Button>
                </Section>
                <Section title="Tell us it has shipped">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Labelled label="Ship date"><Input type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} /></Labelled>
                    <Labelled label="Carrier"><Input value={carrier} onChange={(e) => setCarrier(e.target.value)} maxLength={60} /></Labelled>
                  </div>
                  <Labelled label="Tracking number"><Input value={tracking} onChange={(e) => setTracking(e.target.value)} maxLength={80} /></Labelled>
                  <Button disabled={busy || !shipDate} variant="secondary" className="h-11 w-full" onClick={() => void send({ action: "ship", shipDate, carrier, trackingNumber: tracking }, "Thank you. We've noted the shipment.")}>Send ship notice</Button>
                </Section>
                <Section title="Can't supply it?">
                  <Labelled label="Please tell us why"><Input value={why} onChange={(e) => setWhy(e.target.value)} maxLength={500} /></Labelled>
                  <Button disabled={busy || !why.trim()} variant="outline" className={cn("h-11 w-full")} onClick={() => void send({ action: "reject", note: why }, "Thank you. We've let the buyer know.")}>Decline the order</Button>
                </Section>
              </>
            )}
            <p className="text-center text-xs text-muted-foreground">This page is private to you. The link expires {when(o.expiresAt)}.</p>
          </>
        )}
      </main>
    </div>
  );
}
