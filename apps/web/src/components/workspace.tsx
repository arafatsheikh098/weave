import { CloudOff, Loader2, Wifi } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { PeerInfo } from "@weave/protocol";
import type { Status } from "../sync/connection";
import { Avatar } from "./ui";

/** Live connection state: "All changes saved", "Saving…", "Offline · 3 unsynced edits", … */
export function StatusPill({ status, unsynced }: { status: Status; unsynced: number }) {
  let tone: "good" | "busy" | "bad";
  let label: string;
  let detail: string;
  if (status === "offline") {
    tone = "bad";
    label = unsynced ? `Offline · ${unsynced} unsynced edit${unsynced === 1 ? "" : "s"}` : "Offline";
    detail = "Keep writing. Your changes are saved in this browser and merge automatically when you reconnect.";
  } else if (status === "connecting") {
    tone = "busy";
    label = unsynced ? `Reconnecting · ${unsynced} to sync` : "Connecting…";
    detail = "Connecting to the Weave server.";
  } else if (unsynced > 0) {
    tone = "busy";
    label = "Saving…";
    detail = `${unsynced} edit${unsynced === 1 ? "" : "s"} on the way to the server.`;
  } else {
    tone = "good";
    label = "All changes saved";
    detail = "Connected. Everyone sees your edits live.";
  }
  const color = tone === "good" ? "text-good" : tone === "busy" ? "text-accent" : "text-warn";
  return (
    <div
      className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-ink-2 transition-colors"
      title={detail}
      role="status"
      aria-live="polite"
      data-tour="status"
      data-status={status}
      data-unsynced={unsynced}
    >
      {tone === "good" && <span className={`pulse-dot size-2 rounded-full bg-[var(--good)] ${color}`} aria-hidden />}
      {tone === "busy" && <Loader2 size={13} className={`animate-spin ${color}`} aria-hidden />}
      {tone === "bad" && <CloudOff size={13} className={color} aria-hidden />}
      <span className="whitespace-nowrap">{label}</span>
    </div>
  );
}

/** Stack of collaborators' avatars, with the file each one is looking at. */
export function PresenceStack({ peers, me, fileNames }: { peers: PeerInfo[]; me: { name: string; color: string }; fileNames: Map<string, string> }) {
  const unique = new Map<string, PeerInfo>();
  for (const p of peers) if (!unique.has(p.userId)) unique.set(p.userId, p);
  const list = [...unique.values()];
  const shown = list.slice(0, 4);
  return (
    <div className="flex items-center" data-tour="presence" aria-label={`${list.length + 1} people here`}>
      <div className="flex -space-x-2">
        {shown.map((p) => (
          <span key={p.userId} className="pop relative">
            <Avatar name={p.name} color={p.color} size={30} ring title={`${p.name}${p.file ? ` · ${fileNames.get(p.file) ?? ""}` : ""} (${p.role})`} />
            <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full bg-[var(--good)] ring-2 ring-[var(--surface)]" aria-hidden />
          </span>
        ))}
        {list.length > shown.length && (
          <span className="grid size-[30px] place-items-center rounded-full bg-surface-3 text-[11px] font-semibold text-ink-2 ring-2 ring-[var(--surface)]">
            +{list.length - shown.length}
          </span>
        )}
        <span className="relative">
          <Avatar name={me.name} color={me.color} size={30} ring title={`${me.name} (you)`} />
        </span>
      </div>
      {list.length === 0 && (
        <span className="ml-2 hidden items-center gap-1 text-xs text-muted lg:inline-flex">
          <Wifi size={12} aria-hidden /> Just you
        </span>
      )}
    </div>
  );
}

/**
 * Two panes with a draggable divider. Keyboard: focus the divider and use ←/→ (Shift for big
 * steps), Home/End to collapse a side. The ratio is remembered per browser.
 */
export function SplitPane({ left, right, storageKey, min = 0.2 }: { left: ReactNode; right: ReactNode; storageKey: string; min?: number }) {
  const [ratio, setRatio] = useState(() => {
    try {
      const v = Number(localStorage.getItem(storageKey));
      return v > 0 && v < 1 ? v : 0.5;
    } catch {
      return 0.5;
    }
  });
  const box = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const save = useCallback(
    (r: number) => {
      const v = Math.min(1 - min, Math.max(min, r));
      setRatio(v);
      try {
        localStorage.setItem(storageKey, String(v));
      } catch {
        /* ignore */
      }
    },
    [min, storageKey],
  );

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const rect = box.current!.getBoundingClientRect();
      save((e.clientX - rect.left) / rect.width);
    };
    const up = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragging, save]);

  return (
    <div ref={box} className={`flex h-full min-h-0 ${dragging ? "cursor-col-resize select-none" : ""}`}>
      <div className="min-w-0" style={{ flexBasis: `${ratio * 100}%` }}>
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize editor and preview"
        aria-valuemin={Math.round(min * 100)}
        aria-valuemax={Math.round((1 - min) * 100)}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        onPointerDown={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDoubleClick={() => save(0.5)}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.1 : 0.02;
          if (e.key === "ArrowLeft") save(ratio - step);
          else if (e.key === "ArrowRight") save(ratio + step);
          else if (e.key === "Home") save(min);
          else if (e.key === "End") save(1 - min);
          else return;
          e.preventDefault();
        }}
        className="group relative z-10 w-1.5 shrink-0 cursor-col-resize bg-line transition-colors hover:bg-accent focus-visible:bg-accent"
        data-tour="split"
      >
        <span className="absolute left-1/2 top-1/2 h-10 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--axis)] transition-colors group-hover:bg-white" />
      </div>
      <div className="min-w-0 flex-1">{right}</div>
    </div>
  );
}
