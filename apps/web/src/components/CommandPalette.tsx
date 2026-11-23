import { CornerDownLeft, Search, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Kbd } from "./ui";

export interface Command {
  id: string;
  label: string;
  group: string;
  icon: LucideIcon;
  shortcut?: string;
  run: () => void;
  hint?: string;
}

/** Score a fuzzy match: all query letters in order; earlier and consecutive matches score higher. */
export function fuzzyScore(text: string, query: string): number {
  if (!query) return 1;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    streak = found === ti ? streak + 1 : 0;
    score += 1 + streak * 2 + (found === 0 || t[found - 1] === " " || t[found - 1] === "/" ? 3 : 0);
    ti = found + 1;
  }
  return score / (t.length + 1);
}

/** ⌘K command palette: run any action or jump to any file by typing. */
export function CommandPalette({ open, onClose, commands }: { open: boolean; onClose: () => void; commands: Command[] }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  const results = useMemo(
    () =>
      commands
        .map((c) => ({ c, s: fuzzyScore(`${c.label} ${c.group}`, query) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 50)
        .map((x) => x.c),
    [commands, query],
  );

  useEffect(() => {
    const d = dialog.current!;
    if (open && !d.open) {
      d.showModal();
      requestAnimationFrame(() => input.current?.focus());
    }
    if (!open && d.open) d.close();
  }, [open]);

  const close = () => {
    setQuery("");
    setIndex(0);
    onClose();
  };
  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    close();
    // Let the dialog close before running (some commands open other dialogs).
    setTimeout(c.run, 0);
  };

  return (
    <dialog
      ref={dialog}
      onClose={close}
      onClick={(e) => e.target === dialog.current && close()}
      className="card pop mx-auto mt-[12vh] w-[calc(100vw-2rem)] max-w-xl overflow-hidden p-0 text-ink backdrop:bg-black/40 backdrop:backdrop-blur-sm"
      aria-label="Command palette"
    >
      <div className="flex items-center gap-3 border-b border-line px-4">
        <Search size={18} className="shrink-0 text-muted" aria-hidden />
        <input
          ref={input}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setIndex((i) => Math.min(results.length - 1, i + 1));
            else if (e.key === "ArrowUp") setIndex((i) => Math.max(0, i - 1));
            else if (e.key === "Enter") run(results[index]);
            else return;
            e.preventDefault();
          }}
          placeholder="Type a command or a file name…"
          className="min-w-0 flex-1 bg-transparent py-4 text-base text-ink placeholder:text-muted focus:outline-none"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={results[index] ? `cmd-${results[index]!.id}` : undefined}
        />
        <Kbd>Esc</Kbd>
      </div>
      <ul ref={list} id="palette-list" role="listbox" className="max-h-[50vh] overflow-y-auto p-2">
        {results.length === 0 && <li className="px-3 py-8 text-center text-sm text-muted">No matching commands.</li>}
        {results.map((c, i) => {
          const header = !query && results[i - 1]?.group !== c.group ? c.group : null;
          return (
            <li key={c.id} role="presentation">
              {header && <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted">{header}</div>}
              <button
                id={`cmd-${c.id}`}
                role="option"
                aria-selected={i === index}
                data-index={i}
                onMouseMove={() => setIndex(i)}
                onClick={() => run(c)}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm ${i === index ? "bg-accent-wash text-accent-ink" : "text-ink"}`}
              >
                <c.icon size={16} className="shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  {c.label}
                  {c.hint && <span className="ml-2 text-xs text-muted">{c.hint}</span>}
                </span>
                {c.shortcut && <Kbd>{c.shortcut}</Kbd>}
                {i === index && <CornerDownLeft size={14} className="shrink-0" aria-hidden />}
              </button>
            </li>
          );
        })}
      </ul>
    </dialog>
  );
}
