import type {
  Anchor,
  AgentId,
  Change,
  DeleteOp,
  DocState,
  Id,
  IdRange,
  InsertOp,
  Op,
  Origin,
  VersionVector,
} from "./types.js";

/**
 * A run of consecutive characters from one agent, stored as one item (run-length encoding).
 * Character i has id (agent, seq + i). Its left origin is character i - 1 of the same run
 * (or `originLeft` for i = 0); every character in the run shares `originRight`.
 * Deleted runs keep their ids and origins (other operations may refer to them) but drop their
 * text to save memory.
 */
interface Run {
  agent: AgentId;
  seq: number;
  len: number;
  text: string | null;
  deleted: boolean;
  originLeft: Id | null;
  originRight: Id | null;
}

export type ChangeListener = (changes: Change[], origin: Origin) => void;
export type OpListener = (op: Op, origin: Origin) => void;

const sameId = (a: Id | null, b: Id | null): boolean =>
  a === b || (a !== null && b !== null && a.agent === b.agent && a.seq === b.seq);

/** Random agent id: 10 base-36 characters (about 52 bits). */
export function randomAgentId(): AgentId {
  let s = "";
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  for (let i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * 36)];
  return s;
}

/**
 * A collaborative plain-text document.
 *
 * Ordering of concurrent inserts follows the "YjsMod" integration rule, which Weidner and
 * Kleppmann ("The Art of the Fugue", 2023) prove produces the same list order as FugueMax:
 * it never interleaves concurrent runs typed at the same place, forwards or backwards.
 * See docs/CRDT.md for the algorithm and the correctness argument.
 */
export class Doc {
  readonly agent: AgentId;

  /** All runs, tombstones included, in document order. */
  private runs: Run[] = [];
  /** Per agent: runs sorted by seq, for id lookups. */
  private byAgent = new Map<AgentId, Run[]>();
  private vv: VersionVector = {};
  /** Per agent: ops in seq order (only ops this replica received as ops, not via state). */
  private log = new Map<AgentId, Op[]>();
  /** Ops whose causal dependencies haven't arrived yet. */
  private pending: Op[] = [];
  private visibleLen = 0;
  /** Cache of one (run index -> visible position) pair, so nearby lookups are O(distance). */
  private cIdx = 0;
  private cPos = 0;

  private changeListeners = new Set<ChangeListener>();
  private opListeners = new Set<OpListener>();

  constructor(agent: AgentId = randomAgentId()) {
    this.agent = agent;
  }

  // ---------------------------------------------------------------------------------------
  // Reading

  get length(): number {
    return this.visibleLen;
  }

  toString(): string {
    let out = "";
    for (const r of this.runs) if (!r.deleted) out += r.text;
    return out;
  }

  version(): VersionVector {
    return { ...this.vv };
  }

  /** Number of ops waiting for their causal dependencies. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Number of runs (items) stored, tombstones included. Useful for benchmarks. */
  get runCount(): number {
    return this.runs.length;
  }

  onChange(fn: ChangeListener): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  onOp(fn: OpListener): () => void {
    this.opListeners.add(fn);
    return () => this.opListeners.delete(fn);
  }

  // ---------------------------------------------------------------------------------------
  // Local editing

  /** Insert `text` at visible position `pos`. Returns the generated op (or null if no-op). */
  insert(pos: number, text: string, origin: Origin = "local"): InsertOp | null {
    if (text.length === 0) return null;
    if (pos < 0 || pos > this.visibleLen) throw new RangeError(`insert position ${pos} out of range`);
    // Insert right after visible character pos - 1 (or at the very start).
    let boundary = 0;
    let originLeft: Id | null = null;
    if (pos > 0) {
      const { idx, offset } = this.findVisible(pos - 1);
      const run = this.runs[idx]!;
      if (offset < run.len - 1) this.split(idx, offset + 1);
      boundary = idx + 1;
      originLeft = { agent: run.agent, seq: run.seq + offset };
    }
    const next = this.runs[boundary];
    const originRight: Id | null = next ? { agent: next.agent, seq: next.seq } : null;
    const op: InsertOp = {
      kind: "ins",
      id: { agent: this.agent, seq: this.vv[this.agent] ?? 0 },
      text,
      originLeft,
      originRight,
    };
    this.placeRun(boundary, op, pos);
    this.record(op);
    this.emitChanges([{ type: "insert", pos, text }], origin);
    this.emitOp(op, origin);
    return op;
  }

