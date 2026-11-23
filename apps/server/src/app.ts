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
    trustProxy: true,
  });
  await app.register(cookie);
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
