import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { LIMITS } from "@weave/protocol";
import { HttpError, registerAuth, requireUser } from "./auth.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { DocStore } from "./docs.js";
import { registerProjects, roleIn } from "./projects.js";
import { Rooms } from "./rooms.js";
import { loadTemplates } from "./templates.js";

export interface AppContext {
  app: FastifyInstance;
  store: DocStore;
  rooms: Rooms;
}

export async function buildApp(db: Db, config: Config, opts: { logger?: boolean } = {}): Promise<AppContext> {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 2 * 1024 * 1024,
    // Only trust X-Forwarded-For from a proxy on a private network (nginx in Docker), so clients
    // can't fake their IP to get around rate limits.
    trustProxy: "loopback, linklocal, uniquelocal",
  });
  await app.register(cookie);

  // Cross-site protection: browsers send an Origin header on WebSocket handshakes and on
  // state-changing requests. Reject those coming from another site, so a page elsewhere can't
  // act with the user's cookie (CSRF, cross-site WebSocket hijacking).
  // (WebSocket handshakes are checked in the socket route below.)
  app.addHook("onRequest", async (req, reply) => {
    const unsafe = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
    if (!unsafe) return;
    const origin = req.headers.origin;
    if (!origin) return; // non-browser clients (tests, curl) send no Origin
    if (!sameOrigin(origin, req.headers.host)) {
      return reply.code(403).send({ error: "Cross-site request blocked." });
    }
  });
  await app.register(rateLimit, { global: true, max: 600, timeWindow: "1 minute" });
  await app.register(multipart);
  await app.register(websocket, { options: { maxPayload: LIMITS.maxMessageBytes } });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err instanceof HttpError ? err.statusCode : (err.statusCode ?? 500);
    if (status >= 500) req.log.error(err);
    reply.code(status).send({ error: status >= 500 && !(err instanceof HttpError) ? "Something went wrong on our side." : err.message });
  });

  const store = new DocStore(db, config);
  const rooms = new Rooms(db, store, app.log);
  const templates = await loadTemplates();

  await registerAuth(app, db, config);
  await registerProjects(app, { db, store, rooms, config, templates });

  app.get("/api/health", async () => {
    await db.query("SELECT 1");
    return { status: "ok" };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/ws", { websocket: true }, async (socket, req) => {
    const origin = req.headers.origin;
    if (origin && !sameOrigin(origin, req.headers.host)) {
      socket.close(4003, "Cross-site connection blocked");
      return;
    }
    try {
      const user = requireUser(req);
      const role = await roleIn(db, req.params.id, user.id);
      if (!role) {
        socket.close(4004, "Project not found");
        return;
      }
      rooms.connect(socket, user, req.params.id, role);
    } catch {
      socket.close(4001, "Sign in to continue");
    }
  });

  app.addHook("onClose", async () => {
    await store.flushAll();
  });

  return { app, store, rooms };
}

/** Is the Origin header the same host (and port) the request was sent to? */
export function sameOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
