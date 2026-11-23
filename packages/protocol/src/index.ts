/**
 * The Weave sync protocol: JSON messages over one WebSocket per open project.
 *
 * Joining a file:
 *   client → { t: "join", file, vv }                 (vv = client's version vector, {} if new)
 *   server → { t: "sync", file, ops, vv }            delta the client is missing
 *         or { t: "state", file, state, vv }         full state, if the delta isn't available
 *   client → { t: "ops", file, ops }                 everything the server's vv lacks (offline edits)
 * Live editing:
 *   client → { t: "ops", file, ops }   server → { t: "ack", file, vv } to the sender,
 *                                      server → { t: "ops", file, ops, from } to everyone else
 * Presence:
 *   client → { t: "presence", file, cursor }  server → { t: "presence", peer } / { t: "peer-left" }
 */
import { z } from "zod";
import type { DocState, VersionVector, WireOp } from "@weave/crdt";

export type { WireOp };

/** Hard limits, enforced by the server (and by the client before sending). */
export const LIMITS = {
  maxMessageBytes: 1_000_000,
  maxOpsPerMessage: 5_000,
  maxInsertChars: 200_000,
  maxFileBytes: 2_000_000,
  messagesPerSecond: 60,
  burst: 200,
} as const;

const wireId = z.tuple([z.string().max(64), z.number().int().nonnegative()]).nullable();
const wireOp = z.union([
  z.tuple([z.literal("i"), z.string().min(1).max(64), z.number().int().nonnegative(), z.string().min(1).max(LIMITS.maxInsertChars), wireId, wireId]),
  z.tuple([
    z.literal("d"),
    z.string().min(1).max(64),
    z.number().int().nonnegative(),
    z.array(z.tuple([z.string().max(64), z.number().int().nonnegative(), z.number().int().positive()])).min(1).max(10_000),
  ]),
]);
const versionVector = z.record(z.string().max(64), z.number().int().nonnegative());
const cursor = z.object({ anchor: wireId, head: wireId }).nullable();
const fileId = z.string().uuid();

export const clientMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("join"), file: fileId, vv: versionVector }),
  z.object({ t: z.literal("leave"), file: fileId }),
  z.object({ t: z.literal("ops"), file: fileId, ops: z.array(wireOp).min(1).max(LIMITS.maxOpsPerMessage) }),
  z.object({ t: z.literal("presence"), file: fileId.nullable(), cursor }),
  z.object({ t: z.literal("ping") }),
]);

export type ClientMessage = z.infer<typeof clientMessage>;
export type WireCursor = z.infer<typeof cursor>;

export interface PeerInfo {
  session: string;
  userId: string;
  name: string;
  color: string;
  role: Role;
  file: string | null;
  cursor: WireCursor;
}

export type Role = "owner" | "editor" | "viewer";

export interface FileMeta {
  id: string;
  path: string;
  kind: "text" | "binary";
  mime: string | null;
  size: number;
}

export type ServerMessage =
  | { t: "welcome"; session: string; role: Role; peers: PeerInfo[] }
  | { t: "sync"; file: string; ops: WireOp[]; vv: VersionVector }
  | { t: "state"; file: string; state: DocState; vv: VersionVector }
  | { t: "ops"; file: string; ops: WireOp[]; from: string }
  | { t: "ack"; file: string; vv: VersionVector }
  | { t: "presence"; peer: PeerInfo }
  | { t: "peer-left"; session: string }
  | { t: "files"; files: FileMeta[] }
  | { t: "project"; name: string; mainFile: string }
  | { t: "compiled"; by: string; ok: boolean }
  | { t: "error"; message: string; file?: string }
  | { t: "pong" };

/** Parse and validate a client message. Returns null for anything malformed. */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > LIMITS.maxMessageBytes) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const res = clientMessage.safeParse(data);
  return res.success ? res.data : null;
}

/** Colours given to collaborators, chosen to be distinguishable on light and dark themes. */
export const PEER_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#d55181", "#6250d6", "#c98500", "#0ca30c", "#e34948"];
