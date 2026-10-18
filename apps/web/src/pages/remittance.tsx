import { PAYMENT_METHOD_LABELS } from "@invintel/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Printer } from "lucide-react";
import { Link, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { orgKey, useCurrentOrg } from "@/lib/org";

/** A remittance advice: what was paid to a supplier and which invoices it covered. Prints cleanly on its own. */
export default function RemittancePage() {
  const { paymentId = "" } = useParams();
  const org = useCurrentOrg();
  const q = useQuery({ queryKey: orgKey(org.id, "remittance", paymentId), queryFn: () => api.remittance(org.id, paymentId) });
  if (q.isLoading) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  if (q.error || !q.data) return <p role="alert" className="p-6 text-sm text-destructive">{(q.error as Error | null)?.message ?? "Remittance not found"}</p>;
  const r = q.data;
  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6 print:p-0">
      <div className="flex items-center justify-between print:hidden">
        <Link to={`/o/${org.id}/payables`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft className="size-4" /> Back to payables</Link>
        <Button onClick={() => window.print()}><Printer /> Print</Button>
      </div>
      <article className="space-y-6 rounded-lg border bg-card p-6 print:border-0 print:p-0">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Remittance advice</h1>
            <p className="text-sm text-muted-foreground">{r.paymentNumber}{r.voided && <span className="ml-2 font-semibold text-destructive">VOID</span>}</p>
          </div>
          <dl className="text-right text-sm">
            <dt className="text-muted-foreground">Paid on</dt><dd className="font-medium">{r.paidOn}</dd>
            <dt className="mt-1 text-muted-foreground">Method</dt><dd className="font-medium">{PAYMENT_METHOD_LABELS[r.method]}{r.reference ? ` · ${r.reference}` : ""}</dd>
          </dl>
        </header>
        <div className="grid gap-4 text-sm sm:grid-cols-2">
          <div><p className="text-muted-foreground">From</p><p className="font-medium">{r.from.name}</p></div>
          <div><p className="text-muted-foreground">To</p><p className="font-medium">{r.to.name}</p></div>
        </div>
        <table className="w-full text-sm">
          <thead className="border-b text-left text-xs text-muted-foreground"><tr><th className="py-2">Your invoice</th><th>Dated</th><th className="text-right">Invoice total</th><th className="text-right">Paid</th></tr></thead>
          <tbody className="divide-y">
            {r.lines.map((l) => (
              <tr key={l.invoiceNumber}><td className="py-2 font-medium">{l.invoiceNumber}</td><td>{l.issueDate}</td><td className="text-right tabular-nums">{formatMoney(l.invoiceTotalCents, r.currency)}</td><td className="text-right tabular-nums">{formatMoney(l.amountCents, r.currency)}</td></tr>
            ))}
          </tbody>
          <tfoot><tr className="border-t font-semibold"><td className="py-2" colSpan={3}>Total paid</td><td className="text-right tabular-nums">{formatMoney(r.totalCents, r.currency)}</td></tr></tfoot>
        </table>
        {r.note && <p className="text-sm text-muted-foreground">{r.note}</p>}
        <p className="text-xs text-muted-foreground">This is a record of a payment made, not a request for money.</p>
      </article>
    </main>
  );
}
