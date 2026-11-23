/**
 * CodeMirror 6 <-> Weave CRDT binding (hand-written; no y-codemirror).
 *
 * - Local edits: every CodeMirror transaction's changes are replayed on the CRDT, last change
 *   first so earlier positions stay valid.
 * - Remote edits: the CRDT's change events are composed into one ChangeSet and dispatched with
 *   a "remote" annotation (which the local listener ignores). CodeMirror maps the selection.
 * - Undo/redo use the CRDT's per-user UndoManager instead of CodeMirror's history, so undo never
 *   reverts a collaborator's work.
 * - Remote cursors are anchored to CRDT character ids, so they stay put during concurrent edits.
 */
import { Annotation, ChangeSet, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Anchor, Doc, Id, UndoManager } from "@weave/crdt";
import type { PeerInfo, WireCursor } from "@weave/protocol";

export const remoteEdit = Annotation.define<boolean>();

const toWire = (a: Anchor): [string, number] | null => (a.id ? [a.id.agent, a.id.seq] : null);
const fromWire = (w: [string, number] | null): Anchor => ({ id: w ? ({ agent: w[0], seq: w[1] } as Id) : null });

/** Keep the CodeMirror document in lock-step with the CRDT document. */
export function crdtSync(doc: Doc, undo: UndoManager, readOnly: () => boolean): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      private off: () => void;
      constructor(readonly view: EditorView) {
        this.off = doc.onChange((changes, origin) => {
          if (origin === "local") return;
          let cs = ChangeSet.empty(view.state.doc.length);
          for (const c of changes) {
            const next =
              c.type === "insert"
                ? ChangeSet.of([{ from: c.pos, insert: c.text }], cs.newLength)
                : ChangeSet.of([{ from: c.pos, to: c.pos + c.len }], cs.newLength);
            cs = cs.compose(next);
          }
          // Defer if CodeMirror is mid-update (e.g. a remote op arriving during a local dispatch).
          const apply = () => view.dispatch({ changes: cs, annotations: [remoteEdit.of(true)] });
          if ((view as unknown as { updateState: number }).updateState) queueMicrotask(apply);
          else apply();
        });
      }
      update(u: ViewUpdate) {
        for (const tr of u.transactions) {
          if (!tr.docChanged || tr.annotation(remoteEdit)) continue;
          const parts: { from: number; to: number; text: string }[] = [];
          tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            parts.push({ from: fromA, to: toA, text: inserted.toString() });
          });
          for (const p of parts.reverse()) {
            if (p.to > p.from) doc.delete(p.from, p.to - p.from);
            if (p.text) doc.insert(p.from, p.text);
          }
        }
      }
      destroy() {
        this.off();
      }
    },
  );

  const undoKeys = keymap.of([
    { key: "Mod-z", run: () => !readOnly() && (undo.undo(), true), preventDefault: true },
    { key: "Mod-y", run: () => !readOnly() && (undo.redo(), true), preventDefault: true },
    { key: "Mod-Shift-z", run: () => !readOnly() && (undo.redo(), true), preventDefault: true },
  ]);

  return [plugin, undoKeys];
}

/** Turn a CodeMirror selection into CRDT anchors for presence. */
export function cursorFor(doc: Doc, anchor: number, head: number): WireCursor {
  return { anchor: toWire(doc.anchorAt(anchor)), head: toWire(doc.anchorAt(head)) };
}

// ---- Remote cursors ------------------------------------------------------------------------

export interface RemoteCursor {
  session: string;
  name: string;
  color: string;
  cursor: NonNullable<WireCursor>;
  idle: boolean;
}

export const setRemoteCursors = StateEffect.define<RemoteCursor[]>();

class CaretWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly color: string,
    readonly idle: boolean,
  ) {
    super();
  }
  eq(other: CaretWidget) {
    return other.name === this.name && other.color === this.color && other.idle === this.idle;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = `remote-caret${this.idle ? " idle" : ""}`;
    el.style.setProperty("--peer", this.color);
    el.dataset.name = this.name;
    el.setAttribute("aria-hidden", "true");
    // A zero-width space keeps the caret the height of the line.
    el.textContent = "​";
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

/** Decorations for collaborators' carets and selections, resolved through the CRDT. */
export function remoteCursors(doc: Doc): Extension {
  const field = StateField.define<{ cursors: RemoteCursor[]; deco: DecorationSet }>({
    create: () => ({ cursors: [], deco: Decoration.none }),
    update(value, tr) {
      let cursors = value.cursors;
      for (const e of tr.effects) if (e.is(setRemoteCursors)) cursors = e.value;
      if (cursors === value.cursors && !tr.docChanged) return value;
      return { cursors, deco: build(cursors, tr.state.doc.length) };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });

  function build(cursors: RemoteCursor[], length: number): DecorationSet {
    const ranges: Range<Decoration>[] = [];
    for (const c of cursors) {
      const head = Math.min(length, doc.resolveAnchor(fromWire(c.cursor.head)));
      const anchor = Math.min(length, doc.resolveAnchor(fromWire(c.cursor.anchor)));
      const from = Math.min(head, anchor);
      const to = Math.max(head, anchor);
      if (to > from) {
        ranges.push(Decoration.mark({ class: "remote-selection", attributes: { style: `--peer:${c.color}` } }).range(from, to));
      }
      ranges.push(Decoration.widget({ widget: new CaretWidget(c.name, c.color, c.idle), side: 1 }).range(head));
    }
    return Decoration.set(ranges, true);
  }

  return field;
}

export function cursorsFromPeers(peers: Iterable<PeerInfo>, fileId: string, lastMove: Map<string, number>): RemoteCursor[] {
  const now = Date.now();
  const out: RemoteCursor[] = [];
  for (const p of peers) {
    if (p.file !== fileId || !p.cursor) continue;
    out.push({ session: p.session, name: p.name, color: p.color, cursor: p.cursor, idle: now - (lastMove.get(p.session) ?? now) > 4000 });
  }
  return out;
}
