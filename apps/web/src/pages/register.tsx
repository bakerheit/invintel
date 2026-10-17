import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, Navigate } from "react-router";
import { AuthField } from "@/components/auth-field";
import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAuth } from "@/stores/auth";

export default function RegisterPage() {
  const { user, register } = useAuth();
  const config = useQuery({ queryKey: ["auth-config"], queryFn: api.authConfig });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (form.get("password") !== form.get("confirm")) {
      setError("Passwords don't match");
      return;
    }
    setError(null);
    setPending(true);
    try {
      await register({
        name: String(form.get("name")),
        email: String(form.get("email")),
        password: String(form.get("password")),
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  const closed = config.data?.registrationOpen === false;

  return (
    <AuthLayout title="Create account" description="The first account becomes the admin.">
      {closed ? (
        <div className="grid gap-4 text-sm">
          <p className="text-muted-foreground">Registration is closed. Ask an admin for access.</p>
          <Link to="/login" className="underline">Back to sign in</Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="grid gap-4">
          <AuthField label="Name" id="name" autoComplete="name" required autoFocus />
          <AuthField label="Email" id="email" type="email" autoComplete="email" required />
          <AuthField label="Password" id="password" type="password" autoComplete="new-password" minLength={8} required />
          <AuthField label="Confirm password" id="confirm" type="password" autoComplete="new-password" required />
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create account"}</Button>
          <p className="text-center text-sm text-muted-foreground">
            Already registered? <Link to="/login" className="underline">Sign in</Link>
          </p>
        </form>
      )}
    </AuthLayout>
  );
}
