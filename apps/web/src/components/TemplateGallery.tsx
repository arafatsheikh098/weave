import { Check, FilePlus2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api, type TemplateInfo } from "../lib/api";
import { delay } from "../lib/motion";
import { useToast } from "./Toaster";
import { Button, Input, Modal, Skeleton } from "./ui";

const ACCENTS: Record<string, string> = {
  blue: "#2a78d6",
  violet: "#6250d6",
  orange: "#eb6834",
  green: "#1baf7a",
  aqua: "#0ea5b7",
  gray: "#6f6d68",
};

/** A miniature rendering of what each template produces (pure CSS, no compile needed). */
export function TemplateThumb({ id, accent }: { id: string; accent: string }) {
  const c = ACCENTS[accent] ?? ACCENTS.blue!;
  const line = (w: string, extra = "") => <div className={`h-[3px] rounded-full bg-neutral-300 ${extra}`} style={{ width: w }} />;
  const para = (n: number) => (
    <div className="space-y-[3px]">
      {Array.from({ length: n }, (_, i) => (
        <div key={i}>{line(i === n - 1 ? "62%" : "100%")}</div>
      ))}
    </div>
  );
  if (id === "beamer") {
    return (
      <div className="flex aspect-[4/3] items-center justify-center bg-neutral-100 p-4" aria-hidden>
        <div className="aspect-video w-full overflow-hidden rounded-md bg-white shadow-md">
          <div className="h-[22%] px-3 pt-2" style={{ background: c }}>
            <div className="h-[4px] w-1/2 rounded-full bg-white/80" />
          </div>
          <div className="space-y-1.5 p-3">
            {["70%", "55%", "62%"].map((w) => (
              <div key={w} className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full" style={{ background: c }} />
                {line(w)}
              </div>
            ))}
            <div className="mt-2 rounded-sm border-l-2 p-1.5" style={{ borderColor: c, background: `${c}18` }}>
              {line("80%")}
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (id === "notes") {
    return (
      <div className="aspect-[4/3] bg-neutral-100 p-4" aria-hidden>
        <div className="h-full space-y-2 rounded-md bg-white p-3 shadow-md">
          <div className="h-[6px] w-2/5 rounded-full bg-neutral-700" />
          {para(2)}
          <div className="h-[4px] w-1/4 rounded-full bg-neutral-500" />
          {["#", "#", "#"].map((_, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="size-2 rounded-[2px] border" style={{ borderColor: c, background: i === 0 ? c : "transparent" }} />
              {line(`${50 + i * 10}%`)}
            </div>
          ))}
          <div className="grid grid-cols-3 gap-[2px]">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className={`h-2 ${i < 3 ? "bg-neutral-300" : "bg-neutral-100"}`} />
            ))}
          </div>
        </div>
      </div>
    );
  }
  const twoCol = id === "ieee";
  return (
    <div className="flex aspect-[4/3] justify-center bg-neutral-100 px-6 pt-4" aria-hidden>
      <div className="w-[78%] space-y-2 rounded-t-md bg-white p-3 shadow-md">
        {id === "cv" ? (
          <>
            <div className="mx-auto h-[6px] w-1/2 rounded-full bg-neutral-700" />
            <div className="mx-auto h-[3px] w-2/3 rounded-full bg-neutral-300" />
            {["Education", "Experience", "Projects"].map((s) => (
              <div key={s} className="space-y-[3px]">
                <div className="h-[4px] w-1/3 rounded-full" style={{ background: c }} />
                <div className="h-px w-full" style={{ background: c }} />
                {para(2)}
              </div>
            ))}
          </>
        ) : (
          <>
            <div className="mx-auto h-[6px] w-3/5 rounded-full bg-neutral-700" />
            <div className="mx-auto h-[3px] w-2/5 rounded-full bg-neutral-400" />
            <div className="mx-auto w-4/5 space-y-[3px] rounded-sm p-1" style={{ background: `${c}14` }}>
              {para(2)}
            </div>
            <div className={twoCol ? "grid grid-cols-2 gap-2" : ""}>
              <div className="space-y-1.5">
                <div className="h-[4px] w-2/5 rounded-full" style={{ background: c }} />
                {para(3)}
                {twoCol && <div className="h-6 rounded-sm bg-neutral-200" />}
              </div>
              {twoCol && (
                <div className="space-y-1.5">
                  <div className="h-[4px] w-1/3 rounded-full" style={{ background: c }} />
                  {para(4)}
                </div>
              )}
            </div>
            {!twoCol && (
              <div className="flex justify-center py-0.5">
                <div className="h-[3px] w-1/3 rounded-full bg-neutral-500" />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Pick a template, name the project, create it. */
export function TemplateGallery({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [chosen, setChosen] = useState("article");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && !templates) api.templates().then(setTemplates, () => setTemplates([]));
  }, [open, templates]);

  const tpl = templates?.find((t) => t.id === chosen);
  const create = async () => {
    setBusy(true);
    try {
      const { id } = await api.createProject(name.trim() || tpl?.name || "Untitled", chosen);
      onClose();
      navigate(`/p/${id}`);
      toast.show({ kind: "success", title: "Project created", body: "Invite collaborators from the Share button." });
    } catch (e) {
      toast.show({ kind: "error", title: "Couldn't create the project", body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New project" description="Start from a template. Everything stays editable." icon={Sparkles} wide>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3" role="radiogroup" aria-label="Template">
        {!templates && [0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="aspect-[4/3.6]" />)}
        {templates?.map((t, i) => {
          const on = t.id === chosen;
          return (
            <button
              key={t.id}
              role="radio"
              aria-checked={on}
              onClick={() => setChosen(t.id)}
              onDoubleClick={() => void create()}
              className={`rise group overflow-hidden rounded-2xl border text-left transition-all ${
                on ? "border-accent shadow-[0_0_0_3px_var(--accent-wash)]" : "border-line hover:border-accent/50"
              }`}
              style={delay(i * 50)}
            >
              <div className="relative overflow-hidden transition-transform group-hover:scale-[1.02]">
                <TemplateThumb id={t.id} accent={t.accent} />
                {on && (
                  <span className="bg-gradient pop absolute right-2 top-2 grid size-6 place-items-center rounded-full text-white">
                    <Check size={14} />
                  </span>
                )}
              </div>
              <div className="border-t border-line p-3">
                <div className="text-sm font-semibold text-ink">{t.name}</div>
                <div className="mt-0.5 line-clamp-2 text-xs leading-snug text-ink-2">{t.description}</div>
              </div>
            </button>
          );
        })}
      </div>
      <form
        className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="flex-1">
          <Input label="Project name" placeholder={tpl?.name ?? "My paper"} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />
        </div>
        <Button type="submit" disabled={busy || !templates?.length} className="py-2.5">
          <FilePlus2 size={16} /> {busy ? "Creating…" : "Create project"}
        </Button>
      </form>
    </Modal>
  );
}
