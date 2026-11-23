import { Download, FileText, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import { EmptyState, IconButton } from "../components/ui";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Renders a PDF (base64) with pdf.js. Keeps the scroll position across recompiles, so the page
 * you're reading stays put when the document updates.
 */
export function PdfViewer({
  pdf,
  name,
  compiling,
  stale = false,
  onShowErrors,
}: {
  pdf: string | null;
  name: string;
  compiling: boolean;
  stale?: boolean;
  onShowErrors?: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!pdf || !pagesRef.current || width === 0) return;
    let cancelled = false;
    const container = pagesRef.current;
    const scrollTop = scroller.current?.scrollTop ?? 0;
    const bytes = Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0));
    const task = pdfjs.getDocument({ data: bytes });
    (async () => {
      const doc = await task.promise;
      if (cancelled) return;
      setPageCount(doc.numPages);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const fragment = document.createDocumentFragment();
      for (let i = 1; i <= doc.numPages; i++) {
        const p = await doc.getPage(i);
        if (cancelled) return;
        const base = p.getViewport({ scale: 1 });
        const scale = zoom === "fit" ? Math.max(0.3, (width - 32) / base.width) : zoom;
        const vp = p.getViewport({ scale: scale * dpr });
        const canvas = document.createElement("canvas");
        canvas.width = vp.width;
        canvas.height = vp.height;
        canvas.style.width = `${vp.width / dpr}px`;
        canvas.style.height = `${vp.height / dpr}px`;
        canvas.className = "pdf-page mx-auto block";
        canvas.dataset.page = String(i);
        canvas.setAttribute("role", "img");
        canvas.setAttribute("aria-label", `Page ${i} of ${doc.numPages}`);
        await p.render({ canvas, viewport: vp }).promise;
        fragment.appendChild(canvas);
      }
      if (cancelled) return;
      container.replaceChildren(fragment);
      if (scroller.current) scroller.current.scrollTop = scrollTop;
      void doc.cleanup();
    })().catch(() => {});
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [pdf, zoom, width]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const pages = el.querySelectorAll<HTMLCanvasElement>("canvas[data-page]");
    let current = 1;
    for (const c of pages) if (c.offsetTop - el.scrollTop < el.clientHeight / 2) current = Number(c.dataset.page);
    setPage(current);
  };

  const download = () => {
    if (!pdf) return;
    const a = document.createElement("a");
    a.href = `data:application/pdf;base64,${pdf}`;
    a.download = `${name.replace(/[^\w.-]+/g, "-")}.pdf`;
    a.click();
  };

  const z = zoom === "fit" ? null : zoom;
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-2">
      <div className="flex items-center gap-1 border-b border-line bg-surface px-2 py-1.5">
        <span className="tabular px-2 text-xs text-muted">{pageCount ? `Page ${page} / ${pageCount}` : "No PDF yet"}</span>
        <div className="flex-1" />
        <IconButton icon={ZoomOut} label="Zoom out" disabled={!pdf} onClick={() => setZoom(Math.max(0.5, (z ?? 1) - 0.15))} />
        <button
          onClick={() => setZoom("fit")}
          className={`tabular rounded-lg px-2 py-1 text-xs font-medium ${zoom === "fit" ? "bg-accent-wash text-accent-ink" : "text-ink-2 hover:bg-surface-2"}`}
        >
          {zoom === "fit" ? "Fit" : `${Math.round((z ?? 1) * 100)}%`}
        </button>
        <IconButton icon={ZoomIn} label="Zoom in" disabled={!pdf} onClick={() => setZoom(Math.min(3, (z ?? 1) + 0.15))} />
        <IconButton icon={Maximize2} label="Fit width" disabled={!pdf} onClick={() => setZoom("fit")} />
        <IconButton icon={Download} label="Download PDF" disabled={!pdf} onClick={download} />
      </div>
      <div className="relative min-h-0 flex-1">
        {stale && !compiling && (
          <button
            onClick={onShowErrors}
            className="pop absolute left-1/2 top-3 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-[var(--bad)] px-3 py-1 text-xs font-medium text-white shadow-[var(--lift)]"
          >
            Showing the last good PDF: the latest changes have errors
          </button>
        )}
        {compiling && (
          <div className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-accent-wash">
            <div className="progress-bar bg-gradient h-full w-2/5" />
          </div>
        )}
        <div ref={scroller} onScroll={onScroll} className={`h-full overflow-auto p-4 transition-opacity ${compiling ? "opacity-60" : ""}`}>
          {!pdf && !compiling && (
            <EmptyState icon={FileText} title="Your PDF appears here">
              Press <b>Compile</b> or <b>Ctrl/⌘ + S</b>. With auto-compile on, Weave recompiles a moment after you stop typing.
            </EmptyState>
          )}
          {!pdf && compiling && (
            <div className="mx-auto max-w-md space-y-3 pt-8" aria-label="Compiling">
              <div className="skeleton aspect-[1/1.3] w-full" />
            </div>
          )}
          <div ref={pagesRef} className="flex flex-col gap-4" />
        </div>
      </div>
    </div>
  );
}
