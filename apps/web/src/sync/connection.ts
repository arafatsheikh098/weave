import { decodeOps, Doc, encodeOps, opEnd, UndoManager, type Op, type VersionVector, type WireOp } from "@weave/crdt";
import type { FileMeta, PeerInfo, Role, ServerMessage, WireCursor } from "@weave/protocol";
import { del, get, set } from "idb-keyval";

export type Status = "connecting" | "live" | "offline";

type Listener = () => void;

/** Minimal observable store for useSyncExternalStore. */
export class Emitter {
  private listeners = new Set<Listener>();
  /** Bumped on every change, so React can use it as a useSyncExternalStore snapshot. */
  version = 0;
  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getVersion = () => this.version;
  emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }
}

interface Persisted {
  v: 1;
  state: ReturnType<Doc["getState"]>;
  outbox: WireOp[];
}

const storeKey = (fileId: string) => `weave:file:${fileId}`;

/**
 * One file's local replica: the CRDT document, per-user undo, and an outbox of local ops the
 * server hasn't acknowledged yet. The replica (state + outbox) is saved to IndexedDB, so edits
 * made offline survive until the connection comes back.
 */
export class FileReplica extends Emitter {
  readonly undo: UndoManager;
  outbox: Op[] = [];
  /** Server's version as of the last ack/sync. */
  serverVV: VersionVector = {};
  /** Has the join handshake completed on the current connection? */
  synced = false;
  private sent = new WeakSet<Op>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly fileId: string,
    readonly doc: Doc,
    outbox: Op[],
    private readonly onLocalOp: (replica: FileReplica) => void,
  ) {
    super();
    this.outbox = outbox;
    this.undo = new UndoManager(doc);
    doc.onOp((op, origin) => {
      if (origin === "remote") return;
      this.outbox.push(op);
      this.onLocalOp(this);
      this.scheduleSave();
      this.emit();
    });
    doc.onChange((_c, origin) => {
      if (origin === "remote") this.scheduleSave();
    });
  }

  static async load(fileId: string, onLocalOp: (r: FileReplica) => void): Promise<FileReplica> {
    let saved: Persisted | undefined;
    try {
      saved = await get<Persisted>(storeKey(fileId));
    } catch {
      saved = undefined; // IndexedDB unavailable (private mode): work in memory only
    }
    if (saved?.v === 1) {
      // A fresh agent id per session; the saved outbox keeps its original ids.
      return new FileReplica(fileId, Doc.fromState(saved.state), decodeOps(saved.outbox), onLocalOp);
    }
    return new FileReplica(fileId, new Doc(), [], onLocalOp);
  }

  get unsynced(): number {
    return this.outbox.length;
  }

  /** Ops to send now (not yet sent on this connection). */
  takeUnsent(): Op[] {
    const out = this.outbox.filter((op) => !this.sent.has(op));
    for (const op of out) this.sent.add(op);
    return out;
  }

  resetConnection(): void {
    this.synced = false;
    this.sent = new WeakSet();
  }

  acknowledge(vv: VersionVector): void {
    this.serverVV = vv;
    const before = this.outbox.length;
    this.outbox = this.outbox.filter((op) => opEnd(op) > (vv[op.id.agent] ?? 0));
    if (this.outbox.length !== before) {
      this.scheduleSave();
      this.emit();
    }
  }

  scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), 400);
  }

  async save(): Promise<void> {
    this.saveTimer = null;
    const data: Persisted = { v: 1, state: this.doc.getState(), outbox: encodeOps(this.outbox) };
    try {
      await set(storeKey(this.fileId), data);
    } catch {
      /* storage full or unavailable: the in-memory outbox still syncs while the tab is open */
    }
  }
}

export interface ProjectEvents {
  error?: (message: string) => void;
  compiled?: (by: string, byUserId: string, ok: boolean) => void;
  peerJoined?: (peer: PeerInfo) => void;
  peerLeft?: (peer: PeerInfo) => void;
  files?: (files: FileMeta[]) => void;
  project?: (p: { name: string; mainFile: string }) => void;
  removed?: (reason: string) => void;
}

/**
 * One WebSocket per open project. Reconnects with exponential backoff; on every (re)connect it
 * re-joins open files, merges whatever the server has that we don't, and sends the outbox.
 */
export class ProjectConnection extends Emitter {
  status: Status = "connecting";
  role: Role = "viewer";
  session: string | null = null;
  peers = new Map<string, PeerInfo>();
  private ws: WebSocket | null = null;
  private files = new Map<string, Promise<FileReplica>>();
  private ready = new Map<string, FileReplica>();
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private flushQueued = new Set<FileReplica>();
  private closed = false;
  private presence: { file: string | null; cursor: WireCursor } = { file: null, cursor: null };
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  /** Remember which peer sessions we've seen, to announce joins once. */
  private seen = new Set<string>();

