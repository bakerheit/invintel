import { useQuery } from "@tanstack/react-query";
import { MapPin, Package, ScanLine, Search } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { visibleNav } from "@/components/app-sidebar";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { orgKey, useCurrentOrg, useLocations } from "@/lib/org";
import { cn } from "@/lib/utils";

interface Hit {
  key: string;
  group: "Go to" | "Items" | "Locations";
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

const MAX_PER_GROUP = 6;

/** Ctrl/Cmd+K: jump to a page, an item (by name, SKU or barcode) or a location without leaving the keyboard. */
export function CommandPalette() {
  const org = useCurrentOrg();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Only fetch once someone opens it. The same queries feed the Inventory page, so they're usually cached.
  const items = useQuery({ queryKey: orgKey(org.id, "items"), queryFn: () => api.listItems(org.id), enabled: open });
  const { data: locations = [] } = useLocations(org.id);

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    const go = (to: string) => () => void navigate(to);
    const pages: Hit[] = [
      ...visibleNav(org).map((n) => ({
        key: n.to, group: "Go to" as const, label: n.label, icon: <n.icon className="size-4" />, run: go(n.to),
      })),
      { key: "floor", group: "Go to" as const, label: "Floor mode", icon: <ScanLine className="size-4" />, run: go(`/o/${org.id}/floor`) },
    ].filter((p) => !q || p.label.toLowerCase().includes(q));
    if (!q) return pages;
    const itemHits: Hit[] = (items.data ?? [])
      .filter((i) => [i.name, i.sku, ...i.barcodes].some((t) => t.toLowerCase().includes(q)))
      .slice(0, MAX_PER_GROUP)
      .map((i) => ({
        key: `i${i.id}`, group: "Items" as const, label: i.name, hint: `${i.sku} · ${i.quantity.toLocaleString()} on hand`,
        icon: <Package className="size-4" />,
        run: () => void navigate(`/o/${org.id}/inventory/${i.id}`),
      }));
    const locationHits: Hit[] = locations
      .filter((l) => [l.name, l.path, l.code].some((t) => t.toLowerCase().includes(q)))
      .slice(0, MAX_PER_GROUP)
      .map((l) => ({
        key: `l${l.id}`, group: "Locations" as const, label: l.path, hint: l.code || undefined,
        icon: <MapPin className="size-4" />, run: go(`/o/${org.id}/inventory?location=${l.id}`),
      }));
    return [...pages, ...itemHits, ...locationHits];
  }, [query, items.data, locations, navigate, org.id, org.role]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [active]);

  const choose = (hit: Hit | undefined) => {
    if (!hit) return;
    setOpen(false);
    setQuery("");
    hit.run();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); choose(hits[active]); }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="ml-auto flex h-9 items-center gap-2 rounded-lg border bg-muted/40 px-3 text-sm text-muted-foreground hover:bg-muted"
        aria-label="Search and jump to anything"
      >
        <Search className="size-4" />
        <span className="hidden sm:inline">Search</span>
        <kbd className="hidden rounded border bg-background px-1.5 font-mono text-[10px] sm:inline">⌘K</kbd>
      </button>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(""); }}>
        <DialogContent className="top-[20%] max-w-lg translate-y-0 gap-0 p-0" showCloseButton={false}>
          <DialogTitle className="sr-only">Search</DialogTitle>
          <DialogDescription className="sr-only">Type to find a page, item or location. Arrow keys to move, Enter to open.</DialogDescription>
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="size-4 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Jump to a page, item, SKU, barcode or location…"
              aria-label="Search"
              role="combobox"
              aria-expanded
              aria-controls="palette-list"
              className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <ul id="palette-list" ref={list} role="listbox" className="max-h-80 overflow-y-auto p-1.5">
            {!hits.length && <li className="px-3 py-6 text-center text-sm text-muted-foreground">{items.isLoading ? "Searching…" : "Nothing matches."}</li>}
            {hits.map((h, i) => (
              <li key={h.key} role="option" aria-selected={i === active}>
                {(i === 0 || hits[i - 1]!.group !== h.group) && <p className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">{h.group}</p>}
                <button
                  type="button"
                  onMouseMove={() => setActive(i)}
                  onClick={() => choose(h)}
                  className={cn("flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm", i === active && "bg-accent text-accent-foreground")}
                >
                  <span className="text-muted-foreground">{h.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{h.label}</span>
                  {h.hint && <span className="shrink-0 text-xs text-muted-foreground">{h.hint}</span>}
                </button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
