import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { FileMeta, Role } from "@weave/protocol";
import { HttpError, parseBody, requireUser, type User } from "./auth.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { DocStore } from "./docs.js";
import type { Rooms } from "./rooms.js";
import { BLANK, type Template } from "./templates.js";

const RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };
const UPLOAD_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "image/svg+xml": "svg",
};
const MAX_UPLOAD = 5 * 1024 * 1024;

const pathSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9 _.\-/]+$/, "Use letters, digits, spaces, '_', '-', '.' and '/' in file names.")
  .refine((p) => !p.endsWith("/"), "File names can't end with '/'.");

export interface Services {
  db: Db;
  store: DocStore;
  rooms: Rooms;
  config: Config;
  templates: Template[];
}

export async function roleIn(db: Db, projectId: string, userId: string): Promise<Role | null> {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) return null;
  const { rows } = await db.query<{ role: Role }>("SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2", [projectId, userId]);
  return rows[0]?.role ?? null;
}

async function requireRole(db: Db, projectId: string, user: User, min: Role): Promise<Role> {
  const role = await roleIn(db, projectId, user.id);
  if (!role) throw new HttpError(404, "Project not found.");
  if (RANK[role] < RANK[min]) throw new HttpError(403, min === "owner" ? "Only the owner can do that." : "You have view-only access.");
  return role;
}

export async function listFiles(db: Db, projectId: string): Promise<FileMeta[]> {
  const { rows } = await db.query<FileMeta>(
    `SELECT id, path, kind, mime, COALESCE(octet_length(data), 0)::int AS size
     FROM files WHERE project_id = $1 ORDER BY path`,
    [projectId],
  );
  return rows;
}

