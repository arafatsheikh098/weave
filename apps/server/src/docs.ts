import { decodeOps, Doc, encodeOps, randomAgentId, type DocState, type Op, type VersionVector } from "@weave/crdt";
import type { Config } from "./config.js";
import type { Db } from "./db.js";

interface LiveDoc {
  doc: Doc;
  /** Open editing sessions; the file is only unloaded when this drops to zero. */
  refs: number;
  /** Ops persisted since the last snapshot. */
  sinceSnapshot: number;
  unloadTimer: NodeJS.Timeout | null;
}

/**
 * Keeps the CRDT documents of open files in memory and persists them:
 * every integrated op is appended to `doc_ops`; every `snapshotEvery` ops (and when a file is
 * unloaded) the full state is written to `doc_snapshots` and the covered ops are trimmed.
 */
export class DocStore {
  private docs = new Map<string, Promise<LiveDoc>>();

  constructor(
    private readonly db: Db,
    private readonly config: Pick<Config, "snapshotEvery" | "idleUnloadMs">,
  ) {}

  async get(fileId: string): Promise<Doc> {
    return (await this.live(fileId)).doc;
  }

  async text(fileId: string): Promise<string> {
    if (this.docs.has(fileId)) return (await this.get(fileId)).toString();
    const { rows } = await this.db.query<{ text: string }>("SELECT text FROM doc_snapshots WHERE file_id = $1", [fileId]);
    const ops = await this.db.query("SELECT 1 FROM doc_ops WHERE file_id = $1 LIMIT 1", [fileId]);
    if (rows[0] && ops.rowCount === 0) return rows[0].text; // snapshot is up to date
    return (await this.get(fileId)).toString();
  }

  /**
   * Integrate ops from a client. Returns the ops that were new to the server (to broadcast)
   * and the server's version afterwards (to acknowledge).
   */
  async applyClientOps(fileId: string, ops: Op[]): Promise<{ fresh: Op[]; vv: VersionVector }> {
    const live = await this.live(fileId);
    const before = live.doc.version();
    live.doc.apply(ops);
    const fresh = live.doc.opsSince(before);
    if (fresh.length) await this.persist(fileId, live, fresh);
    return { fresh, vv: live.doc.version() };
  }

  /** Make edits as the server (templates, restoring a version). Returns the generated ops. */
  async serverEdit(fileId: string, edit: (doc: Doc) => void): Promise<Op[]> {
    const live = await this.live(fileId);
    const before = live.doc.version();
    edit(live.doc);
    const fresh = live.doc.opsSince(before);
    if (fresh.length) await this.persist(fileId, live, fresh);
    return fresh;
  }

  /** Replace a file's whole text, touching only the part that changed (keeps cursors stable). */
  async replaceText(fileId: string, next: string): Promise<Op[]> {
    return this.serverEdit(fileId, (doc) => {
      const cur = doc.toString();
      let start = 0;
      while (start < cur.length && start < next.length && cur[start] === next[start]) start++;
      let endCur = cur.length;
      let endNext = next.length;
      while (endCur > start && endNext > start && cur[endCur - 1] === next[endNext - 1]) {
        endCur--;
        endNext--;
      }
      if (endCur > start) doc.delete(start, endCur - start, "remote");
      if (endNext > start) doc.insert(start, next.slice(start, endNext), "remote");
    });
  }

  /** A session opened the file: keep it loaded. */
  async retain(fileId: string): Promise<Doc> {
    const live = await this.live(fileId);
    live.refs++;
    if (live.unloadTimer) clearTimeout(live.unloadTimer);
    live.unloadTimer = null;
    return live.doc;
  }

  /** A session closed the file; unload it a while after the last one leaves. */
  release(fileId: string): void {
    void this.docs.get(fileId)?.then((live) => {
      live.refs = Math.max(0, live.refs - 1);
      if (live.refs > 0) return;
      if (live.unloadTimer) clearTimeout(live.unloadTimer);
      live.unloadTimer = setTimeout(() => {
        if (live.refs === 0) void this.unload(fileId);
      }, this.config.idleUnloadMs);
      live.unloadTimer.unref?.();
    });
  }

