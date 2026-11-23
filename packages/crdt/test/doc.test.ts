import { describe, expect, it } from "vitest";
import { decodeOps, Doc, encodeOps, type Change } from "../src/index.js";

/** Apply a list of index-based changes to a plain string (what an editor binding does). */
function applyChanges(text: string, changes: Change[]): string {
  for (const c of changes) {
    text = c.type === "insert" ? text.slice(0, c.pos) + c.text + text.slice(c.pos) : text.slice(0, c.pos) + text.slice(c.pos + c.len);
  }
  return text;
}

describe("local editing", () => {
  it("inserts and deletes like a string", () => {
    const d = new Doc("a");
    d.insert(0, "hello world");
    d.insert(5, ",");
    d.delete(0, 1);
    d.insert(0, "H");
    d.delete(6, 6);
    d.insert(d.length, "!");
    expect(d.toString()).toBe("Hello,!");
    d.checkInvariants();
  });

  it("stores sequential typing as a single run", () => {
    const d = new Doc("a");
    for (const ch of "the quick brown fox") d.insert(d.length, ch);
    expect(d.runCount).toBe(1);
    expect(d.toString()).toBe("the quick brown fox");
  });

  it("rejects out-of-range edits", () => {
    const d = new Doc("a");
    d.insert(0, "abc");
    expect(() => d.insert(5, "x")).toThrow(RangeError);
    expect(() => d.delete(2, 5)).toThrow(RangeError);
  });

  it("emits changes that reproduce the text", () => {
    const a = new Doc("a");
    const b = new Doc("b");
    let mirror = "";
    b.onChange((changes) => (mirror = applyChanges(mirror, changes)));
    a.onOp((op) => b.apply([op]));
    a.insert(0, "abcdef");
    a.delete(1, 2);
    a.insert(2, "XYZ");
    a.delete(0, 3);
    expect(b.toString()).toBe(a.toString());
    expect(mirror).toBe(a.toString());
  });
});

describe("concurrency", () => {
  it("converges when two users edit concurrently", () => {
    const a = new Doc("a");
    const b = new Doc("b");
    a.insert(0, "base text");
    b.apply(a.opsSince({}));
    a.insert(4, " A-edit");
    b.delete(0, 4);
    b.insert(0, "B-edit");
    a.apply(b.opsSince(a.version()));
    b.apply(a.opsSince(b.version()));
    expect(a.toString()).toBe(b.toString());
  });

  it("does not interleave two people typing at the same spot", () => {
    for (const [first, second] of [
      ["a", "b"],
      ["b", "a"],
    ] as const) {
      const x = new Doc(first);
      const y = new Doc(second);
      x.insert(0, "[]");
      y.apply(x.opsSince({}));
      // Both type a word character by character at position 1, concurrently.
      for (const ch of "hello") x.insert(x.toString().indexOf("]"), ch);
      for (const ch of "world") y.insert(y.toString().indexOf("]"), ch);
      x.apply(y.opsSince({}));
      y.apply(x.opsSince({}));
      expect(x.toString()).toBe(y.toString());
      expect(["[helloworld]", "[worldhello]"]).toContain(x.toString());
    }
  });

  it("does not interleave backward typing either (Fugue property)", () => {
    const x = new Doc("a");
    const y = new Doc("b");
    x.insert(0, "[]");
    y.apply(x.opsSince({}));
    // Each types their word in reverse, always inserting right after "[" (like pressing ←).
    for (const ch of [..."hello"].reverse()) x.insert(1, ch);
    for (const ch of [..."world"].reverse()) y.insert(1, ch);
    x.apply(y.opsSince({}));
    y.apply(x.opsSince({}));
    expect(x.toString()).toBe(y.toString());
    expect(["[helloworld]", "[worldhello]"]).toContain(x.toString());
  });

  it("buffers ops that arrive before their dependencies", () => {
    const a = new Doc("a");
    a.insert(0, "abc");
    a.insert(3, "def");
    a.delete(1, 3);
    const ops = a.opsSince({});
    const b = new Doc("b");
    b.apply([ops[2]!]);
    expect(b.toString()).toBe("");
    expect(b.pendingCount).toBe(1);
    b.apply([ops[1]!]);
    expect(b.pendingCount).toBe(2);
    b.apply([ops[0]!, ops[0]!]);
    expect(b.pendingCount).toBe(0);
    expect(b.toString()).toBe(a.toString());
  });

  it("serves deltas by version vector", () => {
    const a = new Doc("a");
    const b = new Doc("b");
    a.insert(0, "one ");
    b.apply(a.opsSince(b.version()));
    const vb = b.version();
    a.insert(4, "two ");
    a.delete(0, 1);
    const delta = a.opsSince(vb);
    expect(delta).toHaveLength(2);
    b.apply(delta);
    expect(b.toString()).toBe("ne two ");
  });

  it("round-trips ops through the wire codec", () => {
    const a = new Doc("a");
    a.insert(0, "héllo 😀");
    a.delete(1, 2);
    const b = new Doc("b");
    b.apply(decodeOps(JSON.parse(JSON.stringify(encodeOps(a.opsSince({}))))));
    expect(b.toString()).toBe(a.toString());
  });
});

describe("state snapshots", () => {
  it("round-trips through getState / fromState", () => {
    const a = new Doc("a");
    a.insert(0, "hello world");
    a.delete(2, 3);
    const copy = Doc.fromState(JSON.parse(JSON.stringify(a.getState())), "c");
    expect(copy.toString()).toBe(a.toString());
    expect(copy.version()).toEqual(a.version());
    copy.checkInvariants();
    // The copy can keep editing and sync back.
    copy.insert(0, ">");
    a.apply(copy.opsSince(a.version()));
    expect(a.toString()).toBe(">he world");
  });

  it("merges a server snapshot into a client that edited offline", () => {
    const server = new Doc("server");
    server.insert(0, "shared doc");
    const client = new Doc("client");
    client.apply(server.opsSince({}));

    // Client goes offline and edits; meanwhile others edit and the server reloads from a snapshot.
    client.insert(client.length, " +offline");
    const other = new Doc("other");
    other.apply(server.opsSince({}));
    other.insert(0, "[other] ");
    other.delete(8, 6);
    server.apply(other.opsSince(server.version()));
    const reloaded = Doc.fromState(server.getState(), "server2");

    // The reloaded server can't serve a delta to the client: it sends its full state instead.
    expect(reloaded.canServeDelta(client.version())).toBe(false);
    client.mergeState(reloaded.getState());
    reloaded.apply(client.opsSince(reloaded.version()));
    expect(client.toString()).toBe(reloaded.toString());
    expect(client.toString()).toBe("[other]  doc +offline");
    client.checkInvariants();
  });
});

describe("anchors", () => {
  it("keeps a cursor in place across concurrent edits", () => {
    const a = new Doc("a");
    a.insert(0, "hello world");
    const b = new Doc("b");
    b.apply(a.opsSince({}));
    const cursor = a.anchorAt(6); // before "world"
    b.insert(0, ">>> ");
    b.delete(4 + 6, 1); // delete "w"
    a.apply(b.opsSince(a.version()));
    expect(a.toString()).toBe(">>> hello orld");
    expect(a.resolveAnchor(cursor)).toBe(10);
    expect(a.resolveAnchor({ id: null })).toBe(0);
  });

  it("falls back to where a deleted character was", () => {
    const a = new Doc("a");
    a.insert(0, "abcdef");
    const anchor = a.anchorAt(3); // after "c"
    a.delete(1, 3); // remove "bcd"
    expect(a.resolveAnchor(anchor)).toBe(1);
  });
});
