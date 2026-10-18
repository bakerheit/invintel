import { PackagePlus } from "lucide-react";
import { Link } from "react-router";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Offered when a scanned code matches nothing: add it as a new item, with the code already captured. */
export function AddItemLink({ orgId, code }: { orgId: string; code: string }) {
  return (
    <Link
      to={`/o/${orgId}/inventory?newItem=${encodeURIComponent(code)}`}
      className={cn(buttonVariants({ variant: "outline" }), "h-14 w-full text-base")}
    >
      <PackagePlus /> Add "{code}" as a new item
    </Link>
  );
}
