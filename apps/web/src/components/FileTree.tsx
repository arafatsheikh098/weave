import { ChevronRight, File, FileCode2, FilePlus2, FileText, Folder, Image as ImageIcon, MoreHorizontal, Pencil, Star, Trash2, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { FileMeta, PeerInfo } from "@weave/protocol";
import { IconButton } from "./ui";

interface Node {
  name: string;
  path: string;
  file?: FileMeta;
  children: Map<string, Node>;
}

function buildTree(files: FileMeta[]): Node {
  const root: Node = { name: "", path: "", children: new Map() };
  for (const f of files) {
    const parts = f.path.split("/");
    let cur = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      let next = cur.children.get(part);
      if (!next) {
        next = { name: part, path, children: new Map() };
        cur.children.set(part, next);
      }
      if (i === parts.length - 1) next.file = f;
      cur = next;
    });
  }
  return root;
}

function iconFor(f: FileMeta) {
  if (f.kind === "binary") return ImageIcon;
  if (/\.(tex|sty|cls)$/.test(f.path)) return FileCode2;
  if (/\.(md|bib|txt)$/.test(f.path)) return FileText;
  return File;
}

export function FileTree({
  files,
  activeId,
  mainFile,
  peers,
  canEdit,
  onOpen,
  onCreate,
  onUpload,
  onRename,
  onDelete,
  onSetMain,
}: {
  files: FileMeta[];
  activeId: string | null;
  mainFile: string;
  peers: PeerInfo[];
  canEdit: boolean;
  onOpen: (f: FileMeta) => void;
  onCreate: () => void;
  onUpload: (files: FileList) => void;
  onRename: (f: FileMeta) => void;
  onDelete: (f: FileMeta) => void;
  onSetMain: (f: FileMeta) => void;
}) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const peersOn = (id: string) => peers.filter((p) => p.file === id);

  const render = (node: Node, depth: number): React.ReactNode[] =>
    [...node.children.values()]
      .sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name))
      .flatMap((child) => {
        if (!child.file) {
          const open = !collapsed.has(child.path);
          return [
            <li key={`d:${child.path}`}>
              <button
                className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm text-ink-2 hover:bg-surface-2"
                style={{ paddingLeft: 8 + depth * 14 }}
                aria-expanded={open}
                onClick={() =>
                  setCollapsed((s) => {
                    const n = new Set(s);
                    if (n.has(child.path)) n.delete(child.path);
                    else n.add(child.path);
                    return n;
                  })
                }
              >
                <ChevronRight size={14} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
                <Folder size={15} className="shrink-0 text-accent" aria-hidden />
                <span className="truncate">{child.name}</span>
              </button>
            </li>,
            ...(open ? render(child, depth + 1) : []),
          ];
        }
        const f = child.file;
        const Icon = iconFor(f);
        const active = f.id === activeId;
        const here = peersOn(f.id);
        return [
          <li key={f.id} className="group relative">
            <button
              onClick={() => onOpen(f)}
              className={`flex w-full items-center gap-2 rounded-lg py-1.5 pr-8 text-left text-sm transition-colors ${
                active ? "bg-accent-wash font-medium text-accent-ink" : "text-ink hover:bg-surface-2"
              }`}
              style={{ paddingLeft: 10 + depth * 14 }}
              aria-current={active ? "page" : undefined}
            >
              <Icon size={15} className={`shrink-0 ${active ? "" : "text-muted"}`} aria-hidden />
              <span className="truncate">{child.name}</span>
              {f.path === mainFile && <Star size={12} className="shrink-0 fill-current text-[var(--warn)]" aria-label="Main file" />}
              <span className="ml-auto flex shrink-0 -space-x-1">
                {here.slice(0, 3).map((p) => (
                  <span key={p.session} className="size-2 rounded-full ring-1 ring-[var(--surface)]" style={{ background: p.color }} title={`${p.name} is here`} />
                ))}
              </span>
            </button>
            {canEdit && (
              <button
                className="absolute right-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted opacity-0 hover:bg-surface-3 hover:text-ink focus:opacity-100 group-hover:opacity-100"
                aria-label={`Actions for ${f.path}`}
                aria-haspopup="menu"
                aria-expanded={menu === f.id}
                onClick={() => setMenu(menu === f.id ? null : f.id)}
              >
                <MoreHorizontal size={14} />
              </button>
            )}
            {menu === f.id && (
              <div role="menu" className="card pop absolute right-1 top-full z-20 w-44 p-1 text-sm shadow-[var(--lift)]" onMouseLeave={() => setMenu(null)}>
                <MenuItem icon={Pencil} label="Rename" onClick={() => (setMenu(null), onRename(f))} />
                {f.kind === "text" && f.path.endsWith(".tex") && f.path !== mainFile && (
                  <MenuItem icon={Star} label="Set as main file" onClick={() => (setMenu(null), onSetMain(f))} />
                )}
                <MenuItem icon={Trash2} label="Delete" danger onClick={() => (setMenu(null), onDelete(f))} />
              </div>
            )}
          </li>,
        ];
      });

  return (
    <div
      className={`flex h-full flex-col transition-colors ${dragOver ? "bg-accent-wash" : ""}`}
      onDragOver={(e) => {
        if (!canEdit) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (canEdit && e.dataTransfer.files.length) onUpload(e.dataTransfer.files);
      }}
      data-tour="files"
    >
      <div className="flex items-center gap-1 px-3 pb-1 pt-3">
        <span className="flex-1 text-xs font-semibold uppercase tracking-wider text-muted">Files</span>
        {canEdit && (
          <>
            <IconButton icon={FilePlus2} label="New file" onClick={onCreate} className="size-7" />
            <IconButton icon={Upload} label="Upload image" onClick={() => input.current?.click()} className="size-7" />
            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/svg+xml,application/pdf"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) onUpload(e.target.files);
                e.target.value = "";
              }}
            />
          </>
        )}
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="Project files">
        {render(tree, 0)}
      </ul>
      {canEdit && (
        <p className="border-t border-line px-3 py-2.5 text-[11px] leading-snug text-muted">
          Drop images here to upload. Use them with <code className="rounded bg-surface-2 px-1">\includegraphics</code>.
        </p>
      )}
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }: { icon: typeof File; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button role="menuitem" onClick={onClick} className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2 ${danger ? "text-bad" : "text-ink"}`}>
      <Icon size={14} aria-hidden /> {label}
    </button>
  );
}
