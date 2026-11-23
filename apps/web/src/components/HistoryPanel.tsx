import { Bookmark, Clock, History, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type VersionInfo } from "../lib/api";
import { relativeTime } from "../lib/motion";
import { useToast } from "./Toaster";
import { Button, EmptyState, IconButton, Skeleton } from "./ui";

/** Slide-over panel: name the current state, browse versions, preview and restore. */
export function HistoryPanel({ projectId, canEdit, onClose }: { projectId: string; canEdit: boolean; onClose: () => void }) {
  const toast = useToast();
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; text: string }[] | null>(null);
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(() => {
    api.versions(projectId).then(setVersions, (e: Error) => toast.show({ kind: "error", title: "Couldn't load history", body: e.message }));
  }, [projectId, toast]);
  useEffect(load, [load]);

  const select = (versionId: string | null) => {
    setSelected(versionId);
    setPreview(null);
    setConfirm(false);
    if (versionId) api.version(projectId, versionId).then((v) => setPreview(v.files));
  };

  const save = async () => {
    if (!name.trim()) return;
    await api.createVersion(projectId, name.trim());
    toast.show({ kind: "success", title: "Version saved", body: `“${name.trim()}” is in your history.` });
    setName("");
    load();
  };

  const restore = async () => {
    if (!selected) return;
    const id = toast.show({ kind: "loading", title: "Restoring version…" });
    try {
      await api.restoreVersion(projectId, selected);
      toast.show({ kind: "success", title: "Version restored", body: "Everyone sees the restored text. A backup of the previous state was saved." }, { id });
      select(null);
      load();
    } catch (e) {
      toast.show({ kind: "error", title: "Restore failed", body: (e as Error).message }, { id });
    }
  };

  return (
    <aside className="slide-in-right flex h-full w-full flex-col border-l border-line bg-surface sm:w-96" aria-label="Version history">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <History size={18} className="text-accent" aria-hidden />
        <h2 className="flex-1 font-semibold text-ink">History</h2>
        <IconButton icon={X} label="Close history" onClick={onClose} />
      </div>
      {canEdit && (
        <form
          className="flex gap-2 border-b border-line p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name this version, e.g. “Submitted draft”"
            className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none"
            aria-label="Version name"
          />
          <Button type="submit" size="sm" disabled={!name.trim()}>
            <Bookmark size={14} /> Save
          </Button>
        </form>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!versions && (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        )}
        {versions?.length === 0 && (
          <EmptyState icon={Clock} title="No versions yet">
            Save a named version before a big change. You can restore it any time, and restoring is itself undoable.
          </EmptyState>
        )}
        <ul className="p-2">
          {versions?.map((v) => (
            <li key={v.id}>
              <button
                onClick={() => select(selected === v.id ? null : v.id)}
                className={`flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${selected === v.id ? "bg-accent-wash" : "hover:bg-surface-2"}`}
                aria-expanded={selected === v.id}
              >
                <span className={`mt-1 size-2.5 shrink-0 rounded-full ${v.auto ? "bg-[var(--axis)]" : "bg-gradient"}`} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{v.name}</span>
                  <span className="block text-xs text-muted">
                    {relativeTime(v.createdAt)}
                    {v.author ? ` · ${v.author}` : ""} · {v.files} file{v.files === 1 ? "" : "s"}
                  </span>
                </span>
              </button>
              {selected === v.id && (
                <div className="fade-in mx-3 mb-3 rounded-xl border border-line bg-surface-2 p-3">
                  {!preview && <Skeleton className="h-24" />}
                  {preview?.slice(0, 1).map((f) => (
                    <div key={f.path}>
                      <div className="mb-1 text-[11px] font-semibold text-muted">{f.path}</div>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-ink-2">{f.text.slice(0, 2000)}</pre>
                    </div>
                  ))}
                  {canEdit &&
                    (confirm ? (
                      <div className="mt-3 flex items-center gap-2">
                        <span className="flex-1 text-xs text-ink-2">Replace the current text for everyone?</span>
                        <Button size="sm" kind="ghost" onClick={() => setConfirm(false)}>
                          Cancel
                        </Button>
                        <Button size="sm" onClick={restore}>
                          Restore
                        </Button>
                      </div>
                    ) : (
                      <Button size="sm" kind="secondary" className="mt-3" onClick={() => setConfirm(true)}>
                        <RotateCcw size={14} /> Restore this version
                      </Button>
                    ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