  forget(fileId: string): void {
    this.docs.delete(fileId);
  }

  async snapshot(fileId: string): Promise<void> {
    const pending = this.docs.get(fileId);
    if (!pending) return;
    const live = await pending;
    await this.writeSnapshot(fileId, live.doc);
    live.sinceSnapshot = 0;
  }

  /** Snapshot and drop everything (graceful shutdown). */
  async flushAll(): Promise<void> {
    // Copy the keys first: unload() removes entries while we iterate.
    for (const fileId of Array.from(this.docs.keys())) await this.unload(fileId);
  }

  private async unload(fileId: string): Promise<void> {
    const pending = this.docs.get(fileId);
    if (!pending) return;
    const live = await pending;
    if (live.sinceSnapshot > 0) await this.writeSnapshot(fileId, live.doc);
    if (live.unloadTimer) clearTimeout(live.unloadTimer);
    this.docs.delete(fileId);
  }

  private live(fileId: string): Promise<LiveDoc> {
    let pending = this.docs.get(fileId);
    if (!pending) {
      pending = this.load(fileId);
      this.docs.set(fileId, pending);
      pending.catch(() => this.docs.delete(fileId));
    }
    return pending;
  }

  private async load(fileId: string): Promise<LiveDoc> {
    // A fresh agent id per load: this process's own edits never clash with earlier ones.
    const agent = `srv-${randomAgentId()}`;
    const snap = await this.db.query<{ state: DocState }>("SELECT state FROM doc_snapshots WHERE file_id = $1", [fileId]);
    const doc = snap.rows[0] ? Doc.fromState(snap.rows[0].state, agent) : new Doc(agent);
    const { rows } = await this.db.query<{ op: unknown }>(
      "SELECT op FROM doc_ops WHERE file_id = $1 ORDER BY created_at, agent, seq",
      [fileId],
    );
    if (rows.length) doc.apply(decodeOps(rows.map((r) => r.op) as Parameters<typeof decodeOps>[0]));
    return { doc, refs: 0, sinceSnapshot: rows.length, unloadTimer: null };
  }

  private async persist(fileId: string, live: LiveDoc, ops: Op[]): Promise<void> {
    const wire = encodeOps(ops);
    await this.db.query(
      `INSERT INTO doc_ops (file_id, agent, seq, op)
       SELECT $1, x.agent, x.seq, x.op
       FROM jsonb_to_recordset($2::jsonb) AS x(agent text, seq int, op jsonb)
       ON CONFLICT DO NOTHING`,
      [fileId, JSON.stringify(ops.map((op, i) => ({ agent: op.id.agent, seq: op.id.seq, op: wire[i] })))],
    );
    live.sinceSnapshot += ops.length;
    if (live.sinceSnapshot >= this.config.snapshotEvery) {
      live.sinceSnapshot = 0;
      await this.writeSnapshot(fileId, live.doc);
    }
  }

  private async writeSnapshot(fileId: string, doc: Doc): Promise<void> {
    const state = doc.getState();
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO doc_snapshots (file_id, vv, state, text, updated_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (file_id) DO UPDATE SET vv = $2, state = $3, text = $4, updated_at = now()`,
        [fileId, JSON.stringify(state.vv), JSON.stringify(state), doc.toString()],
      );
      // Ops covered by the snapshot are no longer needed to rebuild the document.
      await client.query(
        "DELETE FROM doc_ops WHERE file_id = $1 AND seq < COALESCE(($2::jsonb ->> agent)::int, 0)",
        [fileId, JSON.stringify(state.vv)],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      // The file may have been deleted meanwhile; nothing to snapshot then.
      if ((err as { code?: string }).code !== "23503") throw err;
    } finally {
      client.release();
    }
  }
}