export async function registerProjects(app: FastifyInstance, s: Services): Promise<void> {
  const { db, store, rooms, templates } = s;

  async function createTextFile(projectId: string, path: string, text: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO files (project_id, path, kind, mime) VALUES ($1, $2, 'text', 'text/plain') RETURNING id",
      [projectId, path],
    );
    const id = rows[0]!.id;
    if (text) {
      await store.serverEdit(id, (doc) => doc.insert(0, text, "remote"));
      await store.snapshot(id);
    }
    return id;
  }

  const fileChanged = async (projectId: string) => {
    await db.query("UPDATE projects SET updated_at = now() WHERE id = $1", [projectId]);
    rooms.filesChanged(projectId, await listFiles(db, projectId));
  };

  // ---- Templates -------------------------------------------------------------------------

  app.get("/api/templates", async () =>
    templates.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      kind: t.kind,
      accent: t.accent,
      files: t.files.map((f) => f.path),
      preview: t.files.find((f) => f.path === t.main)?.text.slice(0, 1200) ?? "",
    })),
  );

  // ---- Projects --------------------------------------------------------------------------

  app.get("/api/projects", async (req) => {
    const user = requireUser(req);
    const { rows } = await db.query(
      `SELECT p.id, p.name, p.main_file AS "mainFile", p.template, p.updated_at AS "updatedAt", m.role,
              (SELECT count(*)::int FROM project_members pm WHERE pm.project_id = p.id) AS members,
              (SELECT json_agg(json_build_object('name', u.display_name, 'color', u.color) ORDER BY pm.joined_at)
                 FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = p.id) AS people
       FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = $1
       ORDER BY p.updated_at DESC`,
      [user.id],
    );
    return rows.map((r) => ({ ...r, online: rooms.activeUsers(r.id) }));
  });

  app.post("/api/projects", async (req, reply) => {
    const user = requireUser(req);
    const body = parseBody(z.object({ name: z.string().trim().min(1).max(120), template: z.string().max(40).default("article") }), req.body);
    const tpl = templates.find((t) => t.id === body.template) ?? BLANK;
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO projects (name, owner_id, main_file, template) VALUES ($1, $2, $3, $4) RETURNING id",
      [body.name, user.id, tpl.main, tpl.id],
    );
    const id = rows[0]!.id;
    await db.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')", [id, user.id]);
    for (const f of tpl.files) await createTextFile(id, f.path, f.text);
    return reply.code(201).send({ id });
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    const user = requireUser(req);
    const role = await requireRole(db, req.params.id, user, "viewer");
    const { rows } = await db.query(
      `SELECT id, name, main_file AS "mainFile", template, created_at AS "createdAt", updated_at AS "updatedAt" FROM projects WHERE id = $1`,
      [req.params.id],
    );
    const members = await db.query(
      `SELECT u.id, u.username, u.display_name AS "displayName", u.color, m.role
       FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = $1 ORDER BY m.joined_at`,
      [req.params.id],
    );
    return { ...rows[0], role, files: await listFiles(db, req.params.id), members: members.rows };
  });

  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    const user = requireUser(req);
    await requireRole(db, req.params.id, user, "editor");
    const body = parseBody(z.object({ name: z.string().trim().min(1).max(120).optional(), mainFile: pathSchema.optional() }), req.body);
    await db.query(
      "UPDATE projects SET name = COALESCE($2, name), main_file = COALESCE($3, main_file), updated_at = now() WHERE id = $1",
      [req.params.id, body.name ?? null, body.mainFile ?? null],
    );
    const { rows } = await db.query<{ name: string; main_file: string }>("SELECT name, main_file FROM projects WHERE id = $1", [req.params.id]);
    rooms.broadcast(req.params.id, { t: "project", name: rows[0]!.name, mainFile: rows[0]!.main_file });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const user = requireUser(req);
    await requireRole(db, req.params.id, user, "owner");
    const files = await listFiles(db, req.params.id);
    rooms.closeProject(req.params.id);
    await db.query("DELETE FROM projects WHERE id = $1", [req.params.id]);
    for (const f of files) store.forget(f.id);
    return reply.code(204).send();
  });

  // ---- Files -----------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>("/api/projects/:id/files", async (req, reply) => {
    const user = requireUser(req);
    await requireRole(db, req.params.id, user, "editor");
    const body = parseBody(z.object({ path: pathSchema, text: z.string().max(200_000).default("") }), req.body);
    try {
      const id = await createTextFile(req.params.id, body.path, body.text);
      await fileChanged(req.params.id);
      return reply.code(201).send({ id });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new HttpError(409, "A file with that name already exists.");
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/upload", async (req, reply) => {
    const user = requireUser(req);
    await requireRole(db, req.params.id, user, "editor");
    const part = await req.file({ limits: { fileSize: MAX_UPLOAD, files: 1 } });
    if (!part) throw new HttpError(400, "No file uploaded.");
    if (!UPLOAD_TYPES[part.mimetype]) throw new HttpError(415, "Upload PNG, JPEG, GIF, SVG or PDF files.");
    const data = await part.toBuffer();
    if (part.file.truncated) throw new HttpError(413, "Files can be at most 5 MB.");
    const rawDir = (part.fields as Record<string, { value?: string }>).dir?.value ?? "";
    const path = parseBody(pathSchema, `${rawDir ? `${rawDir.replace(/\/$/, "")}/` : ""}${part.filename.replace(/[^A-Za-z0-9 _.-]/g, "_")}`);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO files (project_id, path, kind, mime, data) VALUES ($1, $2, 'binary', $3, $4)
       ON CONFLICT (project_id, path) DO UPDATE SET data = $4, mime = $3, updated_at = now()
       WHERE files.kind = 'binary'
       RETURNING id`,
      [req.params.id, path, part.mimetype, data],
    );
    if (!rows[0]) throw new HttpError(409, "A text file with that name already exists.");
    await fileChanged(req.params.id);
    return reply.code(201).send({ id: rows[0].id, path });
  });

  app.patch<{ Params: { id: string; fileId: string } }>("/api/projects/:id/files/:fileId", async (req) => {
    const user = requireUser(req);
    await requireRole(db, req.params.id, user, "editor");
    const body = parseBody(z.object({ path: pathSchema }), req.body);
    try {
      const res = await db.query("UPDATE files SET path = $3, updated_at = now() WHERE id = $2 AND project_id = $1", [
        req.params.id,
        req.params.fileId,
        body.path,
      ]);
      if (!res.rowCount) throw new HttpError(404, "File not found.");
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new HttpError(409, "A file with that name already exists.");
      throw err;
    }
    await fileChanged(req.params.id);
    return { ok: true };
  });

  app.delete<{ Params: { id: string; fileId: string } }>("/api/projects/:id/files/:fileId", async (req, reply) => {
    const user = requireUser(req);
    await requireRole(db, req.params.id, user, "editor");
    const res = await db.query("DELETE FROM files WHERE id = $2 AND project_id = $1", [req.params.id, req.params.fileId]);
    if (!res.rowCount) throw new HttpError(404, "File not found.");
    store.forget(req.params.fileId);
    await fileChanged(req.params.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string; fileId: string } }>("/api/projects/:id/files/:fileId/raw", async (req, reply) => {
    const user = requireUser(req);
    await requireRole(db, req.params.id, user, "viewer");
    const { rows } = await db.query<{ kind: string; mime: string | null; data: Buffer | null; path: string }>(
      "SELECT kind, mime, data, path FROM files WHERE id = $2 AND project_id = $1",
      [req.params.id, req.params.fileId],
    );
    const f = rows[0];
    if (!f) throw new HttpError(404, "File not found.");
    reply.header("Cache-Control", "private, max-age=60");
    reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    if (f.kind === "binary") return reply.type(f.mime ?? "application/octet-stream").send(f.data);
    return reply.type("text/plain; charset=utf-8").send(await store.text(req.params.fileId));
  });

  // ---- Members & invites -----------------------------------------------------------------

  app.post<{ Params: { id: string } }>("/api/projects/:id/invites", async (req, reply) => {
    const user = requireUser(req);
    await requireRole(db, req.params.id, user, "editor");
    const body = parseBody(z.object({ role: z.enum(["editor", "viewer"]) }), req.body);
    const token = randomBytes(18).toString("base64url");
    await db.query("INSERT INTO invites (token, project_id, role, created_by) VALUES ($1, $2, $3, $4)", [token, req.params.id, body.role, user.id]);
    return reply.code(201).send({ token, role: body.role });
  });

  app.get<{ Params: { token: string } }>("/api/invites/:token", async (req) => {
    const { rows } = await db.query(
      `SELECT i.role, p.id AS "projectId", p.name AS "projectName", u.display_name AS "invitedBy"
       FROM invites i JOIN projects p ON p.id = i.project_id JOIN users u ON u.id = i.created_by
       WHERE i.token = $1 AND NOT i.revoked`,
      [req.params.token],
    );
    if (!rows[0]) throw new HttpError(404, "This invite link is invalid or was revoked.");
    return rows[0];
  });

  app.post<{ Params: { token: string } }>("/api/invites/:token/accept", async (req) => {
    const user = requireUser(req);
    const { rows } = await db.query<{ project_id: string; role: Role }>(
      "SELECT project_id, role FROM invites WHERE token = $1 AND NOT revoked",
      [req.params.token],
    );
    const inv = rows[0];
    if (!inv) throw new HttpError(404, "This invite link is invalid or was revoked.");
    // Joining never downgrades an existing member.
    await db.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = CASE
         WHEN project_members.role = 'owner' THEN 'owner'
         WHEN project_members.role = 'editor' OR EXCLUDED.role = 'editor' THEN 'editor'
         ELSE 'viewer' END`,
      [inv.project_id, user.id, inv.role],
    );
    return { projectId: inv.project_id };
  });

  app.patch<{ Params: { id: string; userId: string } }>("/api/projects/:id/members/:userId", async (req) => {
    const user = requireUser(req);
    await requireRole(db, req.params.id, user, "owner");
    const body = parseBody(z.object({ role: z.enum(["editor", "viewer"]) }), req.body);
    const res = await db.query("UPDATE project_members SET role = $3 WHERE project_id = $1 AND user_id = $2 AND role <> 'owner'", [
      req.params.id,
      req.params.userId,
      body.role,
    ]);
    if (!res.rowCount) throw new HttpError(404, "Member not found.");
    rooms.updateMember(req.params.id, req.params.userId, body.role);
    return { ok: true };
  });

  app.delete<{ Params: { id: string; userId: string } }>("/api/projects/:id/members/:userId", async (req, reply) => {
    const user = requireUser(req);
    if (req.params.userId !== user.id) await requireRole(db, req.params.id, user, "owner");
    const res = await db.query("DELETE FROM project_members WHERE project_id = $1 AND user_id = $2 AND role <> 'owner'", [
      req.params.id,
      req.params.userId,
    ]);
    if (!res.rowCount) throw new HttpError(404, "Member not found (owners can't leave their own project).");
    rooms.updateMember(req.params.id, req.params.userId, null);
    return reply.code(204).send();
  });

  // ---- History ---------------------------------------------------------------------------

  async function createVersion(projectId: string, name: string, userId: string | null, auto: boolean): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO versions (project_id, name, created_by, auto) VALUES ($1, $2, $3, $4) RETURNING id",
      [projectId, name, userId, auto],
    );
    const versionId = rows[0]!.id;
    for (const f of await listFiles(db, projectId)) {
      if (f.kind !== "text") continue;
      await db.query("INSERT INTO version_files (version_id, path, text) VALUES ($1, $2, $3)", [versionId, f.path, await store.text(f.id)]);
    }
    return versionId;
  }

  app.get<{ Params: { id: string } }>("/api/projects/:id/versions", async (req) => {
    const user = requireUser(req);
    await requireRole(db, req.params.id, user, "viewer");
    const { rows } = await db.query(
      `SELECT v.id, v.name, v.auto, v.created_at AS "createdAt", u.display_name AS "author",
              (SELECT count(*)::int FROM version_files vf WHERE vf.version_id = v.id) AS files
       FROM versions v LEFT JOIN users u ON u.id = v.created_by
       WHERE v.project_id = $1 ORDER BY v.created_at DESC LIMIT 100`,
      [req.params.id],
    );
    return rows;
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/versions", async (req, reply) => {
    const user = requireUser(req);
    await requireRole(db, req.params.id, user, "editor");
    const body = parseBody(z.object({ name: z.string().trim().min(1).max(120) }), req.body);
    const id = await createVersion(req.params.id, body.name, user.id, false);
    return reply.code(201).send({ id });
  });

  app.get<{ Params: { id: string; versionId: string } }>("/api/projects/:id/versions/:versionId", async (req) => {
    const user = requireUser(req);
    await requireRole(db, req.params.id, user, "viewer");
    const { rows } = await db.query(
      `SELECT vf.path, vf.text FROM version_files vf JOIN versions v ON v.id = vf.version_id
       WHERE v.id = $2 AND v.project_id = $1 ORDER BY vf.path`,
      [req.params.id, req.params.versionId],
    );
    if (!rows.length) throw new HttpError(404, "Version not found.");
    return { files: rows };
  });

  app.post<{ Params: { id: string; versionId: string } }>("/api/projects/:id/versions/:versionId/restore", async (req) => {
    const user = requireUser(req);
    await requireRole(db, req.params.id, user, "editor");
    const { rows } = await db.query<{ path: string; text: string; name: string }>(
      `SELECT vf.path, vf.text, v.name FROM version_files vf JOIN versions v ON v.id = vf.version_id
       WHERE v.id = $2 AND v.project_id = $1`,
      [req.params.id, req.params.versionId],
    );
    if (!rows.length) throw new HttpError(404, "Version not found.");
    // Safety net: save the current state first, so a restore can itself be undone.
    await createVersion(req.params.id, `Before restoring “${rows[0]!.name}”`, user.id, true);
    const files = await listFiles(db, req.params.id);
    for (const v of rows) {
      const existing = files.find((f) => f.path === v.path && f.kind === "text");
      if (existing) rooms.relayOps(req.params.id, existing.id, await store.replaceText(existing.id, v.text));
      else await createTextFile(req.params.id, v.path, v.text);
    }
    await fileChanged(req.params.id);
    return { ok: true };
  });

  // ---- Compile ---------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/compile",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req) => {
      const user = requireUser(req);
      await requireRole(db, req.params.id, user, "viewer");
      const { rows } = await db.query<{ main_file: string }>("SELECT main_file FROM projects WHERE id = $1", [req.params.id]);
      const main = rows[0]!.main_file;
      const files = await listFiles(db, req.params.id);
      const payload: { path: string; text?: string; base64?: string }[] = [];
      for (const f of files) {
        if (f.kind === "text") payload.push({ path: f.path, text: await store.text(f.id) });
        else {
          const data = await db.query<{ data: Buffer }>("SELECT data FROM files WHERE id = $1", [f.id]);
          payload.push({ path: f.path, base64: data.rows[0]!.data.toString("base64") });
        }
      }
      let res: Response;
      try {
        res = await fetch(`${s.config.compileUrl}/compile`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ main, files: payload }),
          signal: AbortSignal.timeout(90_000),
        });
      } catch {
        throw new HttpError(503, "The LaTeX compiler isn't reachable right now.");
      }
      const result = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new HttpError(res.status === 413 ? 413 : 502, result.error ?? "Compile failed.");
      rooms.broadcast(req.params.id, { t: "compiled", by: user.displayName, ok: !!result.ok });
      return result;
    },
  );
}
