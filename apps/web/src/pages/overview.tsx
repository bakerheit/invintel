import { formatQty, type LocationType } from "@invintel/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Circle, CircleDollarSign, Download, History, Layers, Package, ScanLine, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatCents, formatRelative } from "@/lib/format";
import { orgKey, useCurrentOrg } from "@/lib/org";
import { cn } from "@/lib/utils";

const TYPE_LABEL: Record<LocationType, string> = {
  receiving: "Receiving",
  storage: "Storage",
  wip: "Work in progress",
  production: "At the machines",
  finished: "Finished goods",
  shipping: "Shipping",
  quarantine: "On quality hold",
};

/** A short list for a new organization. Hides itself once everything is done, or when dismissed. */
function GettingStarted({ orgId, items, locations, units, members, movements }: { orgId: string; items: number; locations: number; units: number; members: number; movements: number }) {
  const key = `invintel.started.${orgId}`;
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem(key) === "1"; } catch { return false; }
  });
  const steps = [
    { done: items > 0, label: "Add your items", hint: "One by one, or import a spreadsheet.", to: `/o/${orgId}/inventory` },
    { done: locations > 1, label: "Set up your locations", hint: "Receiving dock, racks, machines, shipping. Give them codes you can print.", to: `/o/${orgId}/locations` },
    { done: units > 0 || movements > 0, label: "Receive some stock", hint: "Floor mode is the fast way: scan the item, scan the place.", to: `/o/${orgId}/floor/receive` },
    { done: members > 1, label: "Invite your team", hint: "Share the join code from Settings.", to: `/o/${orgId}/settings` },
  ];
  if (hidden || steps.every((s) => s.done)) return null;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Getting started · {steps.filter((s) => s.done).length} of {steps.length}</CardTitle>
          <button
            type="button"
            aria-label="Hide getting started"
            className="rounded p-1 text-muted-foreground hover:bg-muted"
            onClick={() => { try { localStorage.setItem(key, "1"); } catch { /* private mode: it just comes back next visit */ } setHidden(true); }}
          >
            <X className="size-4" />
          </button>
        </div>
      </CardHeader>
      <CardContent>
        <ol className="grid gap-2 sm:grid-cols-2">
          {steps.map((s) => (
            <li key={s.label}>
              <Link to={s.to} className="flex h-full items-start gap-3 rounded-lg border p-3 hover:bg-muted/40">
                {s.done ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" /> : <Circle className="mt-0.5 size-5 shrink-0 text-muted-foreground" />}
                <span>
                  <span className={cn("block text-sm font-medium", s.done && "text-muted-foreground line-through")}>{s.label}</span>
                  <span className="block text-xs text-muted-foreground">{s.hint}</span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

export default function OverviewPage() {
  const { id: orgId, memberCount } = useCurrentOrg();
  const overview = useQuery({ queryKey: orgKey(orgId, "overview"), queryFn: () => api.overview(orgId), refetchInterval: 30_000 });
  const recent = useQuery({ queryKey: orgKey(orgId, "recent"), queryFn: () => api.activity(orgId, {}) });
  const o = overview.data;

  if (overview.error) return <p className="text-destructive">Couldn't load the overview: {overview.error.message}</p>;
  if (!o) {
    return (
      <>
        <PageHeader title="Overview" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </>
    );
  }

  const problems = o.outCount + o.lowCount;
  const maxUnits = Math.max(1, ...o.byType.map((t) => t.units));
  const entries = (recent.data?.entries ?? []).slice(0, 8);

  return (
    <>
      <PageHeader
        title="Overview"
        description="What needs attention, and where your stock is right now."
        actions={
          <Link to={`/o/${orgId}/floor`} className={buttonVariants()}>
            <ScanLine /> Floor mode
          </Link>
        }
      />

      <GettingStarted orgId={orgId} items={o.items} locations={o.locations} units={o.units} members={memberCount} movements={o.movements24h} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Items" value={o.items.toLocaleString()} icon={Package} hint={`${o.locations} ${o.locations === 1 ? "location" : "locations"}`} />
        <StatCard label="Units on hand" value={o.units.toLocaleString()} icon={Layers} hint={`${o.movements24h.toLocaleString()} ${o.movements24h === 1 ? "entry" : "entries"} in the last 24 h`} />
        <StatCard label="Inventory value" value={formatCents(o.valueCents)} icon={CircleDollarSign} hint="At unit cost" />
        <StatCard
          label="Needs attention"
          value={problems.toLocaleString()}
          icon={TriangleAlert}
          tone={problems ? "warning" : "default"}
          hint={problems ? `${o.outCount} out, ${o.lowCount} low` : "Everything is stocked"}
        />
      </div>

      {o.awaitingPutaway > 0 && (
        <Card className="border-warning/40 bg-warning-soft/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <p>
              <span className="font-semibold tabular-nums">{o.awaitingPutaway.toLocaleString()}</span> units are still in receiving. Move them to where they belong so
              the floor can find them.
            </p>
            <Link to={`/o/${orgId}/floor/move`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Put away <ArrowRight />
            </Link>
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Needs attention</CardTitle>
          </CardHeader>
          <CardContent>
            {!o.attention.length ? (
              o.items === 0 ? (
                <EmptyState icon={Package} title="No items yet" description="Add items or import a spreadsheet, and anything running low shows up here." />
              ) : (
                <EmptyState icon={Package} title="Nothing to chase" description="No item is out of stock or at its reorder level." />
              )
            ) : (
              <ul className="divide-y">
                {o.attention.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{a.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{a.sku}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="tabular-nums text-muted-foreground">
                        {formatQty(a.quantity, a.uom)}
                        {a.reorderLevel > 0 && <> / {formatQty(a.reorderLevel, a.uom, { unit: false })}</>}
                      </span>
                      <Badge variant={a.status === "out" ? "destructive" : "secondary"}>{a.status === "out" ? "Out" : "Low"}</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {problems > o.attention.length && (
              <Link to={`/o/${orgId}/inventory`} className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "mt-2")}>
                See all {problems} <ArrowRight />
              </Link>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Where the stock is</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {o.byType.filter((t) => t.locations > 0).map((t) => (
              <div key={t.type} className="space-y-1">
                <div className="flex items-baseline justify-between text-sm">
                  <span>{TYPE_LABEL[t.type]} <span className="text-xs text-muted-foreground">· {t.locations} {t.locations === 1 ? "place" : "places"}</span></span>
                  <span className="tabular-nums">{t.units.toLocaleString()} <span className="text-xs text-muted-foreground">· {formatCents(t.valueCents)}</span></span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${t.units} units`}>
                  <div className="h-full rounded-full bg-primary" style={{ width: `${(t.units / maxUnits) * 100}%` }} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>Latest activity</CardTitle>
            <Link to={`/o/${orgId}/activity`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              <History /> All activity
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          {!entries.length ? (
            <EmptyState icon={Download} title="No activity yet" description="Receive stock in Floor mode and it shows up here." />
          ) : (
            <ul className="divide-y">
              {entries.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate"><span className="font-medium">{e.itemName}</span> <span className="text-muted-foreground">· {e.locationName}</span></p>
                    <p className="truncate text-xs text-muted-foreground">{e.userName} · {formatRelative(e.createdAt)}</p>
                  </div>
                  <span className={cn("shrink-0 tabular-nums font-medium", e.delta < 0 && "text-muted-foreground")}>{formatQty(e.delta, e.uom, { sign: true })}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