  /** Delete `len` visible characters starting at `pos`. Returns the generated op (or null). */
  delete(pos: number, len: number, origin: Origin = "local"): DeleteOp | null {
    if (len <= 0) return null;
    if (pos < 0 || pos + len > this.visibleLen) throw new RangeError("delete range out of range");
    const ranges: IdRange[] = [];
    let { idx, offset } = this.findVisible(pos);
    let remaining = len;
    let deletedText = "";
    while (remaining > 0) {
      let run = this.runs[idx]!;
      if (run.deleted) {
        idx++;
        offset = 0;
        continue;
      }
      if (offset > 0) {
        this.split(idx, offset);
        idx++;
        offset = 0;
        run = this.runs[idx]!;
      }
      if (run.len > remaining) this.split(idx, remaining);
      run = this.runs[idx]!;
      deletedText += run.text;
      ranges.push({ agent: run.agent, seq: run.seq, len: run.len });
      remaining -= run.len;
      this.markDeleted(run);
      idx++;
    }
    this.setCache(0, 0);
    const op: DeleteOp = { kind: "del", id: { agent: this.agent, seq: this.vv[this.agent] ?? 0 }, ranges: mergeRanges(ranges) };
    this.record(op);
    this.emitChanges([{ type: "delete", pos, len, text: deletedText }], origin);
    this.emitOp(op, origin);
    return op;
  }

  /** Delete specific characters by id (used by undo). Already-deleted characters are skipped. */
  deleteIds(ranges: IdRange[], origin: Origin = "local"): DeleteOp | null {
    const changes: Change[] = [];
    const done: IdRange[] = [];
    for (const r of ranges) this.tombstoneRange(r, changes, done);
    if (done.length === 0) return null;
    const op: DeleteOp = { kind: "del", id: { agent: this.agent, seq: this.vv[this.agent] ?? 0 }, ranges: mergeRanges(done) };
    this.record(op);
    this.emitChanges(changes, origin);
    this.emitOp(op, origin);
    return op;
  }

  // ---------------------------------------------------------------------------------------
  // Remote operations

  /** Apply ops from another replica. Duplicates are ignored; early ops wait for dependencies. */
  apply(ops: readonly Op[]): void {
    const changes: Change[] = [];
    for (const op of ops) {
      if (this.isKnown(op)) continue;
      this.pending.push(op);
    }
    // Keep integrating until nothing more becomes ready.
    let progress = true;
    while (progress && this.pending.length > 0) {
      progress = false;
      const still: Op[] = [];
      for (const op of this.pending) {
        if (this.isKnown(op)) continue;
        if (this.isReady(op)) {
          this.integrate(op, changes);
          progress = true;
        } else {
          still.push(op);
        }
      }
      this.pending = still;
    }
    if (changes.length) this.emitChanges(changes, "remote");
  }

