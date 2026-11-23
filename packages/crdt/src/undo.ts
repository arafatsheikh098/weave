import type { Doc } from "./doc.js";
import type { Id, IdRange, Op } from "./types.js";

/** Deleted text plus the ids its characters had, and where it sat. */
interface Piece {
  /** Character just before the deleted text, or null for the document start. */
  after: Id | null;
  text: string;
  /** Original ids of the deleted characters, in text order. */
  ids: IdRange[];
}

/** What one local edit did, in a form that survives concurrent remote edits. */
type Step = { kind: "inserted"; ranges: IdRange[] } | { kind: "deleted"; pieces: Piece[] };

interface Group {
  steps: Step[];
  time: number;
}

const key = (agent: string, seq: number) => `${agent}\u0001${seq}`;

/**
 * Per-user undo/redo.
 *
 * - Only this replica's own edits are undone; collaborators' concurrent edits are left alone.
 * - Undoing an insert deletes exactly the characters that were inserted, by id.
 * - Undoing a delete re-inserts the text where it was. Re-inserted characters get new ids, so
 *   we remember old id → new id; later undo/redo steps that refer to the old characters follow
 *   that redirect.
 * - Edits less than `captureMs` apart are grouped into one undo step.
 */
export class UndoManager {
  private undoStack: Group[] = [];
  private redoStack: Group[] = [];
  private applying: "undo" | "redo" | null = null;
  /** Deleted text seen in change events; the matching op event follows right after. */
  private lastDeleted: { after: Id | null; text: string }[] = [];
  private redirect = new Map<string, Id>();
  private readonly unsubscribe: () => void;
  private readonly doc: Doc;
  private readonly captureMs: number;
  private readonly now: () => number;

  constructor(doc: Doc, captureMs = 500, now: () => number = () => Date.now()) {
    this.doc = doc;
    this.captureMs = captureMs;
    this.now = now;
    const offChanges = doc.onChange((changes, origin) => {
      if (origin === "remote") return;
      for (const c of changes) {
        if (c.type === "delete") this.lastDeleted.push({ after: doc.anchorAt(c.pos).id, text: c.text });
      }
    });
    const offOps = doc.onOp((op, origin) => {
      if (origin === "remote") return;
      const step = this.describe(op);
      if (!step) return;
      if (this.applying === "undo") this.push(this.redoStack, step, true);
      else if (this.applying === "redo") this.push(this.undoStack, step, true);
      else {
        this.push(this.undoStack, step, false);
        this.redoStack = [];
      }
    });
    this.unsubscribe = () => {
      offChanges();
      offOps();
    };
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    return this.run(this.undoStack, "undo");
  }

  redo(): boolean {
    return this.run(this.redoStack, "redo");
  }

  /** Stop grouping: the next edit starts a new undo step. */
  stopCapturing(): void {
    const top = this.undoStack[this.undoStack.length - 1];
    if (top) top.time = -Infinity;
  }

  destroy(): void {
    this.unsubscribe();
  }

  private push(stack: Group[], step: Step, sameGroup: boolean): void {
    const t = this.now();
    const top = stack[stack.length - 1];
    // While undoing/redoing, all steps of one group belong together (sameGroup).
    if (top && (sameGroup ? top.time === Infinity : t - top.time < this.captureMs)) {
      top.steps.push(step);
      if (!sameGroup) top.time = t;
    } else {
      stack.push({ steps: [step], time: sameGroup ? Infinity : t });
    }
  }

  private describe(op: Op): Step | null {
    if (op.kind === "ins") {
      return { kind: "inserted", ranges: [{ agent: op.id.agent, seq: op.id.seq, len: op.text.length }] };
    }
    // The op's ranges list the deleted characters in document order, matching the text.
    const deleted = this.lastDeleted.splice(0);
    if (!deleted.length) return null;
    const ids = [...op.ranges];
    const pieces: Piece[] = deleted.map((d) => ({ after: d.after, text: d.text, ids: takeIds(ids, d.text.length) }));
    return { kind: "deleted", pieces };
  }

  private run(stack: Group[], mode: "undo" | "redo"): boolean {
    const group = stack.pop();
    if (!group) return false;
    this.applying = mode;
    try {
      for (const step of [...group.steps].reverse()) {
        if (step.kind === "inserted") {
          this.doc.deleteIds(this.follow(step.ranges), "undo");
        } else {
          for (const piece of [...step.pieces].reverse()) {
            const after = piece.after ? this.followOne(piece.after) : null;
            const pos = this.doc.resolveAnchor({ id: after });
            const op = this.doc.insert(pos, piece.text, "undo");
            if (op && op.kind === "ins") this.remember(piece.ids, op.id);
          }
        }
      }
    } finally {
      // Close the group so the next undo/redo starts a new one.
      for (const s of [this.undoStack, this.redoStack]) {
        const top = s[s.length - 1];
        if (top && top.time === Infinity) top.time = this.now();
      }
      this.applying = null;
    }
    return true;
  }

  /** Record that characters `ids` were re-created as `newStart`, `newStart+1`, … */
  private remember(ids: IdRange[], newStart: Id): void {
    let i = 0;
    for (const r of ids) {
      for (let k = 0; k < r.len; k++, i++) {
        this.redirect.set(key(r.agent, r.seq + k), { agent: newStart.agent, seq: newStart.seq + i });
      }
    }
  }

  private followOne(id: Id): Id {
    let cur = id;
    for (let hops = 0; hops < 1000; hops++) {
      const next = this.redirect.get(key(cur.agent, cur.seq));
      if (!next) return cur;
      cur = next;
    }
    return cur;
  }

  private follow(ranges: IdRange[]): IdRange[] {
    const out: IdRange[] = [];
    for (const r of ranges) {
      for (let k = 0; k < r.len; k++) {
        const id = this.followOne({ agent: r.agent, seq: r.seq + k });
        const last = out[out.length - 1];
        if (last && last.agent === id.agent && last.seq + last.len === id.seq) last.len++;
        else out.push({ agent: id.agent, seq: id.seq, len: 1 });
      }
    }
    return out;
  }
}

/** Take the first `n` character ids off the front of `ranges` (mutating it). */
function takeIds(ranges: IdRange[], n: number): IdRange[] {
  const out: IdRange[] = [];
  while (n > 0 && ranges.length) {
    const r = ranges[0]!;
    const take = Math.min(n, r.len);
    out.push({ agent: r.agent, seq: r.seq, len: take });
    if (take === r.len) ranges.shift();
    else ranges[0] = { agent: r.agent, seq: r.seq + take, len: r.len - take };
    n -= take;
  }
  return out;
}
