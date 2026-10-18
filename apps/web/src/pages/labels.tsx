import { formatQty } from "@invintel/shared";
import { useQuery } from "@tanstack/react-query";
import { Printer } from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { BarcodeSvg, type LabelFormat } from "@/components/barcode-svg";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { orgKey, useCurrentOrg, useLocations } from "@/lib/org";
import { cn } from "@/lib/utils";

type Kind = "items" | "locations" | "units";

interface Candidate {
  id: string;
  /** What gets encoded in the barcode. */
  code: string;
  title: string;
  subtitle: string;
}

const KINDS: { value: Kind; label: string; hint: string }[] = [
  { value: "items", label: "Items", hint: "Prints the SKU" },
  { value: "locations", label: "Locations", hint: "Prints the location code, or its name if it has none" },
  { value: "units", label: "Rolls and pallets", hint: "Prints each unit's own label" },
];

const SIZES = [
  { value: "small", label: "Small, 2.25 × 1.25 in", className: "h-[1.25in] w-[2.25in]" },
  { value: "medium", label: "Medium, 3 × 2 in", className: "h-[2in] w-[3in]" },
  { value: "large", label: "Large, 4 × 3 in", className: "h-[3in] w-[4in]" },
] as const;

const FORMATS: { value: LabelFormat; label: string }[] = [
  { value: "code128", label: "Code 128 (linear barcode)" },
  { value: "qrcode", label: "QR code" },
];

function Label({ c, format, size }: { c: Candidate; format: LabelFormat; size: (typeof SIZES)[number]["value"] }) {
  const dims = SIZES.find((s) => s.value === size)!.className;
  return (
    <div className={cn("label-card flex break-inside-avoid flex-col justify-between overflow-hidden border border-dashed border-neutral-400 bg-white p-2 text-black print:border-none", dims)}>
      <p className="line-clamp-2 text-[11px] leading-tight font-semibold">{c.title}</p>
      <div className={cn("flex min-h-0 flex-1 items-center justify-center py-1", format === "qrcode" && "justify-start gap-2")}>
        <BarcodeSvg text={c.code} format={format} className={format === "qrcode" ? "aspect-square h-full" : "h-full w-full"} />
        {format === "qrcode" && <p className="min-w-0 text-[10px] leading-tight text-neutral-700">{c.subtitle}</p>}
      </div>
      <div className="flex items-end justify-between gap-2">
        <p className="font-mono text-[11px] font-bold">{c.code}</p>
        {format === "code128" && <p className="truncate text-[9px] text-neutral-700">{c.subtitle}</p>}
      </div>
    </div>
  );
}