  constructor(
    readonly projectId: string,
    private readonly events: ProjectEvents = {},
    private readonly url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/projects/${projectId}/ws`,
  ) {
    super();
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    this.connect();
  }

  /** Total local ops not yet acknowledged, across open files. */
  get unsynced(): number {
    let n = 0;
    for (const r of this.ready.values()) n += r.unsynced;
    return n;
  }

  openFile(fileId: string): Promise<FileReplica> {
    let p = this.files.get(fileId);
    if (!p) {
      p = FileReplica.load(fileId, (r) => this.queueFlush(r)).then((replica) => {
        this.ready.set(fileId, replica);
        replica.subscribe(() => this.emit());
        if (this.status === "live") this.join(replica);
        return replica;
      });
      this.files.set(fileId, p);
    }
    return p;
  }

  /** Forget a file (deleted on the server): drop its local copy. */
  async dropFile(fileId: string): Promise<void> {
    this.files.delete(fileId);
    this.ready.delete(fileId);
    await del(storeKey(fileId)).catch(() => {});
  }

  setPresence(file: string | null, cursor: WireCursor): void {
    this.presence = { file, cursor };
    this.send({ t: "presence", file, cursor });
  }

  close(): void {
    this.closed = true;
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const r of this.ready.values()) void r.save();
    this.ws?.close();
  }

  private onOnline = () => {
    if (this.status !== "live") {
      this.attempt = 0;
      this.reconnectNow();
    }
  };

  private onOffline = () => {
    // The socket can take a long time to notice; reflect the browser's view immediately.
    this.setStatus("offline");
    this.ws?.close();
  };

  private reconnectNow(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (this.status !== "offline") this.setStatus("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
    };
    ws.onmessage = (e) => this.onMessage(JSON.parse(String(e.data)) as ServerMessage);
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.heartbeat) clearInterval(this.heartbeat);
      for (const r of this.ready.values()) r.resetConnection();
      this.peers.clear();
      this.setStatus("offline");
      if (e.code === 4003 || e.code === 4004 || e.code === 4001) {
        this.events.removed?.(e.reason || "You no longer have access to this project.");
        return;
      }
      if (this.closed) return;
      const wait = Math.min(10_000, 500 * 2 ** this.attempt++) * (0.75 + Math.random() * 0.5);
      this.retryTimer = setTimeout(() => this.connect(), wait);
    };
  }

  private setStatus(s: Status): void {
    if (this.status === s) return;
    this.status = s;
    this.emit();
  }

  private send(msg: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private join(replica: FileReplica): void {
    replica.resetConnection();
    this.send({ t: "join", file: replica.fileId, vv: replica.doc.version() });
  }

  private queueFlush(replica: FileReplica): void {
    if (this.flushQueued.size === 0) queueMicrotask(() => this.flushAll());
    this.flushQueued.add(replica);
  }

  private flushAll(): void {
    const batch = [...this.flushQueued];
    this.flushQueued.clear();
    for (const r of batch) this.flush(r);
  }

  private flush(replica: FileReplica): void {
    if (this.status !== "live" || !replica.synced || this.role === "viewer") return;
    const ops = replica.takeUnsent();
    for (let i = 0; i < ops.length; i += 2000) {
      this.send({ t: "ops", file: replica.fileId, ops: encodeOps(ops.slice(i, i + 2000)) });
    }
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome": {
        this.session = msg.session;
        this.role = msg.role;
        this.peers = new Map(msg.peers.map((p) => [p.session, p]));
        for (const p of msg.peers) this.seen.add(p.session);
        this.setStatus("live");
        this.emit();
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => this.send({ t: "ping" }), 25_000);
        for (const r of this.ready.values()) this.join(r);
        if (this.presence.file) this.send({ t: "presence", ...this.presence });
        return;
      }
      case "sync":
      case "state": {
        const r = this.ready.get(msg.file);
        if (!r) return;
        if (msg.t === "sync") r.doc.apply(decodeOps(msg.ops));
        else r.doc.mergeState(msg.state);
        r.synced = true;
        r.acknowledge(msg.vv);
        r.scheduleSave();
        this.flush(r);
        r.emit();
        return;
      }
      case "ops": {
        const r = this.ready.get(msg.file);
        r?.doc.apply(decodeOps(msg.ops));
        return;
      }
      case "ack":
        this.ready.get(msg.file)?.acknowledge(msg.vv);
        return;
      case "presence": {
        const isNew = !this.seen.has(msg.peer.session);
        this.seen.add(msg.peer.session);
        this.peers.set(msg.peer.session, msg.peer);
        if (isNew) this.events.peerJoined?.(msg.peer);
        this.emit();
        return;
      }
      case "peer-left": {
        const p = this.peers.get(msg.session);
        this.peers.delete(msg.session);
        this.seen.delete(msg.session);
        if (p && ![...this.peers.values()].some((x) => x.userId === p.userId)) this.events.peerLeft?.(p);
        this.emit();
        return;
      }
      case "files":
        this.events.files?.(msg.files);
        return;
      case "project":
        this.events.project?.(msg);
        return;
      case "compiled":
        this.events.compiled?.(msg.by, msg.byUserId, msg.ok);
        return;
      case "error":
        this.events.error?.(msg.message);
        return;
      case "pong":
        return;
    }
  }
}
