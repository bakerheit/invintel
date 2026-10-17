import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatJoinCode, isAdmin, orgKey, orgsKey, useCurrentOrg } from "@/lib/org";

function RenameForm({ orgId, name }: { orgId: string; name: string }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const rename = useMutation({
    mutationFn: (value: string) => api.renameOrg(orgId, { name: value }),
    onSuccess: () => qc.invalidateQueries({ queryKey: orgsKey }),
    onError: (e: Error) => setError(e.message),
  });
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    rename.mutate(String(new FormData(e.currentTarget).get("name")));
  };
  return (
    <form onSubmit={onSubmit} className="flex items-end gap-3">
      <div className="grid flex-1 gap-1.5">
        <Label htmlFor="org-name">Name</Label>
        <Input id="org-name" name="name" defaultValue={name} key={name} required maxLength={100} />
      </div>
      <Button type="submit" disabled={rename.isPending}>Save</Button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </form>
  );
}

function JoinCodeCard({ orgId, joinCode }: { orgId: string; joinCode: string }) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const rotate = useMutation({
    mutationFn: () => api.rotateJoinCode(orgId),
    onSuccess: () => qc.invalidateQueries({ queryKey: orgsKey }),
  });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatJoinCode(joinCode));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard can be blocked; the code is on screen to copy by hand */
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Join code</CardTitle>
        <CardDescription>
          Anyone with this code can join as a member when they register or from "Create or join another".
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <code aria-label="Join code" className="rounded-md border bg-muted px-3 py-2 font-mono text-lg tracking-widest">
          {formatJoinCode(joinCode)}
        </code>
        <Button variant="outline" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</Button>
        <Button
          variant="ghost"
          disabled={rotate.isPending}
          onClick={() => {
            if (confirm("Make a new join code? The current one will stop working.")) rotate.mutate();
          }}
        >
          Generate new code
        </Button>
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const org = useCurrentOrg();
  const admin = isAdmin(org.role);
  const members = useQuery({ queryKey: orgKey(org.id, "members"), queryFn: () => api.listMembers(org.id) });

  return (
    <div className="max-w-3xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Organization</CardTitle>
          <CardDescription>
            You're {org.role === "admin" ? "an admin" : `a${org.role === "owner" ? "n" : ""} ${org.role}`} here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {admin ? <RenameForm orgId={org.id} name={org.name} /> : <p className="font-medium">{org.name}</p>}
        </CardContent>
      </Card>

      {admin && org.joinCode ? (
        <JoinCodeCard orgId={org.id} joinCode={org.joinCode} />
      ) : (
        <p className="text-sm text-muted-foreground">Ask an admin for this organization's join code to invite people.</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>{org.memberCount} {org.memberCount === 1 ? "person" : "people"}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.data?.map((m) => (
                <TableRow key={m.userId}>
                  <TableCell className="font-medium">{m.name}</TableCell>
                  <TableCell className="text-muted-foreground">{m.email}</TableCell>
                  <TableCell className="capitalize">{m.role}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Link to="/orgs/new" className={buttonVariants({ variant: "outline" })}>
        Create or join another organization
      </Link>
    </div>
  );
}
