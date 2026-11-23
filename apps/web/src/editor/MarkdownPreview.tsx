import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useMemo, useState } from "react";
import type { FileMeta } from "@weave/protocol";
import type { Doc } from "@weave/crdt";
import { api } from "../lib/api";

/** Live Markdown preview of a CRDT document; relative image paths resolve to project files. */
export function MarkdownPreview({ doc, projectId, files }: { doc: Doc; projectId: string; files: FileMeta[] }) {
  const [text, setText] = useState(() => doc.toString());
  useEffect(() => {
    let raf = 0;
    const off = doc.onChange(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setText(doc.toString()));
    });
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  }, [doc]);

  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false, gfm: true });
    const clean = DOMPurify.sanitize(raw);
    const byPath = new Map(files.map((f) => [f.path, f.id]));
    // Point <img src="figure.png"> at the uploaded project file.
    return clean.replace(/<img([^>]*?)src="([^"]+)"/g, (m, pre: string, src: string) => {
      const id = byPath.get(src.replace(/^\.\//, ""));
      return id ? `<img${pre}src="${api.rawUrl(projectId, id)}"` : m;
    });
  }, [text, files, projectId]);

  return (
    <div className="h-full overflow-auto bg-surface">
      <article className="prose-md mx-auto max-w-2xl px-6 py-8" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
