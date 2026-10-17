import { type FormEvent, useState } from "react";
import { Link, Navigate, useLocation } from "react-router";
import { AuthField } from "@/components/auth-field";
import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/stores/auth";

export default function LoginPage() {
  const { user, login } = useAuth();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (user) return <Navigate to={location.state?.from ?? "/"} replace />;

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setError(null);
    setPending(true);
    try {
      await login({ email: String(form.get("email")), password: String(form.get("password")) });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthLayout title="Sign in" description="Welcome back. Enter your details to continue.">
      <form onSubmit={onSubmit} className="grid gap-4">
        <AuthField label="Email" id="email" type="email" autoComplete="email" required autoFocus />
        <AuthField label="Password" id="password" type="password" autoComplete="current-password" required />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</Button>
        <p className="text-center text-sm text-muted-foreground">
          No account? <Link to="/register" className="underline">Create one</Link>
        </p>
      </form>
    </AuthLayout>
  );
}
