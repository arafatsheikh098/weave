import { hash, verify } from "@node-rs/argon2";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { PEER_COLORS } from "@weave/protocol";
import type { Config } from "./config.js";
import type { Db } from "./db.js";

export const SESSION_COOKIE = "weave_session";
const TOKEN_DAYS = 30;

export interface User {
  id: string;
  username: string;
  displayName: string;
  color: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
}

const credentials = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_.-]{3,32}$/, "Usernames are 3-32 characters: letters, digits, '_', '-' or '.'"),
  password: z.string().min(8, "Use at least 8 characters").max(200),
});
const registration = credentials.extend({
  displayName: z.string().trim().min(1).max(64).optional(),
});

/** HTTP error with a status code, turned into a JSON response by the app's error handler. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const res = schema.safeParse(body);
  if (!res.success) throw new HttpError(400, res.error.issues[0]?.message ?? "Invalid request");
  return res.data;
}

export async function userFromToken(db: Db, secret: Uint8Array, token: string | undefined): Promise<User | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string") return null;
    const { rows } = await db.query(
      "SELECT id, username, display_name AS \"displayName\", color FROM users WHERE id = $1",
      [payload.sub],
    );
    return (rows[0] as User | undefined) ?? null;
  } catch {
    return null;
  }
}

export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw new HttpError(401, "Sign in to continue.");
  return req.user;
}

export async function registerAuth(app: FastifyInstance, db: Db, config: Config): Promise<void> {
  const secret = new TextEncoder().encode(config.jwtSecret);

  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    req.user = await userFromToken(db, secret, req.cookies[SESSION_COOKIE]);
  });

  const issue = async (reply: FastifyReply, userId: string) => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(`${TOKEN_DAYS}d`)
      .sign(secret);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      path: "/",
      maxAge: TOKEN_DAYS * 86400,
    });
  };

  const authLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  app.post("/api/auth/register", authLimit, async (req, reply) => {
    const body = parseBody(registration, req.body);
    const passwordHash = await hash(body.password);
    const color = PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)]!;
    try {
      const { rows } = await db.query(
        `INSERT INTO users (username, display_name, password_hash, color) VALUES ($1, $2, $3, $4)
         RETURNING id, username, display_name AS "displayName", color`,
        [body.username, body.displayName ?? body.username, passwordHash, color],
      );
      const user = rows[0] as User;
      await issue(reply, user.id);
      return reply.code(201).send(user);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new HttpError(409, "That username is taken.");
      throw err;
    }
  });

  app.post("/api/auth/login", authLimit, async (req, reply) => {
    const body = parseBody(credentials, req.body);
    const { rows } = await db.query(
      `SELECT id, username, display_name AS "displayName", color, password_hash FROM users WHERE username = $1`,
      [body.username],
    );
    const row = rows[0] as (User & { password_hash: string }) | undefined;
    // Verify even when the user doesn't exist, so timing doesn't reveal which usernames exist.
    const ok = await verify(row?.password_hash ?? DUMMY_HASH, body.password).catch(() => false);
    if (!row || !ok) throw new HttpError(401, "Wrong username or password.");
    await issue(reply, row.id);
    const { password_hash: _, ...user } = row;
    return user;
  });

  app.post("/api/auth/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  app.get("/api/auth/me", async (req) => requireUser(req));
}

// argon2 hash of a random string, used to equalise timing for unknown usernames.
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$J8/5Wr7NnCzP6M9V1pVvFq8n2c7yG+0qQb5o3XjZ0Zo";
