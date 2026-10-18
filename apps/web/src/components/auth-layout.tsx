import { History, Users, Warehouse } from "lucide-react";
import type { ReactNode } from "react";
import { Wordmark } from "@/components/brand";

const POINTS = [
  { icon: Warehouse, title: "Every location", text: "Track stock across warehouses, shelves and vans, and move it between them." },
  { icon: Users, title: "Built for teams", text: "Organizations with join codes, so your whole crew sees the same numbers." },
  { icon: History, title: "Nothing goes missing", text: "Every change is recorded with who made it and why." },
];

export function AuthLayout({ title, description, children }: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-h-svh lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-[linear-gradient(160deg,oklch(0.6_0.2_350),oklch(0.42_0.2_305))] p-10 text-white lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_0%,oklch(1_0_0/0.22),transparent_55%),radial-gradient(circle_at_90%_100%,oklch(0.25_0.12_305/0.45),transparent_60%)]"
        />
        <Wordmark className="relative [&>div]:bg-white/15 [&>div]:text-white [&>div]:shadow-none" />
        <div className="relative max-w-md space-y-8">
          <h2 className="text-4xl font-semibold tracking-tight text-balance">Know what you have, and where it is.</h2>
          <ul className="space-y-5">
            {POINTS.map(({ icon: Icon, title: t, text }) => (
              <li key={t} className="flex gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/15">
                  <Icon className="size-4.5" />
                </span>
                <div>
                  <p className="font-medium">{t}</p>
                  <p className="text-sm text-white/75">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-white/70">Open source inventory by Bakerheit Technologies · MIT</p>
      </aside>
      <main className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm space-y-8">
          <Wordmark className="lg:hidden" />
          <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
