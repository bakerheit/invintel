import { CircleCheck } from "lucide-react";
import type { ReactNode } from "react";

export function ResultPanel({ title, detail, children }: { title: string; detail?: string; children?: ReactNode }) {
  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center gap-3 rounded-2xl bg-success-soft px-4 py-10 text-center text-success">
        <CircleCheck className="size-16" />
        <p className="text-2xl font-semibold">{title}</p>
        {detail && <p className="text-lg">{detail}</p>}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}
