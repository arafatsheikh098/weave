import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Doc, UndoManager } from "@weave/crdt";
import { describe, expect, it } from "vitest";
import { crdtSync, cursorFor } from "../editor/binding";

function setup(initial = "hello world") {
  const doc = new Doc("me");
  doc.insert(0, initial);
  const undo = new UndoManager(doc);
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: doc.toString(), extensions: [crdtSync(doc, undo, () => false)] }),
  });
  return { doc, undo, view };
}

describe("CodeMirror ↔ CRDT binding", () => {
  it("mirrors local edits into the CRDT, including multi-range changes", () => {
    const { doc, view } = setup();
    view.dispatch({ changes: { from: 0, to: 5, insert: "HELLO" } });
    view.dispatch({ changes: [{ from: 0, insert: "> " }, { from: 11, to: 11, insert: "!" }] });
    expect(doc.toString()).toBe(view.state.doc.toString());
    expect(doc.toString()).toBe("> HELLO world!");
    view.destroy();
  });

  it("applies a collaborator's ops to the editor", () => {
    const { doc, view } = setup();
    const peer = new Doc("peer");
    peer.apply(doc.opsSince({}));
    peer.insert(6, "big ");
    peer.delete(0, 1);
    doc.apply(peer.opsSince(doc.version()));
    expect(view.state.doc.toString()).toBe("ello big world");
    view.destroy();
  });

  it("merges concurrent local and remote edits in both directions", () => {
    const { doc, view } = setup("abc");
    const peer = new Doc("peer");
    peer.apply(doc.opsSince({}));
    view.dispatch({ changes: { from: 3, insert: " local" } });
    peer.insert(0, "remote ");
    doc.apply(peer.opsSince(doc.version()));
    peer.apply(doc.opsSince(peer.version()));
    expect(view.state.doc.toString()).toBe(peer.toString());
    expect(view.state.doc.toString()).toBe("remote abc local");
    view.destroy();
  });

  it("undoes only the local user's edits and updates the editor", () => {
    const { doc, undo, view } = setup("base");
    undo.stopCapturing();
    view.dispatch({ changes: { from: 4, insert: " mine" } });
    const peer = new Doc("peer");
    peer.apply(doc.opsSince({}));
    peer.insert(0, "theirs ");
    doc.apply(peer.opsSince(doc.version()));
    undo.undo();
    expect(view.state.doc.toString()).toBe("theirs base");
    expect(doc.toString()).toBe("theirs base");
    view.destroy();
  });

  it("anchors cursors to characters, not offsets", () => {
    const { doc, view } = setup("hello world");
    const cursor = cursorFor(doc, 6, 11);
    const peer = new Doc("peer");
    peer.apply(doc.opsSince({}));
    peer.insert(0, "123 ");
    doc.apply(peer.opsSince(doc.version()));
    const head = doc.resolveAnchor({ id: cursor!.head ? { agent: cursor!.head[0], seq: cursor!.head[1] } : null });
    expect(head).toBe(15);
    view.destroy();
  });
});
