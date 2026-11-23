import { randomUUID } from "node:crypto";
import { decodeOps, encodeOps, type Op } from "@weave/crdt";
import { LIMITS, parseClientMessage, type FileMeta, type PeerInfo, type Role, type ServerMessage, type WireCursor } from "@weave/protocol";
import type { WebSocket } from "ws";
import type { Db } from "./db.js";
import type { DocStore } from "./docs.js";
import type { User } from "./auth.js";

interface Session {
  id: string;
  socket: WebSocket;
  user: User;
  role: Role;
  projectId: string;
  files: Set<string>;
  presence: { file: string | null; cursor: WireCursor };
  tokens: number;
  refilled: number;
  strikes: number;
}

/**
 * One room per open project. Sessions join files inside it; ops are integrated into the
 * server's copy of the document, persisted, acknowledged to the sender and relayed to everyone
 * else who has the file open. Presence (who's here, where their cursor is) is relayed as-is.
 */
export class Rooms {
  private rooms = new Map<string, Set<Session>>();

  constructor(
    private readonly db: Db,
    private readonly store: DocStore,
    private readonly log: { warn: (o: unknown, msg?: string) => void },
  ) {}

  connect(socket: WebSocket, user: User, projectId: string, role: Role): void {
    const session: Session = {
      id: randomUUID(),
      socket,
      user,
      role,
      projectId,
      files: new Set(),
      presence: { file: null, cursor: null },
      tokens: LIMITS.burst,
      refilled: Date.now(),
      strikes: 0,
    };
    let room = this.rooms.get(projectId);
    if (!room) {
      room = new Set();
      this.rooms.set(projectId, room);
    }
    room.add(session);

    this.send(session, { t: "welcome", session: session.id, role, peers: [...room].filter((s) => s !== session).map(peerInfo) });
    this.broadcast(projectId, { t: "presence", peer: peerInfo(session) }, session);

    // Messages are handled one at a time per session, so ops from one client stay in order.
    let queue: Promise<void> = Promise.resolve();
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      queue = queue.then(() => this.onMessage(session, data.toString("utf8"))).catch((err: unknown) => {
        this.log.warn({ err }, "ws message failed");
        this.send(session, { t: "error", message: "The server couldn't process an edit. Reconnecting will resync." });
      });
    });
    socket.on("close", () => {
      room!.delete(session);
      this.broadcast(projectId, { t: "peer-left", session: session.id });
      for (const f of session.files) this.store.release(f);
      if (room!.size === 0) this.rooms.delete(projectId);
    });
  }

  /** Send to every session in a project (optionally only those with `file` open). */
  broadcast(projectId: string, msg: ServerMessage, except?: Session, file?: string): void {
    const room = this.rooms.get(projectId);
    if (!room) return;
    const data = JSON.stringify(msg);
    for (const s of room) {
      if (s === except) continue;
      if (file && !s.files.has(file)) continue;
      if (s.socket.readyState === s.socket.OPEN) s.socket.send(data);
    }
  }

  /** Relay server-made ops (restore, etc.) to everyone with the file open. */
  relayOps(projectId: string, fileId: string, ops: Op[]): void {
    if (ops.length) this.broadcast(projectId, { t: "ops", file: fileId, ops: encodeOps(ops), from: "server" }, undefined, fileId);
  }

  filesChanged(projectId: string, files: FileMeta[]): void {
    this.broadcast(projectId, { t: "files", files });
  }

  /** Disconnect sessions of a user who lost access, or change their role live. */
  updateMember(projectId: string, userId: string, role: Role | null): void {
    for (const s of this.rooms.get(projectId) ?? []) {
      if (s.user.id !== userId) continue;
      if (role === null) s.socket.close(4003, "Access removed");
      else s.role = role;
    }
  }

  closeProject(projectId: string): void {
    for (const s of this.rooms.get(projectId) ?? []) s.socket.close(4004, "Project deleted");
  }

  activeUsers(projectId: string): number {
    return new Set([...(this.rooms.get(projectId) ?? [])].map((s) => s.user.id)).size;
  }

  private send(session: Session, msg: ServerMessage): void {
    if (session.socket.readyState === session.socket.OPEN) session.socket.send(JSON.stringify(msg));
  }

  /** Token bucket: LIMITS.messagesPerSecond sustained, LIMITS.burst at once. */
  private allow(session: Session): boolean {
    const now = Date.now();
    session.tokens = Math.min(LIMITS.burst, session.tokens + ((now - session.refilled) / 1000) * LIMITS.messagesPerSecond);
    session.refilled = now;
    if (session.tokens < 1) return false;
    session.tokens -= 1;
    return true;
  }

  private async onMessage(session: Session, raw: string): Promise<void> {
    if (!this.allow(session)) {
      session.strikes++;
      this.send(session, { t: "error", message: "You're sending edits too fast; slowing down." });
      if (session.strikes > 20) session.socket.close(4008, "Rate limit");
      return;
    }
    const msg = parseClientMessage(raw);
    if (!msg) {
      this.send(session, { t: "error", message: "Malformed message." });
      return;
    }
    switch (msg.t) {
      case "ping":
        this.send(session, { t: "pong" });
        return;
      case "join": {
        const { rows } = await this.db.query("SELECT kind FROM files WHERE id = $1 AND project_id = $2", [msg.file, session.projectId]);
        if (rows[0]?.kind !== "text") {
          this.send(session, { t: "error", message: "That file doesn't exist.", file: msg.file });
          return;
        }
        if (session.files.has(msg.file)) this.store.release(msg.file); // re-join: don't double count
        const doc = await this.store.retain(msg.file);
        session.files.add(msg.file);
        if (doc.canServeDelta(msg.vv)) {
          this.send(session, { t: "sync", file: msg.file, ops: encodeOps(doc.opsSince(msg.vv)), vv: doc.version() });
        } else {
          this.send(session, { t: "state", file: msg.file, state: doc.getState(), vv: doc.version() });
        }
        return;
      }
      case "leave":
        if (session.files.delete(msg.file)) this.store.release(msg.file);
        return;
      case "ops": {
        if (session.role === "viewer") {
          this.send(session, { t: "error", message: "You have view-only access to this project.", file: msg.file });
          return;
        }
        if (!session.files.has(msg.file)) {
          this.send(session, { t: "error", message: "Join the file before editing it.", file: msg.file });
          return;
        }
        const ops = decodeOps(msg.ops);
        const { fresh, vv } = await this.store.applyClientOps(msg.file, ops);
        const doc = await this.store.get(msg.file);
        if (doc.toString().length > LIMITS.maxFileBytes) {
          this.send(session, { t: "error", message: "This file is getting very large; consider splitting it.", file: msg.file });
        }
        this.send(session, { t: "ack", file: msg.file, vv });
        if (fresh.length) {
          this.broadcast(session.projectId, { t: "ops", file: msg.file, ops: encodeOps(fresh), from: session.id }, session, msg.file);
          void this.db.query("UPDATE projects SET updated_at = now() WHERE id = $1", [session.projectId]);
        }
        return;
      }
      case "presence":
        session.presence = { file: msg.file, cursor: msg.cursor };
        this.broadcast(session.projectId, { t: "presence", peer: peerInfo(session) }, session);
        return;
    }
  }

}

function peerInfo(s: Session): PeerInfo {
  return {
    session: s.id,
    userId: s.user.id,
    name: s.user.displayName,
    color: s.user.color,
    role: s.role,
    file: s.presence.file,
    cursor: s.presence.cursor,
  };
}
