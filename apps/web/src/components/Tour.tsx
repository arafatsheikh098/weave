import { ArrowRight, Sparkles, X } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import { Button } from "./ui";

export interface TourStep {
  target: string; // value of a data-tour attribute
  title: string;
  body: string;
}

const KEY = "weave-tour-done";

export function tourDone(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return true;
  }
}

/** First-run coach marks pointing at parts of the editor. Shown once per browser. */
export function Tour({ steps, onDone }: { steps: TourStep[]; onDone: () => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = steps[i]!;

  useLayoutEffect(() => {
    const measure = () => {
      const el = document.querySelector(`[data-tour="${step.target}"]`);
      setRect(el && (el as HTMLElement).offsetParent !== null ? el.getBoundingClientRect() : null);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [step]);

  const finish = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* ignore */
    }
    onDone();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Place the card below the target if there's room, otherwise above; clamp to the viewport.
  const W = 320;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top = vh / 2 - 90;
  let left = vw / 2 - W / 2;
  if (rect) {
    const below = rect.bottom + 12;
    top = below + 190 < vh ? below : Math.max(12, rect.top - 190);
    left = Math.min(vw - W - 12, Math.max(12, rect.left + rect.width / 2 - W / 2));
  }

  return (
    <div className="fixed inset-0 z-[90]" role="dialog" aria-modal="true" aria-label={`Tour step ${i + 1} of ${steps.length}: ${step.title}`}>
      {rect ? (
        <div
          className="pointer-events-none absolute rounded-xl transition-all duration-300"
          style={{
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.45), 0 0 0 3px var(--accent)",
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-black/45" />
      )}
      <div key={i} className="card pop absolute p-4 shadow-[var(--lift)]" style={{ top, left, width: W }}>
        <div className="flex items-start gap-2">
          <Sparkles size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden />
          <h3 className="flex-1 text-sm font-semibold text-ink">{step.title}</h3>
          <button onClick={finish} className="rounded-md p-0.5 text-muted hover:text-ink" aria-label="Skip tour">
            <X size={14} />
          </button>
        </div>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{step.body}</p>
        <div className="mt-4 flex items-center gap-2">
          <div className="flex flex-1 gap-1" aria-hidden>
            {steps.map((_, k) => (
              <span key={k} className={`h-1.5 rounded-full transition-all ${k === i ? "bg-gradient w-5" : "w-1.5 bg-[var(--axis)]"}`} />
            ))}
          </div>
          <Button kind="ghost" size="sm" onClick={finish}>
            Skip
          </Button>
          <Button size="sm" autoFocus onClick={() => (i + 1 < steps.length ? setI(i + 1) : finish())}>
            {i + 1 < steps.length ? (
              <>
                Next <ArrowRight size={14} />
              </>
            ) : (
              "Start writing"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
