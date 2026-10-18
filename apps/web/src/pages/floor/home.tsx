import type { OrgModules } from "@invintel/shared";
import { ArrowLeftRight, ClipboardCheck, Factory, PackagePlus, ScanSearch, type LucideIcon } from "lucide-react";
import { Link } from "react-router";
import { useCurrentOrg } from "@/lib/org";
import { cn } from "@/lib/utils";

const TILES: { to: string; label: string; hint: string; icon: LucideIcon; wide: boolean; module?: keyof OrgModules }[] = [
  { to: "receive", label: "Receive", hint: "Stock coming in", icon: PackagePlus, wide: false },
  { to: "move", label: "Move", hint: "Item to a new place", icon: ArrowLeftRight, wide: false },
  { to: "production", label: "Production", hint: "Load, report usage, report output", icon: Factory, wide: true, module: "production" },
  { to: "count", label: "Count", hint: "Say how many are there", icon: ClipboardCheck, wide: false },
  { to: "lookup", label: "Look up", hint: "What's this? Where is it?", icon: ScanSearch, wide: false },
];

export default function FloorHome() {
  const org = useCurrentOrg();
  return (
    <>
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">What are you doing?</h1>
        <p className="text-base text-muted-foreground">Scan labels with the scanner, or tap the keyboard button to type a code.</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {TILES.filter((t) => !t.module || org.modules[t.module]).map(({ to, label, hint, icon: Icon, wide }) => (
          <Link
            key={to}
            to={`/o/${org.id}/floor/${to}`}
            className={cn(
              "flex min-h-40 flex-col items-center justify-center gap-3 rounded-2xl border bg-card p-5 text-center shadow-xs transition-colors hover:bg-muted/50 active:bg-muted",
              wide && "col-span-2 min-h-32",
            )}
          >
            <span className="flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Icon className="size-7" />
            </span>
            <span className="space-y-0.5">
              <span className="block text-2xl font-semibold">{label}</span>
              <span className="block text-sm text-muted-foreground">{hint}</span>
            </span>
          </Link>
        ))}
      </div>
    </>
  );
}