  /** Ops this replica has (as ops) that a peer with version `since` hasn't seen. */
  opsSince(since: VersionVector): Op[] {
    const out: Op[] = [];
    for (const [agent, ops] of this.log) {
      const from = since[agent] ?? 0;
      // ops are sorted by seq; binary search the first op whose range ends after `from`.
      let lo = 0;
      let hi = ops.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (opEnd(ops[mid]!) <= from) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < ops.length; i++) out.push(ops[i]!);
    }
    return out;
  }

  /**
   * Can `opsSince(since)` give a peer everything it is missing? Not if this replica loaded a
   * snapshot (state) that covers ops the peer lacks; then send `getState()` instead.
   */
  canServeDelta(since: VersionVector): boolean {
    for (const [agent, n] of Object.entries(this.vv)) {
      const have = since[agent] ?? 0;
      if (have >= n) continue;
      const ops = this.log.get(agent);
      const first = ops?.[0];
      if (!first || first.id.seq > have) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------------------
  // State (snapshots)

  getState(): DocState {
    return {
      v: 1,
      vv: this.version(),
      runs: this.runs.map((r) => [r.agent, r.seq, r.len, r.deleted ? null : r.text, r.originLeft, r.originRight]),
    };
  }

  static fromState(state: DocState, agent?: AgentId): Doc {
    const doc = new Doc(agent);
    for (const [a, seq, len, text, originLeft, originRight] of state.runs) {
      const run: Run = { agent: a, seq, len, text, deleted: text === null, originLeft, originRight };
      doc.runs.push(run);
      doc.indexRun(run);
      if (!run.deleted) doc.visibleLen += len;
    }
    doc.vv = { ...state.vv };
    return doc;
  }

  /**
   * Merge a peer's full state into this document (used when a delta isn't available, e.g. a
   * client that edited offline reconnects to a server that loaded from a snapshot).
   * Local edits the peer hasn't seen are kept.
   */
  mergeState(state: DocState): void {
    const changes: Change[] = [];
    // 1. Insert runs we don't have. Runs arrive in document order, so left origins come first;
    //    a run whose right origin is still missing waits in a queue.
    let queue = state.runs.map(([agent, seq, len, text, originLeft, originRight]) => ({
      agent, seq, len, text, originLeft, originRight,
    }));
    let progress = true;
    while (progress && queue.length) {
      progress = false;
      const rest: typeof queue = [];
      for (const r of queue) {
        const have = this.vv[r.agent] ?? 0;
        if (r.seq + r.len <= have || this.hasChar({ agent: r.agent, seq: r.seq + r.len - 1 })) continue;
        // Partially known: integrate only the unknown tail.
        let start = 0;
        while (start < r.len && this.hasChar({ agent: r.agent, seq: r.seq + start })) start++;
        const originLeft = start === 0 ? r.originLeft : { agent: r.agent, seq: r.seq + start - 1 };
        if ((originLeft && !this.hasChar(originLeft)) || (r.originRight && !this.hasChar(r.originRight))) {
          rest.push(r);
          continue;
        }
        const len = r.len - start;
        const text = r.text === null ? "\u0000".repeat(len) : r.text.slice(start);
        const op: InsertOp = { kind: "ins", id: { agent: r.agent, seq: r.seq + start }, text, originLeft, originRight: r.originRight };
        // A tombstone we never saw alive is placed already deleted, without telling the editor.
        // (Versions are bumped only at the end: bumping now would make earlier, still-queued runs
        // of the same agent look "known".)
        this.integrateInsert(op, changes, r.text === null);
        progress = true;
      }
      queue = rest;
    }
    // 2. Apply the peer's deletions.
    for (const [agent, seq, len, text] of state.runs) {
      if (text === null) this.tombstoneRange({ agent, seq, len }, changes, []);
    }
    for (const [agent, n] of Object.entries(state.vv)) this.bumpVersion(agent, n);
    this.setCache(0, 0);
    if (changes.length) this.emitChanges(changes, "remote");
  }

  // ---------------------------------------------------------------------------------------
  // Anchors (cursors that survive concurrent edits)

  anchorAt(pos: number): Anchor {
    if (pos <= 0) return { id: null };
    const { idx, offset } = this.findVisible(Math.min(pos, this.visibleLen) - 1);
    const run = this.runs[idx]!;
    return { id: { agent: run.agent, seq: run.seq + offset } };
  }

  resolveAnchor(anchor: Anchor): number {
    if (anchor.id === null) return 0;
    const found = this.findRun(anchor.id);
    if (!found) return 0;
    const run = this.runs[found.idx]!;
    return this.posOf(found.idx) + (run.deleted ? 0 : found.offset + 1);
  }

  /** Visible position of a character (where it is, or where it was if deleted). */
  positionOf(id: Id): number | null {
    const found = this.findRun(id);
    if (!found) return null;
    const run = this.runs[found.idx]!;
    return this.posOf(found.idx) + (run.deleted ? 0 : found.offset);
  }

  /** Is this character currently visible? */
  isVisible(id: Id): boolean {
    const found = this.findRun(id);
    return !!found && !this.runs[found.idx]!.deleted;
  }

  // ---------------------------------------------------------------------------------------
  // Internals: integration

  private isKnown(op: Op): boolean {
    return op.id.seq < (this.vv[op.id.agent] ?? 0);
  }

  private isReady(op: Op): boolean {
    if (op.id.seq !== (this.vv[op.id.agent] ?? 0)) return false;
    if (op.kind === "ins") {
      return (!op.originLeft || this.hasChar(op.originLeft)) && (!op.originRight || this.hasChar(op.originRight));
    }
    return op.ranges.every((r) => r.seq + r.len <= (this.vv[r.agent] ?? 0));
  }

  private hasChar(id: Id): boolean {
    return this.runOf(id) !== undefined;
  }

  private integrate(op: Op, changes: Change[]): void {
    if (op.kind === "ins") this.integrateInsert(op, changes);
    else for (const r of op.ranges) this.tombstoneRange(r, changes, []);
    this.record(op);
  }

  /**
   * YjsMod integration (equivalent to FugueMax). Walk the items between the new run's left and
   * right origins and decide where it goes among concurrent inserts at the same spot.
   */
  private integrateInsert(op: InsertOp, changes: Change[] | null, deleted = false): void {
    // Left boundary: the run ending at originLeft (split so originLeft is a run end).
    let leftIdx = -1;
    if (op.originLeft) {
      const found = this.findRun(op.originLeft)!;
      const run = this.runs[found.idx]!;
      if (found.offset < run.len - 1) this.split(found.idx, found.offset + 1);
      leftIdx = found.idx;
    }
    // Right boundary: the run starting at originRight.
    let rightIdx = this.runs.length;
    if (op.originRight) {
      const found = this.findRun(op.originRight, leftIdx + 1)!;
      if (found.offset > 0) {
        this.split(found.idx, found.offset);
        rightIdx = found.idx + 1;
      } else {
        rightIdx = found.idx;
      }
    }

    // Index the runs in the scanned region so origin comparisons are O(1).
    const region = new Map<Run, number>();
    for (let i = leftIdx + 1; i < rightIdx; i++) region.set(this.runs[i]!, i);
    const whereIs = (id: Id | null): Run | undefined => (id ? this.runOf(id) : undefined);

    let dest = leftIdx + 1;
    let scanning = false;
    for (let i = leftIdx + 1; ; i++) {
      if (!scanning) dest = i;
      if (i >= rightIdx) break;
      const other = this.runs[i]!;

      // Compare other's left origin with ours: before (-1), same (0) or inside the region (1).
      let cmpLeft: number;
      if (sameId(other.originLeft, op.originLeft)) cmpLeft = 0;
      else {
        const r = whereIs(other.originLeft);
        cmpLeft = r !== undefined && region.has(r) ? 1 : -1;
      }
      if (cmpLeft < 0) break; // other belongs to an earlier insertion point: we go before it
      if (cmpLeft > 0) continue; // other is nested inside a run we already passed: skip it

      // Same left origin: compare right origins.
      let cmpRight: number;
      if (sameId(other.originRight, op.originRight)) cmpRight = 0;
      else if (other.originRight === null) cmpRight = 1;
      else if (op.originRight === null) cmpRight = -1;
      else {
        const r = whereIs(other.originRight);
        cmpRight = r !== undefined && region.has(r) ? -1 : 1;
      }
      if (cmpRight < 0) {
        // other's right origin is inside our range; we might belong after it, keep scanning.
        scanning = true;
      } else if (cmpRight === 0) {
        // True conflict: same origins on both sides. Lower agent id goes first.
        if (op.id.agent < other.agent || (op.id.agent === other.agent && op.id.seq < other.seq)) break;
        scanning = false;
      } else {
        scanning = false;
      }
    }

    const pos = this.posOf(dest);
    this.placeRun(dest, op, pos, deleted);
    if (changes && !deleted) changes.push({ type: "insert", pos, text: op.text });
  }

  /** Put the op's run at index `idx` (visible position `pos`), extending the previous run if possible. */
  private placeRun(idx: number, op: InsertOp, pos: number, deleted = false): void {
    const prev = idx > 0 ? this.runs[idx - 1] : undefined;
    if (deleted) {
      const run: Run = {
        agent: op.id.agent,
        seq: op.id.seq,
        len: op.text.length,
        text: null,
        deleted: true,
        originLeft: op.originLeft,
        originRight: op.originRight,
      };
      this.runs.splice(idx, 0, run);
      this.indexRun(run);
      this.setCache(idx, pos);
      return;
    }
    if (
      prev &&
      !prev.deleted &&
      prev.agent === op.id.agent &&
      prev.seq + prev.len === op.id.seq &&
      sameId(op.originLeft, { agent: prev.agent, seq: prev.seq + prev.len - 1 }) &&
      sameId(op.originRight, prev.originRight)
    ) {
      // The previous run starts at pos - prev.len (it is visible), and grows in place.
      this.setCache(idx - 1, pos - prev.len);
      prev.len += op.text.length;
      prev.text += op.text;
      this.visibleLen += op.text.length;
      return;
    } else {
      const run: Run = {
        agent: op.id.agent,
        seq: op.id.seq,
        len: op.text.length,
        text: op.text,
        deleted: false,
        originLeft: op.originLeft,
        originRight: op.originRight,
      };
      this.runs.splice(idx, 0, run);
      this.indexRun(run);
    }
    this.visibleLen += op.text.length;
    this.setCache(idx, pos);
  }

  /** Tombstone the characters in `range`, splitting runs as needed. */
  private tombstoneRange(range: IdRange, changes: Change[], done: IdRange[]): void {
    let seq = range.seq;
    const end = range.seq + range.len;
    while (seq < end) {
      const found = this.findRun({ agent: range.agent, seq });
      if (!found) return;
      let { idx } = found;
      if (found.offset > 0) {
        this.split(idx, found.offset);
        idx++;
      }
      let run = this.runs[idx]!;
      if (run.len > end - seq) this.split(idx, end - seq);
      run = this.runs[idx]!;
      if (!run.deleted) {
        const pos = this.posOf(idx);
        changes.push({ type: "delete", pos, len: run.len, text: run.text ?? "" });
        done.push({ agent: run.agent, seq: run.seq, len: run.len });
        this.markDeleted(run);
        this.setCache(idx, pos);
      }
      seq = run.seq + run.len;
    }
  }

  private markDeleted(run: Run): void {
    if (run.deleted) return;
    run.deleted = true;
    run.text = null;
    this.visibleLen -= run.len;
  }

  // ---------------------------------------------------------------------------------------
  // Internals: run bookkeeping

  /** Split run at index `idx` so its first `at` characters stay and the rest becomes a new run. */
  private split(idx: number, at: number): void {
    const run = this.runs[idx]!;
    if (at <= 0 || at >= run.len) return;
    const right: Run = {
      agent: run.agent,
      seq: run.seq + at,
      len: run.len - at,
      text: run.text === null ? null : run.text.slice(at),
      deleted: run.deleted,
      originLeft: { agent: run.agent, seq: run.seq + at - 1 },
      originRight: run.originRight,
    };
    run.len = at;
    if (run.text !== null) run.text = run.text.slice(0, at);
    this.runs.splice(idx + 1, 0, right);
    this.indexRun(right);
    if (this.cIdx > idx) this.cIdx++;
  }

  private indexRun(run: Run): void {
    let list = this.byAgent.get(run.agent);
    if (!list) {
      list = [];
      this.byAgent.set(run.agent, list);
    }
    // Insert keeping seq order (usually at the end).
    let i = list.length;
    while (i > 0 && list[i - 1]!.seq > run.seq) i--;
    list.splice(i, 0, run);
  }

  /** The run object containing character `id` (binary search in the agent's runs). */
  private runOf(id: Id): Run | undefined {
    const list = this.byAgent.get(id.agent);
    if (!list) return undefined;
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = list[mid]!;
      if (id.seq < r.seq) hi = mid - 1;
      else if (id.seq >= r.seq + r.len) lo = mid + 1;
      else return r;
    }
    return undefined;
  }

  /** Find the run containing character `id`: its index in `runs` and the offset inside it. */
  private findRun(id: Id, hint = this.cIdx): { idx: number; offset: number } | null {
    const run = this.runOf(id);
    if (!run) return null;
    return { idx: this.indexOfRun(run, hint), offset: id.seq - run.seq };
  }

  /** Index of a run object, searching outwards from `hint` (edits tend to be local). */
  private indexOfRun(run: Run, hint: number): number {
    const n = this.runs.length;
    let h = Math.min(Math.max(hint, 0), n - 1);
    for (let d = 0; d < n; d++) {
      const a = h + d;
      if (a < n && this.runs[a] === run) return a;
      const b = h - d;
      if (b >= 0 && this.runs[b] === run) return b;
      if (a >= n && b < 0) break;
    }
    h = this.runs.indexOf(run);
    if (h < 0) throw new Error("internal: run not found");
    return h;
  }

  /** Visible position at the start of run index `idx`. */
  private posOf(idx: number): number {
    let i = Math.min(this.cIdx, this.runs.length);
    let pos = i === this.cIdx ? this.cPos : 0;
    if (i !== this.cIdx) i = 0;
    while (i < idx) {
      const r = this.runs[i]!;
      if (!r.deleted) pos += r.len;
      i++;
    }
    while (i > idx) {
      i--;
      const r = this.runs[i]!;
      if (!r.deleted) pos -= r.len;
    }
    this.setCache(idx, pos);
    return pos;
  }

  /** The run containing visible character `pos` (0-based) and the offset inside it. */
  private findVisible(pos: number): { idx: number; offset: number } {
    let idx = this.cIdx;
    let start = this.cPos;
    if (idx > this.runs.length) {
      idx = 0;
      start = 0;
    }
    // Move backwards while the cached run starts after pos.
    while (idx > 0 && start > pos) {
      idx--;
      const r = this.runs[idx]!;
      if (!r.deleted) start -= r.len;
    }
    while (idx < this.runs.length) {
      const r = this.runs[idx]!;
      const len = r.deleted ? 0 : r.len;
      if (pos < start + len) {
        this.setCache(idx, start);
        return { idx, offset: pos - start };
      }
      start += len;
      idx++;
    }
    throw new RangeError(`position ${pos} out of range`);
  }

  private setCache(idx: number, pos: number): void {
    this.cIdx = idx;
    this.cPos = pos;
  }

  private record(op: Op): void {
    let list = this.log.get(op.id.agent);
    if (!list) {
      list = [];
      this.log.set(op.id.agent, list);
    }
    list.push(op);
    this.bumpVersion(op.id.agent, opEnd(op));
  }

  private bumpVersion(agent: AgentId, n: number): void {
    if ((this.vv[agent] ?? 0) < n) this.vv[agent] = n;
  }

  private emitChanges(changes: Change[], origin: Origin): void {
    for (const fn of this.changeListeners) fn(changes, origin);
  }

  private emitOp(op: Op, origin: Origin): void {
    for (const fn of this.opListeners) fn(op, origin);
  }

  /** Internal consistency check used by tests. */
  checkInvariants(): void {
    let visible = 0;
    for (const r of this.runs) {
      if (r.len <= 0) throw new Error("empty run");
      if (r.deleted !== (r.text === null)) throw new Error("deleted/text mismatch");
      if (!r.deleted) {
        visible += r.len;
        if (r.text!.length !== r.len) throw new Error("text length mismatch");
      }
    }
    if (visible !== this.visibleLen) throw new Error(`visible length ${this.visibleLen} != ${visible}`);
    let indexed = 0;
    for (const list of this.byAgent.values()) indexed += list.length;
    if (indexed !== this.runs.length) throw new Error("agent index out of sync");
  }
}

/** One past the last sequence number an op uses. */
export function opEnd(op: Op): number {
  return op.id.seq + (op.kind === "ins" ? op.text.length : 1);
}

function mergeRanges(ranges: IdRange[]): IdRange[] {
  const out: IdRange[] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && last.agent === r.agent && last.seq + last.len === r.seq) last.len += r.len;
    else out.push({ ...r });
  }
  return out;
}
