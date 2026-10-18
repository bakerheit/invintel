import { ACCENTS, DOC_COLUMNS, DOC_KINDS, DOC_LABELS, DEFAULT_TITLES, type CompanyProfile, type DocKind, type DocTemplate, type DocumentSettings } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, ImagePlus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { AddressFields, addressOrNull, orBlank } from "@/components/address-fields";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { invalidateOrg, isAdmin, orgKey, useCurrentOrg } from "@/lib/org";
import { cn } from "@/lib/utils";

const field = "w-full rounded-md border bg-background px-3 py-2 text-sm";
const toBps = (pct: string) => Math.round(Number(pct || 0) * 100);
const fromBps = (bps: number) => String(bps / 100);

/** A read-only preview that redraws a sample document from the values on the screen, a moment after they stop changing. */
function Preview({ orgId, kind, company, template }: { orgId: string; kind: DocKind; company: CompanyProfile; template: DocTemplate }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify([kind, company, template]);
  const last = useRef<string | null>(null);
  useEffect(() => {
    let dead = false;
    const t = setTimeout(async () => {
      try {
        const blob = await api.previewDocument(orgId, { kind, company, template });
        if (dead) return;
        const u = URL.createObjectURL(blob);
        if (last.current) URL.revokeObjectURL(last.current);
        last.current = u;
        setUrl(u);
        setError(null);
      } catch (e) {
        if (!dead) setError(e instanceof Error ? e.message : "Couldn't make the preview");
      }
    }, 600);
    return () => { dead = true; clearTimeout(t); };
  }, [key, orgId, kind, company, template]);
  useEffect(() => () => { if (last.current) URL.revokeObjectURL(last.current); }, []);
  return (
    <div className="space-y-2">
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {url ? <iframe title={`${DOC_LABELS[kind]} preview`} src={`${url}#toolbar=0&navpanes=0`} className="h-[70vh] min-h-[420px] w-full rounded-lg border bg-white" /> : <Skeleton className="h-[70vh] min-h-[420px] w-full" />}
      {url && <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground underline"><ExternalLink className="size-3" /> Open the preview in its own tab</a>}
    </div>
  );
}

function LogoCard({ orgId, settings, admin }: { orgId: string; settings: DocumentSettings; admin: boolean }) {
  const qc = useQueryClient();
  const file = useRef<HTMLInputElement>(null);
  const done = () => invalidateOrg(qc, orgId);
  const upload = useMutation({
    mutationFn: async (f: File) => {
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return api.uploadLogo(orgId, btoa(bin));
    },
    onSuccess: async () => { await done(); toast.success("Logo saved"); },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({ mutationFn: () => api.removeLogo(orgId), onSuccess: async () => { await done(); toast.success("Logo removed"); }, onError: (e: Error) => toast.error(e.message) });
  const logo = settings.logo;
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="flex h-20 w-40 items-center justify-center rounded-lg border bg-white p-2">
        {logo ? <img src={api.logoUrl(orgId, `${logo.width}x${logo.height}-${logo.bytes}`)} alt="Your logo" className="max-h-full max-w-full object-contain" /> : <span className="text-xs text-muted-foreground">No logo</span>}
      </div>
      <div className="space-y-2 text-sm">
        <p className="text-muted-foreground">PNG or JPEG, up to 300 KB and 1500 pixels each way. SVG isn't accepted.</p>
        {admin && (
          <div className="flex gap-2">
            <input ref={file} type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ""; }} />
            <Button type="button" variant="outline" size="sm" onClick={() => file.current?.click()} disabled={upload.isPending}><ImagePlus /> {logo ? "Replace logo" : "Upload a logo"}</Button>
            {logo && <Button type="button" variant="ghost" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}><Trash2 /> Remove</Button>}
          </div>
        )}
        {logo && <p className="text-xs text-muted-foreground">{logo.width} x {logo.height} pixels, {Math.ceil(logo.bytes / 1024)} KB</p>}
      </div>
    </div>
  );
}

