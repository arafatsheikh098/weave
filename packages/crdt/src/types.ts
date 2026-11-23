/** A replica ("agent") identifier. Every editing session gets its own random agent id. */
export type AgentId = string;

/**
 * Identifies one character (or one delete operation).
 * `seq` is a per-agent counter: each agent numbers everything it creates 0, 1, 2, …
 * An insert of n characters consumes n sequence numbers; a delete consumes one.
 */
export interface Id {
  agent: AgentId;
  seq: number;
}

/** For each agent, how many sequence numbers we have seen (so `seq < vv[agent]` means "known"). */
export type VersionVector = Record<AgentId, number>;

/**
 * Insert a run of characters.
 * Character i of the run has id `{agent, seq: id.seq + i}`; its left origin is the character
 * before it in the run (or `originLeft` for i = 0). All characters share `originRight`.
 */
export interface InsertOp {
  kind: "ins";
  id: Id;
  text: string;
  originLeft: Id | null;
  originRight: Id | null;
}

/** A contiguous range of character ids from one agent. */
export interface IdRange {
  agent: AgentId;
  seq: number;
  len: number;
}

/** Delete (tombstone) the listed characters. */
export interface DeleteOp {
  kind: "del";
  id: Id;
  ranges: IdRange[];
}

export type Op = InsertOp | DeleteOp;

/** A change to the visible text, in the coordinates of the text just before the change. */
export type Change =
  | { type: "insert"; pos: number; text: string }
  | { type: "delete"; pos: number; len: number; text: string };

/** Where a change came from. Editor bindings ignore their own "local" changes. */
export type Origin = "local" | "remote" | "undo";

/** A position in the text that survives concurrent edits: "just after character `id`". */
export interface Anchor {
  /** The character to the left of the position, or null for the start of the document. */
  id: Id | null;
}

/** Serialized document: every run (including tombstones) in document order. */
export interface DocState {
  v: 1;
  vv: VersionVector;
  /** [agent, seq, len, text (null if deleted), originLeft, originRight] */
  runs: [AgentId, number, number, string | null, Id | null, Id | null][];
}
