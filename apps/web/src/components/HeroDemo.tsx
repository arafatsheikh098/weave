import { Doc, type Op } from "@weave/crdt";
import { CheckCircle2, CloudOff, Wifi } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { reducedMotion } from "../lib/motion";

/**
 * Landing-page demo running the real CRDT: two simulated people type into two replicas at the
 * same time, with network latency (and a short offline spell for one of them). What you see is
 * replica A's text with both cursors; the badge confirms the replicas converge.
 */
const BASE = String.raw`\documentclass{article}
\title{Field Notes}
\begin{document}
\maketitle

\section{Abstract}
@B

\section{Results}
@A
\end{document}`;

const AYESHA = { name: "Ayesha", color: "#2a78d6", text: "Rainfall in Chattogram peaked in July." };
const RAHIM = { name: "Rahim", color: "#eb6834", text: "Waterlogging lasted 6 hours on average." };

/** Move a local caret past a remote change that happened before it. */
function shift(pos: number, c: { type: "insert"; pos: number; text: string } | { type: "delete"; pos: number; len: number }): number {
  if (c.pos >= pos) return pos;
  return c.type === "insert" ? pos + c.text.length : pos - Math.min(c.len, pos - c.pos);
}

interface Frame {
  text: string;
  a: number;
  b: number;
  bOffline: boolean;
  queued: number;
  converged: boolean;
}

export function HeroDemo() {
  const [frame, setFrame] = useState<Frame | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    let alive = true;
    const later = (ms: number, fn: () => void) => timers.current.push(setTimeout(() => alive && fn(), ms));

    const run = () => {
      // "@A" / "@B" mark where each person starts typing.
      const clean = BASE.replace("@A", "").replace("@B", "");
      const docA = new Doc("ayesha");
      docA.insert(0, clean);
      const docB = new Doc("rahim");
      docB.apply(docA.opsSince({}));
      let bPos = BASE.indexOf("@B");
      let aPos = BASE.indexOf("@A") - 2;
      let bOffline = false;
      const outboxB: Op[] = [];
      // Rahim's cursor in Ayesha's copy: just after the last of his characters that has arrived.
      const bInA = () => {
        for (let k = bPos; k >= 0; k--) {
          const anchor = docB.anchorAt(k);
          if (!anchor.id || docA.positionOf(anchor.id) !== null) return docA.resolveAnchor(anchor);
        }
        return 0;
      };
      const show = () => {
        setFrame({
          text: docA.toString(),
          a: aPos,
          b: bInA(),
          bOffline,
          queued: outboxB.length,
          converged: docA.toString() === docB.toString(),
        });
      };
      // Ops travel with ~250 ms latency. B's ops wait while B is "offline".
      docA.onOp((op) => later(250, () => (docB.apply([op]), show())));
      docB.onOp((op) => {
        if (bOffline) outboxB.push(op);
        else later(250, () => (docA.apply([op]), show()));
      });
      docA.onChange((changes, origin) => {
        if (origin !== "remote") return;
        for (const c of changes) aPos = shift(aPos, c);
      });
      docB.onChange((changes, origin) => {
        if (origin !== "remote") return;
        for (const c of changes) bPos = shift(bPos, c);
      });

      if (reducedMotion()) {
        docA.insert(aPos, AYESHA.text);
        docB.insert(bPos, RAHIM.text);
        docB.apply(docA.opsSince({}));
        docA.apply(docB.opsSince({}));
        aPos += AYESHA.text.length;
        bPos += RAHIM.text.length;
        show();
        return;
      }

      let t = 600;
      for (const ch of AYESHA.text) {
        t += 55 + Math.random() * 90;
        later(t, () => {
          docA.insert(aPos, ch);
          aPos += 1;
          show();
        });
      }
      let u = 900;
      RAHIM.text.split("").forEach((ch, i) => {
        u += 60 + Math.random() * 95;
        if (i === 12) later(u, () => ((bOffline = true), show()));
        if (i === 26) {
          later(u, () => {
            bOffline = false;
            const flush = outboxB.splice(0);
            later(250, () => (docA.apply(flush), show()));
            show();
          });
        }
        later(u, () => {
          docB.insert(bPos, ch);
          bPos += 1;
          show();
        });
      });
      later(Math.max(t, u) + 3200, run);
      show();
    };
    run();
    return () => {
      alive = false;
      for (const t of timers.current) clearTimeout(t);
      timers.current = [];
    };
  }, []);

  return (
    <div className="card relative overflow-hidden shadow-[var(--lift)]" aria-label="Animated demo: two people editing one document at the same time" role="img">
      <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-3 py-2">
        <span className="flex gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-[#ff5f57]" />
          <span className="size-2.5 rounded-full bg-[#febc2e]" />
          <span className="size-2.5 rounded-full bg-[#28c840]" />
        </span>
        <span className="ml-1 font-mono text-xs text-muted">main.tex</span>
        <div className="flex-1" />
        <Badge name={AYESHA.name} color={AYESHA.color} />
        <Badge name={RAHIM.name} color={RAHIM.color} offline={frame?.bOffline} queued={frame?.queued ?? 0} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-[1.25fr_1fr]">
        <pre className="relative z-10 h-[300px] overflow-visible whitespace-pre-wrap bg-[var(--editor-bg)] p-4 font-mono text-[12.5px] leading-[1.65] text-ink">
          {frame ? <Highlighted text={frame.text} a={frame.a} b={frame.b} /> : BASE.replace("@A", "").replace("@B", "")}
        </pre>
        <div className="hidden border-l border-line bg-surface-2 p-4 sm:block">
          <MiniPaper text={frame?.text ?? BASE} />
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-line bg-surface px-3 py-2 text-xs">
        {frame?.converged ? (
          <span className="inline-flex items-center gap-1.5 text-good">
            <CheckCircle2 size={14} /> Both copies identical: merged without conflicts
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-ink-2">
            <Wifi size={14} className="text-accent" /> Edits in flight…
          </span>
        )}
        <span className="ml-auto text-muted">Running Weave's real CRDT in your browser</span>
      </div>
    </div>
  );
}

