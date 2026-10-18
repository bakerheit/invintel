import type { Location } from "@invintel/shared";
import { Search } from "lucide-react";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { LOCATION_TYPE_META } from "@/lib/locations";

/** Fallback for when a label won't scan: pick the place from a list. */
export function LocationPicker({ open, onOpenChange, locations, onPick, title = "Choose a location" }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locations: Location[];
  onPick: (location: Location) => void;
  title?: string;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = locations.filter((l) => !q || l.path.toLowerCase().includes(q) || l.code.toLowerCase().includes(q));
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setQuery("");
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[85svh] gap-3 overflow-hidden sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-xl">{title}</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-12 pl-10 text-base" placeholder="Search" aria-label="Search locations" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <ul className="-mx-2 max-h-[55svh] space-y-1 overflow-y-auto px-2">
          {shown.map((l) => {
            const { icon: Icon, label } = LOCATION_TYPE_META[l.type];
            return (
              <li key={l.id}>
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    onPick(l);
                  }}
                  className="flex min-h-14 w-full items-center gap-3 rounded-lg border px-3 text-left hover:bg-muted active:bg-muted"
                >
                  <Icon className="size-5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base font-medium">{l.path}</span>
                    <span className="block text-xs text-muted-foreground">
                      {label}
                      {l.code ? ` · ${l.code}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
          {!shown.length && <li className="py-6 text-center text-muted-foreground">No locations match.</li>}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
