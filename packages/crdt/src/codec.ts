import type { Op } from "./types.js";

/**
 * Compact wire format for ops: ids become [agent, seq] tuples. JSON is kept (rather than a
 * binary format) so messages stay debuggable; runs already make ops coarse-grained.
 */
type WireId = [string, number] | null;
export type WireOp =
  | ["i", string, number, string, WireId, WireId]
  | ["d", string, number, [string, number, number][]];

const toWire = (id: { agent: string; seq: number } | null): WireId => (id ? [id.agent, id.seq] : null);
const fromWire = (w: WireId) => (w ? { agent: w[0], seq: w[1] } : null);

export function encodeOps(ops: readonly Op[]): WireOp[] {
  return ops.map((op) =>
    op.kind === "ins"
      ? ["i", op.id.agent, op.id.seq, op.text, toWire(op.originLeft), toWire(op.originRight)]
      : ["d", op.id.agent, op.id.seq, op.ranges.map((r) => [r.agent, r.seq, r.len] as [string, number, number])],
  );
}

export function decodeOps(wire: readonly WireOp[]): Op[] {
  return wire.map((w) =>
    w[0] === "i"
      ? { kind: "ins", id: { agent: w[1], seq: w[2] }, text: w[3], originLeft: fromWire(w[4]), originRight: fromWire(w[5]) }
      : { kind: "del", id: { agent: w[1], seq: w[2] }, ranges: w[3].map(([agent, seq, len]) => ({ agent, seq, len })) },
  );
}
