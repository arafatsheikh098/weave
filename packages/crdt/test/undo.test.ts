import { describe, expect, it } from "vitest";
import { Doc, UndoManager } from "../src/index.js";

function setup() {
  let t = 0;
  const a = new Doc("a");
  const undo = new UndoManager(a, 500, () => t);
  return { a, undo, tick: (ms = 1000) => (t += ms) };
}

describe("undo/redo", () => {
  it("undoes and redoes typing and deleting", () => {
    const { a, undo, tick } = setup();
    a.insert(0, "hello");
    tick();
    a.insert(5, " world");
    tick();
    a.delete(0, 6);
    expect(a.toString()).toBe("world");
    undo.undo();
    expect(a.toString()).toBe("hello world");
    undo.undo();
    expect(a.toString()).toBe("hello");
    undo.redo();
    expect(a.toString()).toBe("hello world");
    undo.redo();
    expect(a.toString()).toBe("world");
    expect(undo.canRedo).toBe(false);
  });

  it("groups quick edits into one step", () => {
    const { a, undo } = setup();
    for (const ch of "abc") a.insert(a.length, ch);
    undo.undo();
    expect(a.toString()).toBe("");
  });

  it("only undoes your own edits, not a collaborator's", () => {
    const { a, undo, tick } = setup();
    const b = new Doc("b");
    a.insert(0, "mine ");
    tick();
    b.apply(a.opsSince({}));
    b.insert(b.length, "theirs");
    a.apply(b.opsSince(a.version()));
    expect(a.toString()).toBe("mine theirs");
    undo.undo();
    expect(a.toString()).toBe("theirs");
    // The undo is a normal op, so it syncs to the collaborator.
    b.apply(a.opsSince(b.version()));
    expect(b.toString()).toBe("theirs");
  });

  it("re-inserts deleted text in the right place after concurrent edits", () => {
    const { a, undo, tick } = setup();
    a.insert(0, "one two three");
    tick();
    a.delete(4, 4); // "one three"
    tick();
    const b = new Doc("b");
    b.apply(a.opsSince({}));
    b.insert(0, ">> ");
    a.apply(b.opsSince(a.version()));
    undo.undo();
    expect(a.toString()).toBe(">> one two three");
  });

  it("clears redo after a new edit", () => {
    const { a, undo, tick } = setup();
    a.insert(0, "x");
    tick();
    undo.undo();
    expect(undo.canRedo).toBe(true);
    a.insert(0, "y");
    expect(undo.canRedo).toBe(false);
  });
});
