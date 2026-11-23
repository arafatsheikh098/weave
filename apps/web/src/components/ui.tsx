import { Monitor, Moon, Sun, X, type LucideIcon } from "lucide-react";
import { forwardRef, useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { Link } from "react-router";
import { useTheme, type Theme } from "../lib/theme";

const base =
  "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-all active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 select-none";
const kinds = {
  primary: "bg-gradient text-white shadow-[0_6px_20px_-6px_var(--accent)] hover:shadow-[0_10px_28px_-8px_var(--accent)] hover:brightness-110",
  secondary: "border border-line bg-surface text-ink hover:bg-surface-2",
  ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
  danger: "bg-bad text-white hover:brightness-110",
} as const;

export type ButtonKind = keyof typeof kinds;

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { kind?: ButtonKind; size?: "sm" | "md" }>(
  function Button({ kind = "primary", size = "md", className = "", ...props }, ref) {
    return <button ref={ref} className={`${base} ${kinds[kind]} ${size === "sm" ? "px-3 py-1.5 text-xs" : ""} ${className}`} {...props} />;
  },
);

export function ButtonLink({ to, kind = "primary", className = "", children }: { to: string; kind?: ButtonKind; className?: string; children: ReactNode }) {
  return (
    <Link to={to} className={`${base} ${kinds[kind]} ${className}`}>
      {children}
    </Link>
  );
}

/** Square icon button; `label` is both the accessible name and the hover tooltip. */
export function IconButton({
  icon: Icon,
  label,
  shortcut,
  active,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; shortcut?: string; active?: boolean }) {
  return (
    <button
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-pressed={active}
      className={`grid size-9 shrink-0 place-items-center rounded-xl text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40 ${
        active ? "bg-accent-wash text-accent-ink" : ""
      } ${className}`}
      {...props}
    >
      <Icon size={17} aria-hidden />
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-sans text-[11px] font-medium text-ink-2 shadow-[inset_0_-1px_0_var(--border)]">
      {children}
    </kbd>
  );
}

export function Spinner({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block animate-spin rounded-full border-2 border-line border-t-accent ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

export function Skeleton({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`skeleton ${className}`} style={style} aria-hidden />;
}

export function Avatar({ name, color, size = 28, ring = false, title }: { name: string; color: string; size?: number; ring?: boolean; title?: string }) {
  return (
    <span
      title={title ?? name}
      className={`inline-grid shrink-0 place-items-center rounded-full font-semibold uppercase text-white ${ring ? "ring-2 ring-[var(--surface)]" : ""}`}
      style={{ width: size, height: size, background: color, fontSize: size * 0.4 }}
      aria-label={title ?? name}
    >
      {name.trim()[0] ?? "?"}
    </span>
  );
}

export function Logo({ to = "/", compact = false }: { to?: string; compact?: boolean }) {
  return (
    <Link to={to} className="group flex items-center gap-2 font-semibold tracking-tight text-ink" aria-label="Weave home">
      <span className="bg-gradient grid size-8 place-items-center rounded-xl text-white shadow-[0_6px_16px_-6px_var(--accent)] transition-transform group-hover:-rotate-6 group-hover:scale-105">
        <svg viewBox="0 0 32 32" width="20" height="20" aria-hidden>
          <path d="M5 11c4 0 6 10 11 10s7-10 11-10" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          <path d="M5 21c4 0 6-10 11-10s7 10 11 10" fill="none" stroke="currentColor" strokeOpacity=".55" strokeWidth="3" strokeLinecap="round" />
        </svg>
      </span>
      {!compact && <span className="text-lg">Weave</span>}
    </Link>
  );
}

const THEMES: { value: Theme; label: string; icon: LucideIcon }[] = [
  { value: "system", label: "Auto theme", icon: Monitor },
  { value: "light", label: "Light theme", icon: Sun },
  { value: "dark", label: "Dark theme", icon: Moon },
];

export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const i = THEMES.findIndex((t) => t.value === theme);
  const cur = THEMES[i]!;
  const nxt = THEMES[(i + 1) % THEMES.length]!;
  return <IconButton icon={cur.icon} label={`${cur.label}. Switch to ${nxt.label.toLowerCase()}`} onClick={() => setTheme(nxt.value)} />;
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string; error?: string | null }>(
  function Input({ label, hint, error, className = "", id, ...props }, ref) {
    const inputId = id ?? props.name;
    return (
      <label className="block text-sm" htmlFor={inputId}>
        {label && <span className="mb-1.5 block font-medium text-ink">{label}</span>}
        <input
          ref={ref}
          id={inputId}
          className={`block w-full rounded-xl border bg-surface px-3.5 py-2.5 text-ink transition-shadow placeholder:text-muted focus:border-accent focus:shadow-[0_0_0_4px_var(--accent-wash)] focus:outline-none ${
            error ? "border-bad" : "border-line"
          } ${className}`}
          aria-invalid={!!error}
          {...props}
        />
        {(error || hint) && <span className={`mt-1.5 block text-xs ${error ? "text-bad" : "text-muted"}`}>{error ?? hint}</span>}
      </label>
    );
  },
);

/** Accessible modal on top of <dialog>: focus trap, Esc to close, backdrop click to close. */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  wide = false,
  icon: Icon,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  icon?: LucideIcon;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className={`card pop m-auto max-h-[min(90dvh,860px)] w-[calc(100vw-2rem)] overflow-hidden p-0 text-ink backdrop:bg-black/50 backdrop:backdrop-blur-sm ${
        wide ? "max-w-4xl" : "max-w-lg"
      }`}
      aria-labelledby="modal-title"
    >
      {open && (
        <div className="flex max-h-[min(90dvh,860px)] flex-col">
          <div className="flex items-start gap-3 border-b border-line px-5 py-4 sm:px-6">
            {Icon && (
              <span className="bg-gradient grid size-9 shrink-0 place-items-center rounded-xl text-white">
                <Icon size={18} aria-hidden />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <h2 id="modal-title" className="text-lg font-semibold tracking-tight">
                {title}
              </h2>
              {description && <p className="mt-0.5 text-sm text-ink-2">{description}</p>}
            </div>
            <IconButton icon={X} label="Close" onClick={onClose} />
          </div>
          <div className="overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
        </div>
      )}
    </dialog>
  );
}

export function EmptyState({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rise flex flex-col items-center px-6 py-14 text-center">
      <div className="relative">
        <div className="bg-gradient absolute inset-0 rounded-3xl opacity-25 blur-xl" aria-hidden />
        <span className="bg-gradient relative grid size-16 place-items-center rounded-3xl text-white shadow-[0_12px_32px_-12px_var(--accent)]">
          <Icon size={28} aria-hidden />
        </span>
      </div>
      <h3 className="mt-5 text-lg font-semibold text-ink">{title}</h3>
      {children && <div className="mt-1.5 max-w-sm text-sm leading-relaxed text-ink-2">{children}</div>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
