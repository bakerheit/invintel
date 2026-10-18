import { Link } from "react-router";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { useCurrentOrg } from "@/lib/org";
import { REPORTS } from "@/lib/reports";

export default function ReportsHome() {
  const org = useCurrentOrg();
  const orgId = org.id;
  return (
    <>
      <PageHeader title="Reports" description="Questions the ledger can answer." />
      <div className="grid gap-3 sm:grid-cols-2">
        {REPORTS.filter((r) => !r.module || org.modules[r.module]).map((r) => (
          <Link key={r.path} to={`/o/${orgId}/reports/${r.path}`} className="rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            <Card className="h-full gap-2 p-5 transition-colors hover:bg-muted/40">
              <span className="flex size-9 items-center justify-center rounded-lg bg-accent text-accent-foreground"><r.icon className="size-5" /></span>
              <h2 className="font-semibold">{r.title}</h2>
              <p className="text-sm text-muted-foreground">{r.description}</p>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
