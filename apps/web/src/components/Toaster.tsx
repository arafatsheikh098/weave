import { CheckCircle2, CircleAlert, Info, Loader2, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

type Kind = "success" | "error" | "info" | "loading";

interface Toast {
  id: number;
  kind: Kind;
  title: string;
  body?: string;
  action?: { label: string; run: () => void };
}

interface ToastApi {
  show: (t: Omit<Toast, "id">, opts?: { id?: number; duration?: number }) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const ICON = {
  success: <CheckCircle2 size={18} className="text-good" aria-hidden />,
  error: <CircleAlert size={18} className="text-bad" aria-hidden />,
  info: <Info size={18} className="text-accent" aria-hidden />,
  loading: <Loader2 size={18} className="animate-spin text-accent" aria-hidden />,
};

/** Toasts for save/sync/compile status. Updating a toast by id morphs it in place. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const next = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
  }, []);

  const show = useCallback<ToastApi["show"]>(
    (t, opts) => {
      const id = opts?.id ?? next.current++;
      setToasts((ts) => {
        const rest = ts.filter((x) => x.id !== id);
        return [...rest, { ...t, id }].slice(-4);
      });
      clearTimeout(timers.current.get(id));
      const duration = opts?.duration ?? (t.kind === "loading" ? 0 : t.kind === "error" ? 6000 : 3200);
      if (duration > 0) timers.current.set(id, setTimeout(() => dismiss(id), duration));
      return id;
    },
    [dismiss],
  );

  const value = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:right-4 sm:items-end"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className="card toast-in pointer-events-auto flex w-full max-w-sm items-start gap-3 p-3.5 shadow-[var(--lift)]"
          >
            <span className="mt-0.5 shrink-0">{ICON[t.kind]}</span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-ink">{t.title}</div>
              {t.body && <div className="mt-0.5 text-xs leading-snug text-ink-2">{t.body}</div>}
              {t.action && (
                <button
                  className="mt-1.5 text-xs font-semibold text-accent-ink hover:underline"
                  onClick={() => {
                    t.action!.run();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <button onClick={() => dismiss(t.id)} className="shrink-0 rounded-md p-0.5 text-muted hover:text-ink" aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast outside ToastProvider");
  return ctx;
}
