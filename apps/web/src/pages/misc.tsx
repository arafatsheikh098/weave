import { Compass, MailOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { useToast } from "../components/Toaster";
import { Avatar, Button, ButtonLink, EmptyState, Logo, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

export function InvitePage() {
  const { token = "" } = useParams();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [info, setInfo] = useState<{ role: string; projectName: string; invitedBy: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.inviteInfo(token).then(setInfo, (e: Error) => setError(e.message));
  }, [token]);

  const accept = async () => {
    setBusy(true);
    try {
      const { projectId } = await api.acceptInvite(token);
      toast.show({ kind: "success", title: `You joined “${info?.projectName}”` });
      navigate(`/p/${projectId}`);
    } catch (e) {
      toast.show({ kind: "error", title: "Couldn't join", body: (e as Error).message });
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <div className="card rise w-full max-w-md p-8 text-center">
        <div className="flex justify-center">
          <Logo />
        </div>
        {error ? (
          <EmptyState icon={MailOpen} title="Invite not valid" action={<ButtonLink to="/">Go home</ButtonLink>}>
            {error}
          </EmptyState>
        ) : !info || loading ? (
          <div className="mt-8 space-y-3">
            <Skeleton className="mx-auto h-6 w-2/3" />
            <Skeleton className="h-10" />
          </div>
        ) : (
          <>
            <div className="mt-8 flex justify-center">
              <Avatar name={info.invitedBy} color="#6250d6" size={52} />
            </div>
            <h1 className="mt-4 text-xl font-semibold text-ink">
              {info.invitedBy} invited you to <span className="text-gradient">{info.projectName}</span>
            </h1>
            <p className="mt-2 text-sm text-ink-2">You'll join as {info.role === "editor" ? "an editor and can write with them live" : "a viewer (read-only)"}.</p>
            {user ? (
              <Button className="mt-6 w-full py-2.5" onClick={accept} disabled={busy}>
                Join project
              </Button>
            ) : (
              <div className="mt-6 flex flex-col gap-2">
                <ButtonLink to={`/signup?next=/invite/${token}`} className="py-2.5">
                  Create an account to join
                </ButtonLink>
                <ButtonLink to={`/login?next=/invite/${token}`} kind="ghost">
                  I already have an account
                </ButtonLink>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <EmptyState icon={Compass} title="Page not found" action={<ButtonLink to="/">Go home</ButtonLink>}>
        That page doesn't exist.
      </EmptyState>
    </div>
  );
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <div className="mx-auto max-w-6xl space-y-4 px-4 pt-20">
        <Skeleton className="h-8 w-60" />
        <Skeleton className="h-64" />
      </div>
    );
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <>{children}</>;
}
