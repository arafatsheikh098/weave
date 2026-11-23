import { ArrowRight, CloudOff, FileCode2, GitMerge, History, Lock, MousePointer2, Server, Share2, Sparkles, Zap } from "lucide-react";
import { HeroDemo } from "../components/HeroDemo";
import { TemplateThumb } from "../components/TemplateGallery";
import { ButtonLink, Logo, ThemeToggle } from "../components/ui";
import { useAuth } from "../lib/auth";
import { delay } from "../lib/motion";

const FEATURES = [
  { icon: MousePointer2, title: "Live cursors", body: "See who's writing where. Two people can type in the same sentence at once." },
  { icon: CloudOff, title: "Offline-first", body: "Lose Wi-Fi on the bus? Keep writing. Your edits merge automatically when you're back." },
  { icon: Zap, title: "Instant PDF", body: "Real LaTeX (Tectonic) compiles in a sandbox a moment after you stop typing." },
  { icon: History, title: "Named versions", body: "Save “Submitted draft”, restore any version, and undo only your own edits." },
  { icon: Share2, title: "Share links", body: "Invite co-authors as editors, or reviewers as view-only." },
  { icon: Server, title: "Free & self-hosted", body: "Open source. One docker compose up, and it's yours." },
];

const TEMPLATES = [
  { id: "ieee", name: "IEEE paper", accent: "violet" },
  { id: "article", name: "Article", accent: "blue" },
  { id: "beamer", name: "Slides", accent: "orange" },
  { id: "cv", name: "CV", accent: "green" },
  { id: "notes", name: "Notes", accent: "aqua" },
];

export function LandingPage() {
  const { user } = useAuth();
  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-4">
        <Logo />
        <div className="flex-1" />
        <a href="#how" className="hidden rounded-lg px-3 py-1.5 text-sm font-medium text-ink-2 hover:text-ink sm:block">
          How it works
        </a>
        <ThemeToggle />
        {user ? (
          <ButtonLink to="/projects" kind="secondary" className="px-3 py-1.5">
            My projects
          </ButtonLink>
        ) : (
          <>
            <ButtonLink to="/login" kind="ghost" className="px-3 py-1.5">
              Sign in
            </ButtonLink>
            <ButtonLink to="/signup" className="px-3 py-1.5">
              Get started
            </ButtonLink>
          </>
        )}
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-20">
        <section className="relative grid items-center gap-12 pt-8 sm:pt-14 lg:grid-cols-[1fr_1.15fr]">
          <div className="grid-pattern pointer-events-none absolute inset-x-0 -top-10 -z-10 h-[460px]" aria-hidden />
          <div>
            <span className="rise inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-ink-2">
              <Sparkles size={13} className="text-accent" aria-hidden /> Free · Open source · Works offline
            </span>
            <h1 className="rise mt-5 text-4xl font-bold leading-[1.06] tracking-tight text-ink sm:text-6xl" style={delay(60)}>
              Write LaTeX <span className="text-gradient">together</span>, even offline.
            </h1>
            <p className="rise mt-5 max-w-xl text-lg leading-relaxed text-ink-2" style={delay(120)}>
              Weave is a real-time collaborative editor for papers, theses, slides and notes. Every keystroke merges without
              conflicts, so you never see “someone else is editing this file”.
            </p>
            <div className="rise mt-8 flex flex-wrap gap-3" style={delay(180)}>
              <ButtonLink to={user ? "/projects" : "/signup"} className="px-5 py-3 text-base">
                {user ? "Open my projects" : "Start writing free"} <ArrowRight size={18} />
              </ButtonLink>
              <a href="#how" className="inline-flex items-center gap-2 rounded-xl border border-line bg-surface px-5 py-3 text-base font-medium text-ink hover:bg-surface-2">
                <GitMerge size={18} /> How merging works
              </a>
            </div>
            <ul className="rise mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-2" style={delay(240)}>
              <li className="flex items-center gap-1.5">
                <FileCode2 size={15} className="text-accent" /> Real LaTeX to PDF
              </li>
              <li className="flex items-center gap-1.5">
                <Lock size={15} className="text-accent" /> Sandboxed compiler
              </li>
              <li className="flex items-center gap-1.5">
                <CloudOff size={15} className="text-accent" /> Offline edits merge
              </li>
            </ul>
          </div>
          <div className="rise" style={delay(200)}>
            <HeroDemo />
          </div>
        </section>

        <section className="mt-24 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <div key={f.title} className="card card-hover rise p-5" style={delay(i * 60)}>
              <span className="grid size-10 place-items-center rounded-xl bg-accent-wash text-accent-ink">
                <f.icon size={19} aria-hidden />
              </span>
              <h3 className="mt-3 font-semibold text-ink">{f.title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-ink-2">{f.body}</p>
            </div>
          ))}
        </section>

        <section id="how" className="mt-24 scroll-mt-8">
          <div className="text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-ink">How edits merge without conflicts</h2>
            <p className="mx-auto mt-2 max-w-2xl text-ink-2">
              Weave stores each document as a <b className="text-ink">CRDT</b>, written from scratch. Every character gets a permanent identity, so
              everyone's copy converges to the same text no matter what order edits arrive in.
            </p>
          </div>
          <ol className="mt-10 grid gap-4 md:grid-cols-3">
            {[
              { t: "Every character has an ID", b: "An ID is (author, counter), plus the neighbours the character was typed between. IDs never change." },
              { t: "Concurrent edits are ordered", b: "If two people type at the same spot, a deterministic rule (FugueMax) orders their runs, so words never interleave." },
              { t: "Offline edits replay", b: "Your browser keeps unsent edits in IndexedDB. On reconnect, version vectors tell each side exactly what the other is missing." },
            ].map((s, i) => (
              <li key={s.t} className="card rise relative p-6" style={delay(i * 90)}>
                <span className="bg-gradient grid size-9 place-items-center rounded-xl font-bold text-white">{i + 1}</span>
                <h3 className="mt-4 font-semibold text-ink">{s.t}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{s.b}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-24">
          <h2 className="text-center text-2xl font-semibold tracking-tight text-ink">Start from a template</h2>
          <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {TEMPLATES.map((t, i) => (
              <div key={t.id} className="card card-hover rise overflow-hidden" style={delay(i * 60)}>
                <TemplateThumb id={t.id} accent={t.accent} />
                <div className="border-t border-line px-3 py-2.5 text-sm font-medium text-ink">{t.name}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="bg-gradient relative mt-24 overflow-hidden rounded-3xl p-8 text-white sm:p-12">
          <div className="pointer-events-none absolute -right-16 -top-16 size-64 rounded-full bg-white/10 blur-2xl" aria-hidden />
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Your next paper, written together.</h2>
          <p className="mt-2 max-w-lg text-white/85">Free and open source. No credit card, no file limits on your own server.</p>
          <ButtonLink to={user ? "/projects" : "/signup"} kind="secondary" className="mt-6 border-transparent px-5 py-3 text-base">
            {user ? "Open my projects" : "Create a free account"} <ArrowRight size={18} />
          </ButtonLink>
        </section>
      </main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs text-muted">
          <span>Weave · MIT licensed · Built with a hand-written CRDT, Fastify, React and Tectonic.</span>
          <Logo compact />
        </div>
      </footer>
    </div>
  );
}