function Badge({ name, color, offline, queued = 0 }: { name: string; color: string; offline?: boolean; queued?: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium text-ink">
      <span className="size-2 rounded-full" style={{ background: color }} />
      {name}
      {offline && (
        <span className="fade-in inline-flex items-center gap-1 text-warn">
          <CloudOff size={11} /> offline{queued ? ` · ${queued} queued` : ""}
        </span>
      )}
    </span>
  );
}

function Caret({ color, name }: { color: string; name: string }) {
  return (
    <span className="remote-caret" style={{ ["--peer" as string]: color }} data-name={name}>
      {"​"}
    </span>
  );
}

/** Tiny LaTeX highlighter plus the two carets. */
function Highlighted({ text, a, b }: { text: string; a: number; b: number }) {
  const marks = [
    { pos: a, el: <Caret key="a" color={AYESHA.color} name={AYESHA.name} /> },
    ...(b >= 0 ? [{ pos: b, el: <Caret key="b" color={RAHIM.color} name={RAHIM.name} /> }] : []),
  ].sort((x, y) => x.pos - y.pos);
  const out: React.ReactNode[] = [];
  let last = 0;
  const pushText = (s: string, key: string) => {
    const parts = s.split(/(\\[a-zA-Z]+|[{}])/g);
    parts.forEach((p, i) => {
      if (!p) return;
      if (p.startsWith("\\")) out.push(<span key={`${key}-${i}`} style={{ color: "var(--tok-command)" }}>{p}</span>);
      else if (p === "{" || p === "}") out.push(<span key={`${key}-${i}`} style={{ color: "var(--tok-bracket)" }}>{p}</span>);
      else out.push(<span key={`${key}-${i}`}>{p}</span>);
    });
  };
  for (const m of marks) {
    pushText(text.slice(last, m.pos), `t${last}`);
    out.push(m.el);
    last = m.pos;
  }
  pushText(text.slice(last), "tail");
  return <>{out}</>;
}

function MiniPaper({ text }: { text: string }) {
  const [today] = useState(() => new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }));
  const title = /\\title\{([^}]*)\}/.exec(text)?.[1] ?? "";
  const sections = [...text.matchAll(/\\section\{([^}]*)\}\n([^\\]*)/g)].map((m) => ({ head: m[1]!, body: m[2]!.trim() }));
  return (
    <div className="mx-auto aspect-[1/1.3] max-w-[220px] rounded-sm bg-white p-4 text-neutral-900 shadow-md">
      <div className="text-center font-serif text-[13px] font-semibold">{title}</div>
      <div className="mt-0.5 text-center font-serif text-[8px] text-neutral-500">{today}</div>
      {sections.map((s, i) => (
        <div key={s.head} className="mt-3">
          <div className="font-serif text-[10px] font-bold">
            {i + 1}&nbsp;&nbsp;{s.head}
          </div>
          <p className="mt-1 font-serif text-[8.5px] leading-snug text-neutral-700">{s.body || " "}</p>
        </div>
      ))}
    </div>
  );
}
