import { ArrowRight, CloudOff, MousePointer2, Zap } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { useToast } from "../components/Toaster";
import { Button, Input, Logo, Spinner, ThemeToggle } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { delay } from "../lib/motion";

export function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const next = new URLSearchParams(location.search).get("next") ?? "/projects";
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const u = mode === "login" ? await api.login(username, password) : await api.register(username, password, displayName || username);
      setUser(u);
      toast.show({ kind: "success", title: mode === "login" ? `Welcome back, ${u.displayName}` : `Welcome to Weave, ${u.displayName}!` });
      navigate(next, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <div className="flex flex-col px-6 py-6 sm:px-12">
        <div className="flex items-center justify-between">
          <Logo />
          <ThemeToggle />
        </div>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-10">
          <h1 className="rise text-3xl font-bold tracking-tight text-ink">{mode === "login" ? "Welcome back" : "Create your account"}</h1>
          <p className="rise mt-2 text-ink-2" style={delay(60)}>
            {mode === "login" ? "Sign in to keep writing with your team." : "Free forever on your own server. Takes 20 seconds."}
          </p>
          <form onSubmit={submit} className="rise mt-8 space-y-4" style={delay(120)} noValidate>
            <Input
              label="Username"
              name="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="ayesha"
              hint={mode === "signup" ? "Letters, digits, '_', '-' or '.', 3–32 characters." : undefined}
              required
              autoFocus
            />
            {mode === "signup" && (
              <Input label="Display name" name="displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Ayesha Rahman" hint="Shown next to your cursor." />
            )}
            <Input
              label="Password"
              name="password"
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              hint={mode === "signup" ? "At least 8 characters." : undefined}
              required
            />
            {error && (
              <p role="alert" className="pop rounded-xl bg-surface-2 px-3 py-2 text-sm text-bad">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full py-2.5" disabled={busy}>
              {busy ? <Spinner size={16} className="border-white/40 border-t-white" /> : <ArrowRight size={16} />}
              {mode === "login" ? "Sign in" : "Create account"}
            </Button>
          </form>
          <p className="mt-6 text-center text-sm text-ink-2">
            {mode === "login" ? "New to Weave? " : "Already have an account? "}
            <Link to={`${mode === "login" ? "/signup" : "/login"}${location.search}`} className="font-semibold text-accent-ink hover:underline">
              {mode === "login" ? "Create an account" : "Sign in"}
            </Link>
          </p>
        </div>
      </div>
      <aside className="bg-gradient relative hidden overflow-hidden lg:block" aria-hidden>
        <div className="grid-pattern absolute inset-0 opacity-40" />
        <div className="relative flex h-full flex-col justify-center gap-4 p-14 text-white">
          {[
            { icon: MousePointer2, t: "Live cursors", b: "See every co-author typing in real time." },
            { icon: CloudOff, t: "Offline edits merge", b: "Write on the bus; it syncs when you're back." },
            { icon: Zap, t: "PDF as you type", b: "Real LaTeX, compiled in a sandbox." },
          ].map((f, i) => (
            <div key={f.t} className="rise float flex max-w-md items-start gap-4 rounded-2xl bg-white/12 p-5 backdrop-blur" style={{ ...delay(150 + i * 120), animationDuration: "520ms, 7s" }}>
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/20">
                <f.icon size={20} />
              </span>
              <div>
                <div className="font-semibold">{f.t}</div>
                <div className="mt-0.5 text-sm text-white/85">{f.b}</div>
              </div>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
