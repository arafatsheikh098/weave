import { setDiagnostics, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { PeerInfo, WireCursor } from "@weave/protocol";
import { useEffect, useRef } from "react";
import type { Diagnostic } from "../lib/api";
import type { FileReplica } from "../sync/connection";
import { crdtSync, cursorFor, cursorsFromPeers, remoteCursors, setRemoteCursors } from "./binding";
import { baseExtensions, languageFor, readOnlyCompartment } from "./setup";

export interface JumpRequest {
  line: number;
  nonce: number;
}

/** CodeMirror bound to one file's CRDT replica, with collaborators' cursors and compile errors. */
export function CodeEditor({
  replica,
  path,
  readOnly,
  peers,
  diagnostics,
  jump,
  onCursor,
}: {
  replica: FileReplica;
  path: string;
  readOnly: boolean;
  peers: PeerInfo[];
  diagnostics: Diagnostic[];
  jump: JumpRequest | null;
  onCursor: (cursor: WireCursor) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const readOnlyRef = useRef(readOnly);
  const onCursorRef = useRef(onCursor);
  useEffect(() => {
    readOnlyRef.current = readOnly;
    onCursorRef.current = onCursor;
  });
  const lastMove = useRef(new Map<string, number>());
  const lastCursors = useRef(new Map<string, string>());

  useEffect(() => {
    const doc = replica.doc;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: doc.toString(),
        extensions: [
          baseExtensions(),
          languageFor(path),
          readOnlyCompartment.of([EditorState.readOnly.of(readOnlyRef.current), EditorView.editable.of(!readOnlyRef.current)]),
          crdtSync(doc, replica.undo, () => readOnlyRef.current),
          remoteCursors(doc),
          EditorView.updateListener.of((u) => {
            if (!u.selectionSet && !u.docChanged && !u.focusChanged) return;
            if (timer) return;
            timer = setTimeout(() => {
              timer = null;
              const sel = v.state.selection.main;
              onCursorRef.current(v.hasFocus ? cursorFor(doc, sel.anchor, sel.head) : null);
            }, 80);
          }),
          EditorView.contentAttributes.of({ "aria-label": `Editor for ${path}` }),
        ],
      }),
    });
    view.current = v;
    // If the replica changed while CodeMirror was being created, resync once.
    if (v.state.doc.toString() !== doc.toString()) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: doc.toString() } });
    }
    return () => {
      if (timer) clearTimeout(timer);
      v.destroy();
      view.current = null;
    };
  }, [replica, path]);

  useEffect(() => {
    view.current?.dispatch({
      effects: readOnlyCompartment.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    });
  }, [readOnly]);

  // Collaborators' cursors. Track when each last moved, so idle name flags fade out.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const now = Date.now();
    for (const p of peers) {
      const key = JSON.stringify(p.cursor);
      if (lastCursors.current.get(p.session) !== key) {
        lastCursors.current.set(p.session, key);
        lastMove.current.set(p.session, now);
      }
    }
    const apply = () => view.current?.dispatch({ effects: setRemoteCursors.of(cursorsFromPeers(peers, replica.fileId, lastMove.current)) });
    apply();
    const t = setTimeout(apply, 4200);
    return () => clearTimeout(t);
  }, [peers, replica]);

  // Compile errors for this file, shown inline and in the gutter.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const lines = v.state.doc.lines;
    const cm: CmDiagnostic[] = diagnostics
      .filter((d) => d.line !== null)
      .map((d) => {
        const line = v.state.doc.line(Math.min(Math.max(1, d.line!), lines));
        return { from: line.from, to: line.to, severity: d.level, message: d.message, source: "LaTeX" };
      });
    v.dispatch(setDiagnostics(v.state, cm));
  }, [diagnostics]);

  // "Jump to line" from the diagnostics list or the command palette.
  useEffect(() => {
    const v = view.current;
    if (!v || !jump) return;
    const line = v.state.doc.line(Math.min(Math.max(1, jump.line), v.state.doc.lines));
    v.dispatch({ selection: EditorSelection.cursor(line.from), effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
    v.focus();
  }, [jump]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" data-tour="editor" />;
}
