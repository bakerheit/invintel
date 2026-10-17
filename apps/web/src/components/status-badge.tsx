import { Badge } from "@/components/ui/badge";
import type { StockStatus } from "@/lib/stock";
import { cn } from "@/lib/utils";

const STYLES: Record<StockStatus, { label: string; className: string }> = {
  ok: { label: "In stock", className: "bg-success-soft text-success" },
  low: { label: "Low", className: "bg-warning-soft text-warning" },
  out: { label: "Out", className: "bg-destructive/10 text-destructive dark:bg-destructive/20" },
};

export function StatusBadge({ status }: { status: StockStatus }) {
  const { label, className } = STYLES[status];
  return (
    <Badge variant="secondary" className={cn("gap-1.5", className)}>
      <span className="size-1.5 rounded-full bg-current" />
      {label}
    </Badge>
  );
}
