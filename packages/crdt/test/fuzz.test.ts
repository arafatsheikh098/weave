import { describe, expect, it } from "vitest";
import { Doc, type Change, type Op } from "../src/index.js";
import { randomEdit, rng, shuffle, syncAll } from "./helpers.js";

describe("randomized convergence", () => {
  it.each(Array.from({ length: 60 }, (_, i) => i + 1))("seed %i: N replicas converge", (seed) => {
    const r = rng(seed);
    const n = 2 + r.int(4);
    const docs = Array.from({ length: n }, (_, i) => new Doc(`agent${i}`));
    for (let round = 0; round < 8; round++) {
      // Everyone edits concurrently…
      for (const d of docs) for (let k = r.int(6); k >= 0; k--) randomEdit(d, r);
      // …then a random subset of ops is delivered to random peers, out of order.
      for (const d of docs) {
        const from = r.pick(docs);
        const ops = shuffle(from.opsSince(d.version()), r).slice(0, r.int(10));
        d.apply(ops);
      }
    }
    syncAll(docs, r);
    const text = docs[0]!.toString();
    for (const d of docs) {
      expect(d.pendingCount).toBe(0);
      expect(d.toString()).toBe(text);
      expect(d.version()).toEqual(docs[0]!.version());
      d.checkInvariants();
    }
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("seed %i: an editor mirror built from change events matches", (seed) => {
    const r = rng(1000 + seed);
    const a = new Doc("a");
    const b = new Doc("b");
    const c = new Doc("c");
    let mirror = "";
    a.onChange((changes: Change[]) => {
      for (const ch of changes) {
        mirror =
          ch.type === "insert"
            ? mirror.slice(0, ch.pos) + ch.text + mirror.slice(ch.pos)
            : mirror.slice(0, ch.pos) + mirror.slice(ch.pos + ch.len);
      }
    });
    for (let i = 0; i < 300; i++) {
      randomEdit(r.pick([a, b, c]), r);
      if (r.next() < 0.3) syncAll([a, b, c], r);
    }
    syncAll([a, b, c], r);
    expect(mirror).toBe(a.toString());
    expect(b.toString()).toBe(a.toString());
  });

  it.each([1, 2, 3, 4, 5])("seed %i: snapshot + delta mix converges", (seed) => {
    const r = rng(5000 + seed);
    const server = new Doc("srv");
    const clients = [new Doc("c1"), new Doc("c2"), new Doc("c3")];
    let srv = server;
    for (let round = 0; round < 10; round++) {
      for (const c of clients) for (let k = r.int(4); k >= 0; k--) randomEdit(c, r);
      for (const c of clients) {
        if (r.next() < 0.3) continue; // this client is offline this round
        srv.apply(c.opsSince(srv.version()));
        if (srv.canServeDelta(c.version())) c.apply(srv.opsSince(c.version()));
        else c.mergeState(srv.getState());
      }
      if (r.next() < 0.3) srv = Doc.fromState(srv.getState(), "srv"); // server restarts from snapshot
    }
    for (const c of clients) srv.apply(c.opsSince(srv.version()));
    for (const c of clients) {
      if (srv.canServeDelta(c.version())) c.apply(srv.opsSince(c.version()));
      else c.mergeState(srv.getState());
      expect(c.toString()).toBe(srv.toString());
      c.checkInvariants();
    }
  });

  it("applying the same ops in any order gives the same text", () => {
    const r = rng(42);
    const authors = [new Doc("x"), new Doc("y"), new Doc("z")];
    for (let i = 0; i < 200; i++) {
      randomEdit(r.pick(authors), r);
      if (r.next() < 0.2) syncAll(authors, r);
    }
    const all: Op[] = authors.flatMap((d) => d.opsSince({}));
    const texts = new Set<string>();
    for (let t = 0; t < 20; t++) {
      const d = new Doc("reader");
      d.apply(shuffle([...all], r));
      texts.add(d.toString());
    }
    expect(texts.size).toBe(1);
  });
});