export default function DocumentSettingsPage() {
  const { id: orgId, role } = useCurrentOrg();
  const admin = isAdmin(role);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: orgKey(orgId, "doc-settings"), queryFn: () => api.documentSettings(orgId) });
  const [company, setCompany] = useState<CompanyProfile | null>(null);
  const [templates, setTemplates] = useState<Record<DocKind, DocTemplate> | null>(null);
  const [kind, setKind] = useState<DocKind>("purchase_order");
  useEffect(() => { if (q.data && !company) { setCompany(q.data.company); setTemplates(q.data.templates); } }, [q.data, company]);
  const dirty = !!q.data && !!company && !!templates && (JSON.stringify(company) !== JSON.stringify(q.data.company) || JSON.stringify(templates) !== JSON.stringify(q.data.templates));
  const save = useMutation({
    mutationFn: () => api.saveDocumentSettings(orgId, { company: company!, templates: templates! }),
    onSuccess: async (s) => { setCompany(s.company); setTemplates(s.templates); await invalidateOrg(qc, orgId); toast.success("Document settings saved"); },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!q.data || !company || !templates) return <Skeleton className="h-96 w-full" />;
  const t = templates[kind];
  const setT = (patch: Partial<DocTemplate>) => setTemplates({ ...templates, [kind]: { ...t, ...patch } });
  const setC = (patch: Partial<CompanyProfile>) => setCompany({ ...company, ...patch });
  const ro = !admin;

  return (
    <>
      <div><Link to={`/o/${orgId}/settings`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft className="size-4" /> Settings</Link></div>
      <PageHeader title="Documents" description="How your purchase orders, order confirmations, packing slips and invoices look. The preview is a sample with made-up data." actions={admin ? <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>Save changes</Button> : undefined} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
        <div className="space-y-6">
          <Card>
            <CardContent className="space-y-4 pt-6">
              <h2 className="font-semibold">Letterhead</h2>
              <p className="text-sm text-muted-foreground">Printed at the top of every document.</p>
              <LogoCard orgId={orgId} settings={q.data} admin={admin} />
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5 sm:col-span-2"><Label htmlFor="c-name">Company name</Label><Input id="c-name" disabled={ro} value={company.name} placeholder={q.data.orgName} maxLength={100} onChange={(e) => setC({ name: e.target.value })} /></div>
                <div className="space-y-2 sm:col-span-2">
                  <p className="text-sm font-medium">Address</p>
                  <AddressFields idPrefix="co" disabled={ro} withName={false} value={orBlank(company.address)} onChange={(a) => setC({ address: a, ...(addressOrNull(a) ? { addressLines: [] } : {}) })} />
                  <p className="text-xs text-muted-foreground">Printed on every document, and written into EDI orders as your address (use the state or province code and a two-letter country code for EDI).</p>
                </div>
                {company.addressLines.length > 0 && !addressOrNull(orBlank(company.address)) && (
                  <div className="grid gap-1.5 sm:col-span-2"><Label htmlFor="c-addr">Printed address lines (older way: fill in the address above to replace them)</Label><textarea id="c-addr" disabled={ro} rows={3} className={field} value={company.addressLines.join("\n")} onChange={(e) => setC({ addressLines: e.target.value.split("\n").slice(0, 5).map((l) => l.slice(0, 80)) })} /></div>
                )}
                <div className="grid gap-1.5"><Label htmlFor="c-phone">Phone</Label><Input id="c-phone" disabled={ro} value={company.phone} maxLength={40} onChange={(e) => setC({ phone: e.target.value })} /></div>
                <div className="grid gap-1.5"><Label htmlFor="c-email">Email</Label><Input id="c-email" disabled={ro} value={company.email} maxLength={120} onChange={(e) => setC({ email: e.target.value })} /></div>
                <div className="grid gap-1.5"><Label htmlFor="c-web">Website</Label><Input id="c-web" disabled={ro} value={company.website} maxLength={120} onChange={(e) => setC({ website: e.target.value })} /></div>
                <div className="grid gap-1.5"><Label htmlFor="c-tax">Tax or registration number</Label><Input id="c-tax" disabled={ro} value={company.taxId} maxLength={60} onChange={(e) => setC({ taxId: e.target.value })} /></div>
                <div className="grid gap-1.5"><Label htmlFor="c-paper">Paper</Label>
                  <select id="c-paper" disabled={ro} className={field} value={company.paper} onChange={(e) => setC({ paper: e.target.value as "a4" | "letter" })}><option value="a4">A4</option><option value="letter">US Letter</option></select>
                </div>
              </div>
              <h3 className="pt-2 text-sm font-semibold">Invoices</h3>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="grid gap-1.5"><Label htmlFor="c-taxlabel">Tax is called</Label><Input id="c-taxlabel" disabled={ro} value={company.taxLabel} maxLength={20} onChange={(e) => setC({ taxLabel: e.target.value })} /></div>
                <div className="grid gap-1.5"><Label htmlFor="c-rate">Tax rate (%)</Label><Input id="c-rate" disabled={ro} inputMode="decimal" value={fromBps(company.taxRateBps)} onChange={(e) => setC({ taxRateBps: Math.min(10_000, Math.max(0, toBps(e.target.value))) })} /></div>
                <div className="grid gap-1.5"><Label htmlFor="c-terms">Days to pay</Label><Input id="c-terms" disabled={ro} inputMode="numeric" value={company.paymentTermsDays} onChange={(e) => setC({ paymentTermsDays: Math.min(365, Math.max(0, Math.round(Number(e.target.value) || 0))) })} /></div>
              </div>
              <p className="text-xs text-muted-foreground">Tax is added to what shipped when an invoice is made. An invoice is numbered the first time it is made and keeps its numbers after that, even if these change.</p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-4 pt-6">
              <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Document type">
                {DOC_KINDS.map((k) => (
                  <button key={k} role="tab" type="button" aria-selected={k === kind} onClick={() => setKind(k)} className={cn("rounded-md border px-3 py-1.5 text-sm", k === kind ? "border-primary bg-primary/10 font-medium" : "text-muted-foreground hover:bg-muted")}>{DOC_LABELS[k]}</button>
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5"><Label htmlFor="t-title">Title</Label><Input id="t-title" disabled={ro} value={t.title} maxLength={40} placeholder={DEFAULT_TITLES[kind]} onChange={(e) => setT({ title: e.target.value })} /></div>
                <div className="grid gap-1.5">
                  <Label>Colour</Label>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {ACCENTS.map((a) => <button key={a.hex} type="button" disabled={ro} aria-label={a.name} title={a.name} onClick={() => setT({ accent: a.hex })} className={cn("size-7 rounded-full border-2", t.accent.toLowerCase() === a.hex ? "border-foreground" : "border-transparent")} style={{ background: a.hex }} />)}
                    <Input aria-label="Colour as #RRGGBB" disabled={ro} className="h-8 w-24 font-mono text-xs" value={t.accent} maxLength={7} onChange={(e) => setT({ accent: e.target.value })} aria-invalid={!/^#[0-9a-fA-F]{6}$/.test(t.accent) ? true : undefined} />
                  </div>
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={ro} checked={t.showLogo} onChange={(e) => setT({ showLogo: e.target.checked })} /> Show the logo on this document</label>
              <fieldset className="space-y-1.5">
                <legend className="text-sm font-medium">Columns</legend>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {DOC_COLUMNS[kind].map((c) => (
                    <label key={c.key} className="flex items-center gap-1.5 text-sm"><input type="checkbox" disabled={ro} checked={t.columns.includes(c.key)} onChange={(e) => { const next = e.target.checked ? [...t.columns, c.key] : t.columns.filter((x) => x !== c.key); if (next.length) setT({ columns: DOC_COLUMNS[kind].map((x) => x.key).filter((x) => next.includes(x)) }); }} /> {c.label}</label>
                  ))}
                </div>
              </fieldset>
              <div className="grid gap-1.5"><Label htmlFor="t-terms">{kind === "invoice" ? "Payment terms" : "Terms and conditions"}</Label><textarea id="t-terms" disabled={ro} rows={4} maxLength={800} className={field} value={t.terms} onChange={(e) => setT({ terms: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label htmlFor="t-foot">Footer (every page)</Label><Input id="t-foot" disabled={ro} value={t.footer} maxLength={300} onChange={(e) => setT({ footer: e.target.value })} /></div>
              <p className="text-xs text-muted-foreground">A customer or supplier can have their own title, colour and terms: edit them under Documents &gt; Partners.</p>
            </CardContent>
          </Card>
        </div>
        <div className="lg:sticky lg:top-4 lg:self-start"><Preview orgId={orgId} kind={kind} company={company} template={t} /></div>
      </div>
    </>
  );
}
