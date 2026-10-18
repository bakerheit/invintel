import { AUDIT_FIELD_LABELS, formatAuditValue, type AuditEvent, type AuditVerification } from "@invintel/shared";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, ChevronRight, Copy, Download, Search, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { ACTION_META, SCOPES } from "@/lib/audit";
import { formatDateTime, formatRelative } from "@/lib/format";
import { isAdmin, orgKey, useCurrentOrg } from "@/lib/org";
import { cn } from "@/lib/utils";

const ALL = "__all__";

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Details({ event }: { event: AuditEvent }) {
  const snapshot = Object.entries(event.snapshot ?? {}).filter(([, v]) => v !== "" && v !== null);
  return (
    <div className="grid gap-4 text-sm lg:grid-cols-2">
      {event.changes && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">What changed</p>
          <ul className="space-y-1.5">
            {event.changes.map((c) => (
              <li key={c.field} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium capitalize">{AUDIT_FIELD_LABELS[c.field] ?? c.field}</span>
                <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-destructive line-through decoration-destructive/40">
                  {formatAuditValue(c.field, c.from)}
                </span>
                <ArrowRight className="size-3.5 text-muted-foreground" />
                <span className="rounded bg-success-soft px-1.5 py-0.5 text-success">{formatAuditValue(c.field, c.to)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {snapshot.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Recorded details</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            {snapshot.map(([k, v]) => (
              <Fragment key={k}>
                <dt className="text-muted-foreground">{AUDIT_FIELD_LABELS[k] ?? k.replace(/([A-Z])/g, " $1").toLowerCase()}</dt>
                <dd className="min-w-0 break-words">
                  {typeof v === "object" ? JSON.stringify(v) : formatAuditValue(k, v)}
                </dd>
              </Fragment>
            ))}
          </dl>
        </div>
      )}
      <div className="space-y-1 lg:col-span-2">
        <p className="text-xs font-medium text-muted-foreground">Integrity</p>
        <p className="font-mono text-xs break-all text-muted-foreground">
          #{event.seq} · hash {event.hash}
          <br />
          follows {event.prevHash}
        </p>
      </div>
    </div>
  );
}

function IntegrityCard({ result }: { result: AuditVerification }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.headHash);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy. Select the hash and copy it by hand.");
    }
  };
  return (
    <Card className={cn("gap-3 p-4", result.ok ? "border-success/40" : "border-destructive/50")} role="status">
      <div className="flex items-start gap-3">
        {result.ok ? <ShieldCheck className="mt-0.5 size-6 shrink-0 text-success" /> : <ShieldAlert className="mt-0.5 size-6 shrink-0 text-destructive" />}
        <div className="min-w-0 space-y-1">
          {result.ok ? (
            <>
              <p className="font-semibold">History is intact</p>
              <p className="text-sm text-muted-foreground">
                {result.checked.toLocaleString()} events checked. Each one links to the one before it and matches its recorded fingerprint.
              </p>
            </>
          ) : (
            <>
              <p className="font-semibold text-destructive">The history doesn't add up</p>
              <p className="text-sm">
                Problem at event #{result.problem?.seq}: {result.problem?.reason}.
              </p>
            </>
          )}
          {result.ledgerGaps > 0 && (
            <p className="text-sm text-warning">
              {result.ledgerGaps} stock ledger {result.ledgerGaps === 1 ? "entry has" : "entries have"} no matching audit event.
            </p>
          )}
        </div>
      </div>
      <CardContent className="space-y-2 p-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Head after event #{result.headSeq}</span>
          <code className="min-w-0 truncate rounded bg-muted px-2 py-1 font-mono text-xs" title={result.headHash}>
            {result.headHash.slice(0, 16)}…{result.headHash.slice(-8)}
          </code>
          <Button variant="ghost" size="sm" onClick={() => void copy()}>
            {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Keep this fingerprint somewhere else (a document, an email). Later, a matching event number with a different hash proves the history was rewritten, which the check alone can't prove if the newest events were deleted.
        </p>
      </CardContent>
    </Card>
  );
}

export default function AuditPage() {
  const org = useCurrentOrg();
  const orgId = org.id;
  const admin = isAdmin(org.role);
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [open, setOpen] = useState<Set<number>>(new Set());

  const entityId = params.get("entityId") ?? undefined;
  const scope = SCOPES.find((s) => s.value === params.get("scope"))?.value;
  const actorId = params.get("actor") ?? undefined;
  const setParam = (key: string, value?: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const members = useQuery({ queryKey: orgKey(orgId, "members"), queryFn: () => api.listMembers(orgId), enabled: admin });
  const filters = { entityId, action: scope, actorId, q: q || undefined };
  const log = useInfiniteQuery({
    queryKey: orgKey(orgId, "audit", JSON.stringify(filters)),
    queryFn: ({ pageParam }) => api.auditLog(orgId, { ...filters, before: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore,
    enabled: admin,
  });
  const events = log.data?.pages.flatMap((p) => p.events) ?? [];

  const verify = useMutation({
    mutationFn: () => api.verifyAudit(orgId),
    onError: (e: Error) => toast.error(e.message),
  });

  const filtering = !!(entityId || scope || actorId || q);
  const clear = () => {
    setSearch("");
    setParams({}, { replace: true });
  };
  const toggle = (seq: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(seq)) next.add(seq);
      return next;
    });

  const exportParams = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) exportParams.set(k, v);

  if (!admin) {
    return (
      <>
        <PageHeader title="Audit log" />
        <div className="rounded-xl border border-dashed bg-card">
          <EmptyState icon={ShieldAlert} title="Admins only" description="The audit log shows who changed what, including other people's work. Ask an admin if you need something looked up." />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Audit log"
        description="A permanent, tamper-evident record of every change: who did it, when, and exactly what changed. Entries can't be edited or deleted."
        actions={
          <>
            <Button variant="outline" disabled={verify.isPending} onClick={() => verify.mutate()}>
              <ShieldCheck /> {verify.isPending ? "Checking…" : "Verify integrity"}
            </Button>
            <a
              href={`/api/orgs/${orgId}/audit/export?${exportParams}`}
              download
              className={buttonVariants({ variant: "outline" })}
            >
              <Download /> Export CSV
            </a>
          </>
        }
      />

      {verify.data && <IntegrityCard result={verify.data} />}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search the log…" aria-label="Search the audit log" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select
          value={scope ?? ALL}
          onValueChange={(v) => setParam("scope", !v || v === ALL ? undefined : v)}
          items={[{ value: ALL, label: "Everything" }, ...SCOPES]}
        >
          <SelectTrigger className="w-full sm:w-44" aria-label="What changed">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Everything</SelectItem>
            {SCOPES.map((s) => (
              <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={actorId ?? ALL}
          onValueChange={(v) => setParam("actor", !v || v === ALL ? undefined : v)}
          items={[{ value: ALL, label: "Anyone" }, ...(members.data ?? []).map((m) => ({ value: m.userId, label: m.name }))]}
        >
          <SelectTrigger className="w-full sm:w-44" aria-label="Who">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Anyone</SelectItem>
            {members.data?.map((m) => (
              <SelectItem key={m.userId} value={m.userId}>{m.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {entityId && (
          <Badge variant="secondary" className="h-8 gap-1.5 pr-1.5 pl-3 text-sm">
            One record{events[0] ? `: ${events[0].entity.label}` : ""}
            <button type="button" aria-label="Show all records" onClick={() => setParam("entityId")} className="rounded-full p-0.5 hover:bg-foreground/10">
              <X className="size-3.5" />
            </button>
          </Badge>
        )}
        {filtering && !entityId && (
          <Button variant="ghost" size="sm" onClick={clear}>
            <X /> Clear filters
          </Button>
        )}
      </div>

      {log.error ? (
        <p className="text-destructive">Couldn't load the audit log: {log.error.message}</p>
      ) : log.isLoading ? (
        <Skeleton className="h-80 rounded-xl" />
      ) : !events.length ? (
        <div className="rounded-xl border border-dashed bg-card">
          <EmptyState
            icon={ShieldCheck}
            title={filtering ? "Nothing matches those filters" : "Nothing recorded yet"}
            description={filtering ? "Try a different filter." : "Changes to items, locations, stock and settings will appear here."}
            action={filtering ? <Button variant="outline" onClick={clear}>Clear filters</Button> : undefined}
          />
        </div>
      ) : (
        <div className="space-y-3">
          <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-10 w-8" />
                  <TableHead className="h-10 text-xs text-muted-foreground">When</TableHead>
                  <TableHead className="h-10 text-xs text-muted-foreground">Who</TableHead>
                  <TableHead className="h-10 text-xs text-muted-foreground">What</TableHead>
                  <TableHead className="hidden h-10 text-xs text-muted-foreground lg:table-cell">Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((e) => {
                  const meta = ACTION_META[e.action];
                  const expanded = open.has(e.seq);
                  return (
                    <Fragment key={e.id}>
                      <TableRow className="cursor-pointer align-top" onClick={() => toggle(e.seq)}>
                        <TableCell className="py-3">
                          <button
                            type="button"
                            aria-label={expanded ? "Hide details" : "Show details"}
                            aria-expanded={expanded}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              toggle(e.seq);
                            }}
                            className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted"
                          >
                            <ChevronRight className={cn("size-4 transition-transform", expanded && "rotate-90")} />
                          </button>
                        </TableCell>
                        <TableCell className="py-3 whitespace-nowrap">
                          <span title={formatDateTime(e.at)}>{formatRelative(e.at)}</span>
                        </TableCell>
                        <TableCell className="py-3 whitespace-nowrap">{e.actor.name}</TableCell>
                        <TableCell className="py-3 whitespace-normal">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="secondary" className={meta?.className}>{meta?.label ?? e.action}</Badge>
                            <span className="font-medium">{e.entity.label}</span>
                          </div>
                          <p className="mt-1 text-sm text-muted-foreground lg:hidden">{e.summary}</p>
                        </TableCell>
                        <TableCell className="hidden max-w-md py-3 whitespace-normal text-muted-foreground lg:table-cell">{e.summary}</TableCell>
                      </TableRow>
                      {expanded && (
                        <TableRow className="bg-muted/30 hover:bg-muted/30">
                          <TableCell />
                          <TableCell colSpan={4} className="py-4 whitespace-normal">
                            <Details event={e} />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {log.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
                {log.isFetchingNextPage ? "Loading…" : "Load older events"}
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
