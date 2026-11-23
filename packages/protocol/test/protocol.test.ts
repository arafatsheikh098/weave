import { describe, expect, it } from "vitest";
import { Doc, encodeOps } from "@weave/crdt";
import { LIMITS, parseClientMessage } from "../src/index.js";

const file = "6f1c1e1e-1c1e-4c1e-8c1e-1c1e1c1e1c1e";

describe("parseClientMessage", () => {
  it("accepts real ops produced by the CRDT", () => {
    const d = new Doc("abc");
    d.insert(0, "hello");
    d.delete(1, 2);
    const msg = parseClientMessage(JSON.stringify({ t: "ops", file, ops: encodeOps(d.opsSince({})) }));
    expect(msg?.t).toBe("ops");
  });

  it("rejects malformed or oversized messages", () => {
    expect(parseClientMessage("not json")).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: "ops", file, ops: [] }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: "join", file: "../etc", vv: {} }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: "join", file, vv: { a: -1 } }))).toBeNull();
    expect(parseClientMessage("x".repeat(LIMITS.maxMessageBytes + 1))).toBeNull();
  });

  it("accepts presence updates", () => {
    const msg = parseClientMessage(JSON.stringify({ t: "presence", file, cursor: { anchor: ["a", 3], head: null } }));
    expect(msg).toEqual({ t: "presence", file, cursor: { anchor: ["a", 3], head: null } });
  });
});
