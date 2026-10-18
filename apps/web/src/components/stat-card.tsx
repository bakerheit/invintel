import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function StatCard({ label, value, icon: Icon, hint, tone = "default", onClick, active }: {
  label: string;
  value: string;
  icon: LucideIcon;
  hint?: string;
  tone?: "default" | "warning";
  onClick?: () => void;
  active?: boolean;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 text-sm leading-tight text-muted-foreground">{label}</span>
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-lg",
            tone === "warning" ? "bg-warning-soft text-warning" : "bg-accent text-accent-foreground",
          )}
        >
          <Icon className="size-4" />
        </span>
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </>
  );
  const base = "gap-0 p-4 text-left";
  return onClick ? (
    <button type="button" onClick={onClick} aria-pressed={active} className="rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
      <Card className={cn(base, "h-full transition-colors hover:bg-muted/40", active && "ring-2 ring-primary")}>{body}</Card>
    </button>
  ) : (
    <Card className={base}>{body}</Card>
  );
}
