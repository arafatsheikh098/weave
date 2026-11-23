import { FolderOpen, LogOut, MoreHorizontal, Plus, Search, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { TemplateGallery, TemplateThumb } from "../components/TemplateGallery";
import { useToast } from "../components/Toaster";
import { Avatar, Button, EmptyState, Logo, Skeleton, ThemeToggle } from "../components/ui";
import { api, type ProjectSummary } from "../lib/api";
import { useAuth } from "../lib/auth";
import { delay, relativeTime } from "../lib/motion";

const ACCENT: Record<string, string> = { article: "blue", ieee: "violet", beamer: "orange", cv: "green", notes: "aqua" };

export function ProjectsPage() {
  const { user, logout } = useAuth();
  const toast = useToast();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [gallery, setGallery] = useState(false);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<string | null>(null);

  const load = useCallback(() => {
    api.projects().then(setProjects, (e: Error) => {
      setProjects([]);
      toast.show({ kind: "error", title: "Couldn't load projects", body: e.message });
    });
  }, [toast]);
  useEffect(load, [load]);

  const shown = useMemo(() => projects?.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())) ?? null, [projects, query]);

  const remove = async (p: ProjectSummary) => {
    setMenu(null);
    if (!confirm(`Delete “${p.name}” for everyone? This can't be undone.`)) return;
    try {
      await api.deleteProject(p.id);
      toast.show({ kind: "success", title: "Project deleted" });
      load();
    } catch (e) {
      toast.show({ kind: "error", title: "Couldn't delete", body: (e as Error).message });
    }
  };

  const leave = async (p: ProjectSummary) => {
    setMenu(null);
    try {
      await api.removeMember(p.id, user!.id);
      toast.show({ kind: "info", title: `You left “${p.name}”` });
      load();
    } catch (e) {
      toast.show({ kind: "error", title: "Couldn't leave", body: (e as Error).message });
    }
  };

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-line bg-page/75 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <Logo to="/projects" />
          <div className="flex-1" />
          <ThemeToggle />
          {user && (
            <div className="flex items-center gap-2">
              <Avatar name={user.displayName} color={user.color} size={30} />
              <span className="hidden text-sm font-medium text-ink sm:inline">{user.displayName}</span>
              <button onClick={() => void logout()} className="grid size-9 place-items-center rounded-xl text-ink-2 hover:bg-surface-2 hover:text-ink" aria-label="Sign out" title="Sign out">
                <LogOut size={16} />
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-20 pt-8">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="rise text-3xl font-bold tracking-tight text-ink">Your projects</h1>
            <p className="rise mt-1 text-ink-2" style={delay(60)}>
              {projects?.length ? `${projects.length} project${projects.length === 1 ? "" : "s"}. Pick up where you left off.` : "Everything you write together lives here."}
            </p>
          </div>
          {!!projects?.length && (
            <label className="relative">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search projects"
                aria-label="Search projects"
                className="w-56 rounded-xl border border-line bg-surface py-2 pl-9 pr-3 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none"
              />
            </label>
          )}
          <Button onClick={() => setGallery(true)}>
            <Plus size={16} /> New project
          </Button>
        </div>

        {!shown && (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-64" />
            ))}
          </div>
        )}

        {projects?.length === 0 && (
          <div className="card mt-8">
            <EmptyState
              icon={FolderOpen}
              title="Start your first project"
              action={
                <Button onClick={() => setGallery(true)} className="px-5 py-2.5">
                  <Plus size={16} /> Choose a template
                </Button>
              }
            >
              Pick an IEEE paper, article, slides, CV or notes template. Then share a link so co-authors can write with you live.
            </EmptyState>
          </div>
        )}

        {shown && shown.length > 0 && (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <button
              onClick={() => setGallery(true)}
              className="rise group flex min-h-64 flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-line text-ink-2 transition-colors hover:border-accent hover:text-accent-ink"
            >
              <span className="grid size-12 place-items-center rounded-2xl bg-surface-2 transition-transform group-hover:scale-110 group-hover:bg-accent-wash">
                <Plus size={22} />
              </span>
              <span className="text-sm font-medium">New project</span>
            </button>
            {shown.map((p, i) => (
              <div key={p.id} className="card card-hover rise group relative overflow-hidden" style={delay((i + 1) * 50)}>
                <Link to={`/p/${p.id}`} className="block" aria-label={`Open ${p.name}`}>
                  <div className="relative overflow-hidden">
                    <div className="transition-transform duration-300 group-hover:scale-[1.03]">
                      <TemplateThumb id={p.template ?? "article"} accent={ACCENT[p.template ?? ""] ?? "blue"} />
                    </div>
                    {p.online > 0 && (
                      <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-surface/90 px-2 py-0.5 text-[11px] font-semibold text-good backdrop-blur">
                        <span className="pulse-dot size-1.5 rounded-full bg-[var(--good)]" /> {p.online} editing now
                      </span>
                    )}
                  </div>
                  <div className="border-t border-line p-4">
                    <div className="truncate font-semibold text-ink">{p.name}</div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted">
                      <span>Edited {relativeTime(p.updatedAt)}</span>
                      <span aria-hidden>·</span>
                      <span className="capitalize">{p.role}</span>
                    </div>
                    <div className="mt-3 flex items-center gap-2">
                      <div className="flex -space-x-1.5">
                        {(p.people ?? []).slice(0, 4).map((m, k) => (
                          <Avatar key={k} name={m.name} color={m.color} size={22} ring />
                        ))}
                      </div>
                      <span className="inline-flex items-center gap-1 text-xs text-ink-2">
                        <Users size={12} /> {p.members}
                      </span>
                    </div>
                  </div>
                </Link>
                <button
                  className="absolute right-2 top-2 grid size-8 place-items-center rounded-lg bg-surface/90 text-ink-2 opacity-0 backdrop-blur transition-opacity hover:text-ink focus:opacity-100 group-hover:opacity-100"
                  aria-label={`Actions for ${p.name}`}
                  aria-haspopup="menu"
                  onClick={() => setMenu(menu === p.id ? null : p.id)}
                >
                  <MoreHorizontal size={16} />
                </button>
                {menu === p.id && (
                  <div role="menu" className="card pop absolute right-2 top-11 z-10 w-44 p-1 text-sm shadow-[var(--lift)]" onMouseLeave={() => setMenu(null)}>
                    {p.role === "owner" ? (
                      <button role="menuitem" onClick={() => void remove(p)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-bad hover:bg-surface-2">
                        <Trash2 size={14} /> Delete project
                      </button>
                    ) : (
                      <button role="menuitem" onClick={() => void leave(p)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ink hover:bg-surface-2">
                        <LogOut size={14} /> Leave project
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {shown?.length === 0 && !!projects?.length && <p className="mt-10 text-center text-sm text-muted">No projects match “{query}”.</p>}
      </main>
      <TemplateGallery open={gallery} onClose={() => setGallery(false)} />
    </div>
  );
}