/** Print labels for items, locations and units. Codes come straight from the data so scans always match. */
export default function LabelsPage() {
  const { id: orgId } = useCurrentOrg();
  const [params] = useSearchParams();
  const initialKind: Kind = params.get("units") ? "units" : params.get("locations") ? "locations" : "items";
  const [kind, setKind] = useState<Kind>(initialKind);
  const [format, setFormat] = useState<LabelFormat>("code128");
  const [size, setSize] = useState<(typeof SIZES)[number]["value"]>("medium");
  const [copies, setCopies] = useState(1);
  const [search, setSearch] = useState("");
  const preselect = (key: Kind) => new Set((params.get(key) ?? "").split(",").filter(Boolean));
  const [selected, setSelected] = useState<Record<Kind, Set<string>>>({ items: preselect("items"), locations: preselect("locations"), units: preselect("units") });

  const items = useQuery({ queryKey: orgKey(orgId, "items"), queryFn: () => api.listItems(orgId) });
  const { data: locations = [] } = useLocations(orgId);
  const units = useQuery({ queryKey: orgKey(orgId, "units", "labels"), queryFn: () => api.listUnits(orgId, { status: "available", limit: 200 }) });

  const candidates: Record<Kind, Candidate[]> = useMemo(
    () => ({
      items: (items.data ?? []).map((i) => ({ id: i.id, code: i.sku, title: i.name, subtitle: i.category })),
      locations: locations.map((l) => ({ id: l.id, code: l.code || l.name, title: l.path, subtitle: l.code ? l.name : "" })),
      units: (units.data?.units ?? []).map((u) => ({ id: u.id, code: u.code, title: u.itemName, subtitle: [u.lot && `Lot ${u.lot}`, formatQty(u.quantity, u.uom)].filter(Boolean).join(" · ") })),
    }),
    [items.data, locations, units.data],
  );

  const q = search.trim().toLowerCase();
  const shown = candidates[kind].filter((c) => !q || c.code.toLowerCase().includes(q) || c.title.toLowerCase().includes(q));
  const chosen = (["items", "locations", "units"] as Kind[]).flatMap((k) => candidates[k].filter((c) => selected[k].has(c.id)));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev[kind]);
      if (!next.delete(id)) next.add(id);
      return { ...prev, [kind]: next };
    });
  const allShown = shown.length > 0 && shown.every((c) => selected[kind].has(c.id));
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev[kind]);
      for (const c of shown) allShown ? next.delete(c.id) : next.add(c.id);
      return { ...prev, [kind]: next };
    });

  const sheet = chosen.flatMap((c) => Array.from({ length: copies }, (_, i) => ({ c, key: `${c.id}-${i}` })));

  return (
    <>
      <div className="print:hidden space-y-6">
        <PageHeader
          title="Labels"
          description="Print barcode labels for items, locations and rolls or pallets, so a scanner can find them."
          actions={
            <Button disabled={!sheet.length} onClick={() => window.print()}>
              <Printer /> Print {sheet.length ? `${sheet.length} ${sheet.length === 1 ? "label" : "labels"}` : ""}
            </Button>
          }
        />

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border p-0.5" role="tablist" aria-label="What to label">
            {KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                role="tab"
                aria-selected={kind === k.value}
                onClick={() => setKind(k.value)}
                className={cn("rounded-md px-3 py-1.5 text-sm font-medium", kind === k.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                {k.label}
                {selected[k.value].size > 0 && <span className="ml-1.5 opacity-80">({selected[k.value].size})</span>}
              </button>
            ))}
          </div>
          <Select value={format} onValueChange={(v) => v && setFormat(v as LabelFormat)} items={FORMATS}>
            <SelectTrigger className="w-52" aria-label="Barcode type"><SelectValue /></SelectTrigger>
            <SelectContent>{FORMATS.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={size} onValueChange={(v) => v && setSize(v as typeof size)} items={SIZES.map((s) => ({ value: s.value, label: s.label }))}>
            <SelectTrigger className="w-52" aria-label="Label size"><SelectValue /></SelectTrigger>
            <SelectContent>{SIZES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
          </Select>
          <label className="flex items-center gap-2 text-sm">
            Copies
            <Input type="number" min={1} max={50} value={copies} onChange={(e) => setCopies(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} className="w-20" aria-label="Copies of each label" />
          </label>
        </div>
        <p className="text-sm text-muted-foreground">{KINDS.find((k) => k.value === kind)!.hint}.</p>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <div className="space-y-2">
            <Input placeholder="Search…" aria-label="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="rounded-xl border bg-card">
              <label className="flex items-center gap-3 border-b px-3 py-2 text-sm font-medium">
                <input type="checkbox" checked={allShown} onChange={toggleAll} className="size-4" disabled={!shown.length} />
                Select all shown ({shown.length})
              </label>
              <ul className="max-h-96 divide-y overflow-y-auto">
                {shown.map((c) => (
                  <li key={c.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/50">
                      <input type="checkbox" checked={selected[kind].has(c.id)} onChange={() => toggle(c.id)} className="size-4" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{c.title}</span>
                        <span className="block truncate font-mono text-xs text-muted-foreground">{c.code}</span>
                      </span>
                    </label>
                  </li>
                ))}
                {!shown.length && <li className="p-6 text-center text-sm text-muted-foreground">Nothing to label here yet.</li>}
              </ul>
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium">Preview</p>
            {sheet.length ? (
              <div className="flex flex-wrap gap-2 rounded-xl border bg-neutral-100 p-3 dark:bg-neutral-200">
                {sheet.slice(0, 24).map(({ c, key }) => <Label key={key} c={c} format={format} size={size} />)}
                {sheet.length > 24 && <p className="w-full text-sm text-neutral-700">+ {sheet.length - 24} more on the printed sheet</p>}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed bg-card">
                <EmptyState icon={Printer} title="Pick something to label" description="Tick items on the left and a preview appears here." />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Only this is visible when printing (see index.css). */}
      <div className="label-sheet hidden print:flex print:flex-wrap print:gap-1">
        {sheet.map(({ c, key }) => <Label key={key} c={c} format={format} size={size} />)}
      </div>
    </>
  );
}
