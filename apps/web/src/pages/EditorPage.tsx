import {
  ArrowLeft,
  CircleAlert,
  Command as CommandIcon,
  Eye,
  FileCode2,
  FilePlus2,
  FileText,
  History,
  Image as ImageIcon,
  Keyboard,
  Loader2,
  Lock,
  Moon,
  PanelLeft,
  Play,
  Redo2,
  Share2,
  Sparkles,
  TriangleAlert,
  Undo2,
  Upload,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import type { FileMeta, WireCursor } from "@weave/protocol";
import { CommandPalette, type Command } from "../components/CommandPalette";
import { FileTree } from "../components/FileTree";
import { HistoryPanel } from "../components/HistoryPanel";
import { ShareDialog } from "../components/ShareDialog";
import { useToast } from "../components/Toaster";
import { Tour, tourDone, type TourStep } from "../components/Tour";
import { Button, EmptyState, IconButton, Kbd, Modal, Skeleton, Spinner, ThemeToggle } from "../components/ui";
import { PresenceStack, SplitPane, StatusPill } from "../components/workspace";
import { CodeEditor, type JumpRequest } from "../editor/CodeEditor";
import { MarkdownPreview } from "../editor/MarkdownPreview";
import { PdfViewer } from "../editor/PdfViewer";
import { api, ApiError, type CompileResult, type Diagnostic, type Project } from "../lib/api";
import { useAuth } from "../lib/auth";
import { modKey, useMediaQuery } from "../lib/motion";
import { useTheme } from "../lib/theme";
import { ProjectConnection, type FileReplica } from "../sync/connection";
import { get as idbGet, set as idbSet } from "idb-keyval";

const pdfKey = (projectId: string) => `weave:pdf:${projectId}`;

const TOUR: TourStep[] = [
  { target: "files", title: "Your project files", body: "Open .tex, .bib and Markdown files here. Drag images in to upload them." },
  { target: "editor", title: "Write together", body: "Everyone's cursor shows up live. Two people can type in the same paragraph at the same time." },
  { target: "compile", title: "Compile to PDF", body: `Press ${modKey} + S, or leave auto-compile on to update the PDF a moment after you stop typing.` },
  { target: "status", title: "Works offline", body: "Lose Wi-Fi? Keep writing. Edits are stored in your browser and merge when you reconnect." },
  { target: "share", title: "Invite collaborators", body: `Share a link with edit or view access. ${modKey} + K opens the command palette for everything else.` },
];

type CompileState = {
  phase: "idle" | "compiling" | "done";
  result: CompileResult | null;
  /** Last PDF that compiled successfully: kept on screen while the source has errors. */
  pdf: string | null;
  at: number | null;
  error: string | null;
};

export function EditorPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { user } = useAuth();
  const userIdRef = useRef(user?.id);
  const toast = useToast();
  const navigate = useNavigate();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [, setTheme] = useTheme();

  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [replica, setReplica] = useState<FileReplica | null>(null);
  const [sidebar, setSidebar] = useState(!isMobile);
  const [mobileTab, setMobileTab] = useState<"source" | "preview">("source");
  const [palette, setPalette] = useState(false);
  const [share, setShare] = useState(false);
  const [history, setHistory] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [newFile, setNewFile] = useState(false);
  const [tour, setTour] = useState(false);
  const [jump, setJump] = useState<JumpRequest | null>(null);
  const [compile, setCompile] = useState<CompileState>({ phase: "idle", result: null, pdf: null, at: null, error: null });
  const [autoCompile, setAutoCompile] = useState(() => localStorage.getItem("weave-autocompile") !== "0");
  const [showErrors, setShowErrors] = useState(false);
  const [editAnyway, setEditAnyway] = useState(false);

  const reload = useCallback(() => {
    api.project(id).then(setProject, (e: ApiError) => setLoadError(e.status === 404 ? "This project doesn't exist, or you don't have access." : e.message));
  }, [id]);
  useEffect(reload, [reload]);

  // ---- Connection ------------------------------------------------------------------------
  const conn = useMemo(
    () =>
      new ProjectConnection(id, {
        error: (message) => toast.show({ kind: "error", title: "Sync problem", body: message }),
        peerJoined: (p) => toast.show({ kind: "info", title: `${p.name} joined`, body: p.role === "viewer" ? "Viewing only" : "You'll see their cursor live." }),
        peerLeft: (p) => toast.show({ kind: "info", title: `${p.name} left` }, { duration: 2200 }),
        files: (files) => setProject((p) => (p ? { ...p, files } : p)),
        project: (meta) => setProject((p) => (p ? { ...p, name: meta.name, mainFile: meta.mainFile } : p)),
        compiled: (by, byUserId, ok) =>
          byUserId !== userIdRef.current &&
          toast.show({ kind: ok ? "info" : "error", title: `${by} compiled the PDF`, body: ok ? undefined : "It has errors.", action: { label: "Refresh my preview", run: () => void runCompileRef.current(false) } }),
        removed: (reason) => {
          toast.show({ kind: "error", title: "You left the project", body: reason });
          navigate("/projects");
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id],
  );
  useEffect(() => () => conn.close(), [conn]);
  useSyncExternalStore(conn.subscribe, conn.getVersion);
  const status = conn.status;
  const unsynced = conn.unsynced;
  const peers = [...conn.peers.values()];
  const role = project?.role ?? "viewer";
  const readOnly = role === "viewer" || (isMobile && !editAnyway);

  // Online/offline toasts.
  const prevStatus = useRef(status);
  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = status;
    if (prev === "live" && status === "offline") {
      toast.show({ kind: "info", title: "You're offline", body: "Keep writing. Your edits are saved in this browser and sync when you're back." }, { id: 9001, duration: 5000 });
    } else if (prev !== "live" && status === "live" && prev !== "connecting") {
      toast.show({ kind: "success", title: "Back online", body: unsynced ? `Syncing ${unsynced} offline edit${unsynced === 1 ? "" : "s"}…` : "Everything is in sync." }, { id: 9001 });
    }
  }, [status, unsynced, toast]);

  // ---- Active file -------------------------------------------------------------------------
  const files = useMemo(() => project?.files ?? [], [project]);
  const active: FileMeta | undefined =
    files.find((f) => f.id === params.get("file")) ?? files.find((f) => f.path === project?.mainFile) ?? files.find((f) => f.kind === "text");
  const openFile = useCallback((f: FileMeta) => setParams({ file: f.id }, { replace: true }), [setParams]);

  const activeId = active?.id;
  const activeIsText = active?.kind === "text";
  useEffect(() => {
    if (!activeId || !activeIsText) return;
    let cancelled = false;
    conn.openFile(activeId).then((r) => !cancelled && setReplica(r));
    return () => {
      cancelled = true;
      setReplica(null);
    };
  }, [conn, activeId, activeIsText]);

  // Opt-in hook for end-to-end tests (localStorage "weave-debug" = "1"): read the live replica.
  useEffect(() => {
    if (!replica) return;
    try {
      if (localStorage.getItem("weave-debug") === "1") (window as unknown as { __weave: unknown }).__weave = { doc: replica.doc, conn };
    } catch {
      /* ignore */
    }
  }, [replica, conn]);

  const isLatex = !!project && project.mainFile.endsWith(".tex") && files.some((f) => f.path === project.mainFile);
  const isMarkdown = !!active && /\.(md|markdown)$/i.test(active.path);

  // ---- Compile -----------------------------------------------------------------------------
  const runCompile = useCallback(
    async (manual: boolean) => {
      if (!isLatex) return;
      if (conn.status !== "live") {
        if (manual) toast.show({ kind: "error", title: "Can't compile offline", body: "Your edits are safe; compile once you're back online." });
        return;
      }
      // Wait (briefly) for our latest edits to reach the server, which compiles its copy.
      for (let i = 0; i < 30 && conn.unsynced > 0; i++) await new Promise((r) => setTimeout(r, 100));
      setCompile((c) => ({ ...c, phase: "compiling", error: null }));
      const tid = manual ? toast.show({ kind: "loading", title: "Compiling…" }) : null;
      try {
        const result = await api.compile(id, manual);
        setCompile((c) => ({ phase: "done", result, pdf: result.pdf ?? c.pdf, at: Date.now(), error: null }));
        // Keep the latest good PDF in this browser, so the preview still shows it offline.
        if (result.pdf) idbSet(pdfKey(id), result.pdf).catch(() => {});
        const errors = result.diagnostics.filter((d) => d.level === "error").length;
        if (tid !== null) {
          if (result.ok) toast.show({ kind: "success", title: "PDF ready", body: result.cached ? "Nothing changed since the last compile." : `Compiled in ${(result.ms / 1000).toFixed(1)} s.` }, { id: tid });
          else toast.show({ kind: "error", title: `${errors || "Some"} error${errors === 1 ? "" : "s"} in your LaTeX`, body: result.diagnostics[0]?.message, action: { label: "Show errors", run: () => setShowErrors(true) } }, { id: tid });
        }
        if (!result.ok) setShowErrors(true);
      } catch (e) {
        setCompile((c) => ({ ...c, phase: "done", error: (e as Error).message }));
        if (tid !== null) toast.show({ kind: "error", title: "Compile failed", body: (e as Error).message }, { id: tid });
      }
    },
    [conn, id, isLatex, toast],
  );
  // Show the last saved PDF straight away (it is replaced as soon as a fresh compile finishes).
  useEffect(() => {
    let alive = true;
    idbGet<string>(pdfKey(id))
      .then((saved) => {
        if (alive && saved) setCompile((c) => (c.pdf ? c : { ...c, pdf: saved }));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id]);

  const runCompileRef = useRef(runCompile);
  runCompileRef.current = runCompile;

  // First compile when the project opens.
  const compiledOnce = useRef(false);
  useEffect(() => {
    if (isLatex && status === "live" && !compiledOnce.current) {
      compiledOnce.current = true;
      void runCompile(false);
    }
  }, [isLatex, status, runCompile]);

  // Auto-compile a moment after typing stops (on anyone's edits).
  useEffect(() => {
    if (!replica || !autoCompile || !isLatex) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = replica.doc.onChange(() => {
      if (t) clearTimeout(t);
      t = setTimeout(() => void runCompileRef.current(false), 1500);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, [replica, autoCompile, isLatex]);

  const diagnostics = useMemo(() => compile.result?.diagnostics ?? [], [compile.result]);
  const errorCount = diagnostics.filter((d) => d.level === "error").length;
  const warningCount = diagnostics.length - errorCount;
  const fileDiagnostics = useMemo(() => (active ? diagnostics.filter((d) => d.file === active.path) : []), [diagnostics, active]);

  const goToDiagnostic = (d: Diagnostic) => {
    const f = files.find((x) => x.path === d.file);
    if (f && f.id !== active?.id) openFile(f);
    if (d.line) setTimeout(() => setJump({ line: d.line!, nonce: Date.now() }), f && f.id !== active?.id ? 250 : 0);
  };

  // ---- File actions ------------------------------------------------------------------------
  const upload = async (list: FileList) => {
    for (const file of Array.from(list)) {
      const tid = toast.show({ kind: "loading", title: `Uploading ${file.name}…` });
      try {
        const res = await api.upload(id, file);
        toast.show({ kind: "success", title: "Uploaded", body: `Use \\includegraphics{${res.path}}` }, { id: tid });
      } catch (e) {
        toast.show({ kind: "error", title: `Couldn't upload ${file.name}`, body: (e as Error).message }, { id: tid });
      }
    }
  };
  const rename = async (f: FileMeta) => {
    const path = prompt("Rename file", f.path)?.trim();
    if (!path || path === f.path) return;
    try {
      await api.renameFile(id, f.id, path);
      if (f.path === project?.mainFile) await api.updateProject(id, { mainFile: path });
      toast.show({ kind: "success", title: "Renamed", body: path });
    } catch (e) {
      toast.show({ kind: "error", title: "Rename failed", body: (e as Error).message });
    }
  };
  const remove = async (f: FileMeta) => {
    if (!confirm(`Delete ${f.path} for everyone?`)) return;
    try {
      await api.deleteFile(id, f.id);
      await conn.dropFile(f.id);
      toast.show({ kind: "success", title: "Deleted", body: f.path });
    } catch (e) {
      toast.show({ kind: "error", title: "Delete failed", body: (e as Error).message });
    }
  };
  const setMain = async (f: FileMeta) => {
    await api.updateProject(id, { mainFile: f.path });
    toast.show({ kind: "success", title: "Main file changed", body: `${f.path} is compiled now.` });
  };

  const onCursor = useCallback((cursor: WireCursor) => conn.setPresence(active?.id ?? null, cursor), [conn, active?.id]);

  // ---- Keyboard shortcuts ------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        void runCompileRef.current(true);
      } else if (k === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (k === "/") {
        e.preventDefault();
        setShortcuts(true);
      } else if (k === "b" && !e.shiftKey) {
        e.preventDefault();
        setSidebar((s) => !s);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // First-run tour once the editor is on screen.
  useEffect(() => {
    if (project && replica && !isMobile && !tourDone()) {
      const t = setTimeout(() => setTour(true), 900);
      return () => clearTimeout(t);
    }
  }, [project, replica, isMobile]);

  const commands: Command[] = useMemo(
    () => [
      ...(isLatex ? [{ id: "compile", label: "Compile PDF", group: "Actions", icon: Play, shortcut: `${modKey} S`, run: () => void runCompile(true) }] : []),
      { id: "share", label: "Share project…", group: "Actions", icon: Share2, run: () => setShare(true) },
      { id: "history", label: "Version history", group: "Actions", icon: History, run: () => setHistory(true) },
      ...(role !== "viewer"
        ? [
            { id: "new", label: "New file…", group: "Actions", icon: FilePlus2, run: () => setNewFile(true) },
            { id: "upload", label: "Upload image…", group: "Actions", icon: Upload, run: () => document.querySelector<HTMLInputElement>('[data-tour="files"] input[type=file]')?.click() },
            { id: "undo", label: "Undo my last edit", group: "Edit", icon: Undo2, shortcut: `${modKey} Z`, run: () => replica?.undo.undo() },
            { id: "redo", label: "Redo", group: "Edit", icon: Redo2, shortcut: `${modKey} ⇧ Z`, run: () => replica?.undo.redo() },
          ]
        : []),
      ...(isLatex
        ? [{ id: "auto", label: autoCompile ? "Turn off auto-compile" : "Turn on auto-compile", group: "Preferences", icon: Zap, run: () => toggleAuto() }]
        : []),
      { id: "sidebar", label: "Toggle file sidebar", group: "View", icon: PanelLeft, shortcut: `${modKey} B`, run: () => setSidebar((s) => !s) },
      { id: "dark", label: "Toggle dark mode", group: "View", icon: Moon, run: () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark") },
      { id: "keys", label: "Keyboard shortcuts", group: "Help", icon: Keyboard, shortcut: `${modKey} /`, run: () => setShortcuts(true) },
      { id: "tour", label: "Show the welcome tour again", group: "Help", icon: Sparkles, run: () => setTour(true) },
      ...files.map((f) => ({
        id: `file:${f.id}`,
        label: f.path,
        group: "Files",
        icon: f.kind === "binary" ? ImageIcon : f.path.endsWith(".tex") ? FileCode2 : FileText,
        run: () => openFile(f),
      })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, isLatex, role, replica, autoCompile, runCompile, openFile],
  );

  function toggleAuto() {
    setAutoCompile((a) => {
      localStorage.setItem("weave-autocompile", a ? "0" : "1");
      toast.show({ kind: "info", title: a ? "Auto-compile off" : "Auto-compile on", body: a ? `Press ${modKey} + S to compile.` : "The PDF updates as you type." });
      return !a;
    });
  }

  // ---- Render --------------------------------------------------------------------------------
  if (loadError) {
    return (
      <div className="grid min-h-dvh place-items-center p-6">
        <EmptyState icon={Lock} title="Can't open this project" action={<Button onClick={() => navigate("/projects")}>Back to projects</Button>}>
          {loadError}
        </EmptyState>
      </div>
    );
  }
  if (!project || !user) return <EditorSkeleton />;

  const fileNames = new Map(files.map((f) => [f.id, f.path]));
  const editorPane = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-xs text-ink-2">
        {active ? (
          <>
            <span className="truncate font-medium text-ink">{active.path}</span>
            {readOnly && (
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5">
                <Eye size={12} /> Read-only
              </span>
            )}
            <div className="flex-1" />
            {replica && role !== "viewer" && !readOnly && (
              <>
                <IconButton icon={Undo2} label="Undo my last edit" shortcut={`${modKey} Z`} className="size-7" onClick={() => replica.undo.undo()} />
                <IconButton icon={Redo2} label="Redo" shortcut={`${modKey} ⇧ Z`} className="size-7" onClick={() => replica.undo.redo()} />
              </>
            )}
          </>
        ) : (
          <span>No file open</span>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        {active?.kind === "binary" ? (
          <div className="grid h-full place-items-center overflow-auto bg-surface-2 p-6">
            {active.mime === "application/pdf" ? (
              <object data={api.rawUrl(id, active.id)} type="application/pdf" className="h-full w-full rounded-lg" aria-label={active.path}>
                <a href={api.rawUrl(id, active.id)} className="text-accent-ink underline">
                  Open {active.path}
                </a>
              </object>
            ) : (
              <img src={api.rawUrl(id, active.id)} alt={active.path} className="max-h-full max-w-full rounded-lg shadow-[var(--lift)]" />
            )}
          </div>
        ) : replica && active ? (
          <CodeEditor key={replica.fileId} replica={replica} path={active.path} readOnly={readOnly} peers={peers} diagnostics={fileDiagnostics} jump={jump} onCursor={onCursor} />
        ) : active ? (
          <div className="space-y-2 p-4">
            {[90, 70, 80, 40, 85, 60].map((w) => (
              <Skeleton key={w} className="h-4" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : (
          <EmptyState icon={FileText} title="No files yet" action={role !== "viewer" && <Button onClick={() => setNewFile(true)}>New file</Button>}>
            Create a .tex or .md file to start writing.
          </EmptyState>
        )}
      </div>
      {showErrors && diagnostics.length > 0 && (
        <DiagnosticsPanel diagnostics={diagnostics} onPick={goToDiagnostic} onClose={() => setShowErrors(false)} />
      )}
    </div>
  );

  const previewPane = isMarkdown && replica ? (
    <MarkdownPreview key={replica.fileId} doc={replica.doc} projectId={id} files={files} />
  ) : isLatex ? (
    <PdfViewer
      pdf={compile.pdf}
      name={project.name}
      compiling={compile.phase === "compiling"}
      stale={!!compile.result && !compile.result.ok && !!compile.pdf}
      onShowErrors={() => setShowErrors(true)}
    />
  ) : (
    <EmptyState icon={FileText} title="Nothing to preview">
      Open a Markdown file, or add a main .tex file to get a PDF preview.
    </EmptyState>
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface/80 px-2 backdrop-blur-xl sm:gap-3 sm:px-3">
        <Link to="/projects" className="grid size-9 place-items-center rounded-xl text-ink-2 hover:bg-surface-2 hover:text-ink" aria-label="Back to projects" title="Back to projects">
          <ArrowLeft size={18} />
        </Link>
        {!isMobile && <IconButton icon={PanelLeft} label="Toggle files" shortcut={`${modKey} B`} active={sidebar} onClick={() => setSidebar((s) => !s)} />}
        <ProjectName key={project.name} name={project.name} canEdit={role !== "viewer"} onRename={async (name) => {
          await api.updateProject(id, { name });
          setProject((p) => (p ? { ...p, name } : p));
        }} />
        <div className="hidden md:block">
          <StatusPill status={status} unsynced={unsynced} />
        </div>
        <div className="flex-1" />
        <div className="hidden sm:block">
          <PresenceStack peers={peers} me={{ name: user.displayName, color: user.color }} fileNames={fileNames} />
        </div>
        <button
          onClick={() => setPalette(true)}
          className="hidden items-center gap-2 rounded-xl border border-line bg-surface px-2.5 py-1.5 text-xs text-muted transition-colors hover:text-ink lg:inline-flex"
          aria-label="Open command palette"
        >
          <CommandIcon size={13} /> Commands <Kbd>{modKey} K</Kbd>
        </button>
        <IconButton icon={History} label="Version history" active={history} onClick={() => setHistory((h) => !h)} />
        <span data-tour="share">
          <Button kind="secondary" size="sm" onClick={() => setShare(true)} className="py-2">
            <Share2 size={15} /> <span className="hidden sm:inline">Share</span>
          </Button>
        </span>
        {isLatex && (
          <CompileButton state={compile} errors={errorCount} warnings={warningCount} auto={autoCompile} onCompile={() => void runCompile(true)} onToggleAuto={toggleAuto} onShowErrors={() => setShowErrors((s) => !s)} />
        )}
        <span className="hidden sm:block">
          <ThemeToggle />
        </span>
      </header>
      {isMobile && (
        <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-2">
          <StatusPill status={status} unsynced={unsynced} />
          <div className="flex-1" />
          <select
            value={active?.id ?? ""}
            onChange={(e) => {
              const f = files.find((x) => x.id === e.target.value);
              if (f) openFile(f);
            }}
            className="max-w-[45%] rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink"
            aria-label="File"
          >
            {files.map((f) => (
              <option key={f.id} value={f.id}>
                {f.path}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Body */}
      <div className="relative flex min-h-0 flex-1">
        {sidebar && !isMobile && (
          <nav className="w-60 shrink-0 border-r border-line bg-surface" aria-label="Files">
            <FileTree
              files={files}
              activeId={active?.id ?? null}
              mainFile={project.mainFile}
              peers={peers}
              canEdit={role !== "viewer"}
              onOpen={openFile}
              onCreate={() => setNewFile(true)}
              onUpload={(l) => void upload(l)}
              onRename={(f) => void rename(f)}
              onDelete={(f) => void remove(f)}
              onSetMain={(f) => void setMain(f)}
            />
          </nav>
        )}
        <main className="min-w-0 flex-1">
          {isMobile ? (
            <div className="flex h-full flex-col">
              <div className="flex gap-1 border-b border-line bg-surface p-1.5" role="tablist" aria-label="View">
                {(["source", "preview"] as const).map((t) => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={mobileTab === t}
                    onClick={() => setMobileTab(t)}
                    className={`flex-1 rounded-lg py-1.5 text-sm font-medium capitalize transition-colors ${mobileTab === t ? "bg-gradient text-white" : "text-ink-2"}`}
                  >
                    {t === "source" ? "Source" : isLatex ? "PDF" : "Preview"}
                  </button>
                ))}
              </div>
              {mobileTab === "source" && role !== "viewer" && !editAnyway && (
                <div className="flex items-center gap-2 bg-accent-wash px-3 py-2 text-xs text-accent-ink">
                  <Eye size={14} /> Read-only on small screens.
                  <button className="ml-auto font-semibold underline" onClick={() => setEditAnyway(true)}>
                    Edit anyway
                  </button>
                </div>
              )}
              <div className="min-h-0 flex-1">{mobileTab === "source" ? editorPane : previewPane}</div>
            </div>
          ) : (
            <SplitPane storageKey="weave-split" left={editorPane} right={previewPane} />
          )}
        </main>
        {history && (
          <div className="absolute inset-y-0 right-0 z-30 flex w-full justify-end sm:w-auto">
            <HistoryPanel projectId={id} canEdit={role !== "viewer"} onClose={() => setHistory(false)} />
          </div>
        )}
      </div>

      <CommandPalette open={palette} onClose={() => setPalette(false)} commands={commands} />
      <ShareDialog open={share} onClose={() => setShare(false)} projectId={id} members={project.members} myRole={role} meId={user.id} onChanged={reload} />
      <NewFileDialog
        open={newFile}
        onClose={() => setNewFile(false)}
        onCreate={async (path) => {
          const res = await api.createFile(id, path, path.endsWith(".tex") ? "% New section\n" : "");
          setNewFile(false);
          setParams({ file: res.id }, { replace: true });
          toast.show({ kind: "success", title: "File created", body: path.endsWith(".tex") ? `Include it with \\input{${path.replace(/\.tex$/, "")}}` : path });
        }}
      />
      <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} />
      {tour && <Tour steps={TOUR} onDone={() => setTour(false)} />}
    </div>
  );
}

function ProjectName({ name, canEdit, onRename }: { name: string; canEdit: boolean; onRename: (n: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  if (!editing) {
    return (
      <button
        className="min-w-0 max-w-[40vw] truncate rounded-lg px-2 py-1 text-left font-semibold text-ink hover:bg-surface-2 disabled:hover:bg-transparent"
        onClick={() => canEdit && setEditing(true)}
        disabled={!canEdit}
        title={canEdit ? "Rename project" : name}
      >
        {name}
      </button>
    );
  }
  const commit = async () => {
    setEditing(false);
    if (value.trim() && value.trim() !== name) await onRename(value.trim());
  };
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") void commit();
        if (e.key === "Escape") {
          setValue(name);
          setEditing(false);
        }
      }}
      className="min-w-0 max-w-[40vw] rounded-lg border border-accent bg-surface px-2 py-1 font-semibold text-ink focus:outline-none"
      aria-label="Project name"
      maxLength={120}
    />
  );
}

function CompileButton({
  state,
  errors,
  warnings,
  auto,
  onCompile,
  onToggleAuto,
  onShowErrors,
}: {
  state: CompileState;
  errors: number;
  warnings: number;
  auto: boolean;
  onCompile: () => void;
  onToggleAuto: () => void;
  onShowErrors: () => void;
}) {
  const busy = state.phase === "compiling";
  return (
    <div className="flex items-center gap-1" data-tour="compile">
      {state.phase === "done" && (errors > 0 || warnings > 0 || state.error) && (
        <button
          onClick={onShowErrors}
          className={`pop hidden items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium sm:inline-flex ${errors || state.error ? "text-bad" : "text-warn"} hover:bg-surface-2`}
          title="Show compile messages"
        >
          {errors || state.error ? <CircleAlert size={14} /> : <TriangleAlert size={14} />}
          {state.error ? "Failed" : errors ? `${errors} error${errors === 1 ? "" : "s"}` : `${warnings} warning${warnings === 1 ? "" : "s"}`}
        </button>
      )}
      <div className="flex overflow-hidden rounded-xl shadow-[0_6px_20px_-6px_var(--accent)]">
        <button onClick={onCompile} disabled={busy} className="bg-gradient inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-80" title={`Compile (${modKey} S)`}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} className="fill-current" />}
          <span className="hidden sm:inline">{busy ? "Compiling" : "Compile"}</span>
        </button>
        <button
          onClick={onToggleAuto}
          aria-pressed={auto}
          title={auto ? "Auto-compile is on" : "Auto-compile is off"}
          aria-label="Toggle auto-compile"
          className={`border-l border-white/25 px-2 text-white transition ${auto ? "bg-gradient" : "bg-[var(--muted)]"}`}
        >
          <Zap size={14} className={auto ? "fill-current" : ""} />
        </button>
      </div>
    </div>
  );
}

function DiagnosticsPanel({ diagnostics, onPick, onClose }: { diagnostics: Diagnostic[]; onPick: (d: Diagnostic) => void; onClose: () => void }) {
  return (
    <div className="slide-in-right max-h-[38%] shrink-0 overflow-y-auto border-t border-line bg-surface" role="region" aria-label="Compile messages">
      <div className="sticky top-0 flex items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <CircleAlert size={14} className="text-bad" />
        <span className="flex-1 text-xs font-semibold text-ink">Compile messages</span>
        <button onClick={onClose} className="text-xs font-medium text-ink-2 hover:text-ink">
          Hide
        </button>
      </div>
      <ul>
        {diagnostics.map((d, i) => (
          <li key={i}>
            <button onClick={() => onPick(d)} className="flex w-full items-start gap-2 px-3 py-2 text-left text-xs hover:bg-surface-2">
              {d.level === "error" ? <CircleAlert size={14} className="mt-0.5 shrink-0 text-bad" /> : <TriangleAlert size={14} className="mt-0.5 shrink-0 text-warn" />}
              <span className="min-w-0 flex-1 text-ink">{d.message}</span>
              <span className="tabular shrink-0 font-mono text-muted">
                {d.file}
                {d.line ? `:${d.line}` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NewFileDialog({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (path: string) => Promise<void> }) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => {
    setPath("");
    setError(null);
    onClose();
  };
  return (
    <Modal open={open} onClose={close} title="New file" description="Use folders with a slash, e.g. chapters/intro.tex" icon={FilePlus2}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onCreate(path.trim());
            setPath("");
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="mb-3 flex flex-wrap gap-1.5">
          {["chapters/intro.tex", "refs.bib", "notes.md", "appendix.tex"].map((s) => (
            <button key={s} type="button" onClick={() => setPath(s)} className="rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-2 hover:border-accent hover:text-ink">
              {s}
            </button>
          ))}
        </div>
        <input
          autoFocus
          value={path}
          onChange={(e) => {
            setPath(e.target.value);
            setError(null);
          }}
          placeholder="section.tex"
          className="block w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-ink focus:border-accent focus:shadow-[0_0_0_4px_var(--accent-wash)] focus:outline-none"
          aria-label="File path"
          aria-invalid={!!error}
        />
        {error && <p className="mt-1.5 text-xs text-bad">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" kind="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" disabled={!path.trim() || busy}>
            {busy ? <Spinner size={14} className="border-white/40 border-t-white" /> : <FilePlus2 size={16} />} Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const SHORTCUTS: [string, string][] = [
  [`${modKey} S`, "Compile PDF"],
  [`${modKey} K`, "Command palette (actions and files)"],
  [`${modKey} Z`, "Undo your last edit (never a collaborator's)"],
  [`${modKey} ⇧ Z`, "Redo"],
  [`${modKey} F`, "Find in file"],
  [`${modKey} B`, "Toggle the file sidebar"],
  [`${modKey} /`, "This list"],
  ["Ctrl Space", "LaTeX autocompletion"],
  ["← → on the divider", "Resize editor and preview"],
];

function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" icon={Keyboard}>
      <ul className="divide-y divide-[var(--border)]">
        {SHORTCUTS.map(([k, label]) => (
          <li key={label} className="flex items-center justify-between gap-4 py-2.5 text-sm">
            <span className="text-ink">{label}</span>
            <Kbd>{k}</Kbd>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function EditorSkeleton() {
  return (
    <div className="flex h-dvh flex-col" aria-label="Loading project">
      <div className="flex h-14 items-center gap-3 border-b border-line px-4">
        <Skeleton className="h-6 w-40" />
        <div className="flex-1" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-28" />
      </div>
      <div className="flex flex-1">
        <div className="hidden w-60 space-y-2 border-r border-line p-3 md:block">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-6" />
          ))}
        </div>
        <div className="flex-1 space-y-3 p-6">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-4" />
          ))}
        </div>
        <div className="hidden flex-1 bg-surface-2 p-6 md:block">
          <Skeleton className="mx-auto aspect-[1/1.3] max-w-md" />
        </div>
      </div>
    </div>
  );
}
