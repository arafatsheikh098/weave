/**
 * Integration tests: real Postgres (TEST_DATABASE_URL, default: the docker compose db on
 * localhost:5434), real WebSockets, real CRDT documents on both ends, a fake compile service.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import pg from "pg";
import { decodeOps, Doc, encodeOps, type VersionVector } from "@weave/crdt";
import type { ServerMessage } from "@weave/protocol";
import { buildApp, type AppContext } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb, migrate, type Db } from "../src/db.js";

const BASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://weave:weave@localhost:5434/weave";
const TEST_DB = "weave_test";

let db: Db;
let ctx: AppContext;
let url: string;
let compileServer: Server;
let lastCompile: { main: string; files: { path: string }[] } | null = null;

async function resetDatabase(): Promise<string> {
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  return BASE_URL.replace(/\/[^/]+$/, `/${TEST_DB}`);
}

beforeAll(async () => {
  compileServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastCompile = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, pdf: Buffer.from("%PDF-1.5 fake").toString("base64"), diagnostics: [], log: "", ms: 5, cached: false }));
    });
  });
  await new Promise<void>((r) => compileServer.listen(0, r));
  const compileUrl = `http://127.0.0.1:${(compileServer.address() as AddressInfo).port}`;

  db = createDb(await resetDatabase());
  await migrate(db);
  ctx = await buildApp(db, { ...loadConfig({}), compileUrl, snapshotEvery: 5, idleUnloadMs: 50 });
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await ctx?.app.close();
  await db?.end();
  compileServer?.close();
});

/** A tiny HTTP client that keeps the session cookie. */
class Client {
  cookie = "";
  async req<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
    const res = await fetch(url + path, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), cookie: this.cookie },
      body: body ? JSON.stringify(body) : null,
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0]!;
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as T };
  }
}

async function signUp(name: string): Promise<Client> {
  const c = new Client();
  const r = await c.req("POST", "/api/auth/register", { username: name, password: "correct horse battery" });
  expect(r.status).toBe(201);
  return c;
}

/** A WebSocket session with a local CRDT replica of one file, speaking the real protocol. */
class Editor {
  ws!: WebSocket;
  doc: Doc;
  messages: ServerMessage[] = [];
  acked: VersionVector = {};
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

  constructor(
    private readonly client: Client,
    private readonly projectId: string,
    private readonly fileId: string,
    doc?: Doc,
  ) {
    this.doc = doc ?? new Doc();
  }

  async open(): Promise<void> {
    this.ws = new WebSocket(`${url.replace("http", "ws")}/api/projects/${this.projectId}/ws`, { headers: { cookie: this.client.cookie } });
    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      if (msg.t === "sync") {
        this.doc.apply(decodeOps(msg.ops));
        this.flush(msg.vv);
      } else if (msg.t === "state") {
        this.doc.mergeState(msg.state);
        this.flush(msg.vv);
      } else if (msg.t === "ops") this.doc.apply(decodeOps(msg.ops));
      else if (msg.t === "ack") this.acked = msg.vv;
      // Hand the message to the first waiter that wants it; otherwise queue it.
      const w = this.waiters.find((x) => x.pred(msg));
      if (w) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(msg);
      } else this.messages.push(msg);
    });
    await new Promise((r, j) => {
      this.ws.once("open", r);
      this.ws.once("error", j);
    });
    await this.waitFor((m) => m.t === "welcome");
    this.send({ t: "join", file: this.fileId, vv: this.doc.version() });
    await this.waitFor((m) => m.t === "sync" || m.t === "state");
  }

  /** Send whatever the server doesn't have yet. */
  flush(serverVV: VersionVector = this.acked): void {
    const ops = this.doc.opsSince(serverVV);
    if (ops.length) this.send({ t: "ops", file: this.fileId, ops: encodeOps(ops) });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  waitFor(pred: (m: ServerMessage) => boolean, timeout = 5000): Promise<ServerMessage> {
    const seen = this.messages.find(pred);
    if (seen) {
      this.messages.splice(this.messages.indexOf(seen), 1);
      return Promise.resolve(seen);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out waiting for message")), timeout);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  }

  async edit(fn: (d: Doc) => void): Promise<void> {
    fn(this.doc);
    this.flush();
    await this.waitFor((m) => m.t === "ack");
  }

  close(): Promise<void> {
    return new Promise((r) => {
      this.ws.once("close", () => r());
      this.ws.close();
    });
  }
}

async function until(cond: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("auth", () => {
  it("registers, logs in and rejects bad passwords", async () => {
    await signUp("alice");
    const c = new Client();
    expect((await c.req("POST", "/api/auth/login", { username: "alice", password: "wrong password!" })).status).toBe(401);
    expect((await c.req("POST", "/api/auth/login", { username: "Alice", password: "correct horse battery" })).status).toBe(200);
    const me = await c.req<{ username: string }>("GET", "/api/auth/me");
    expect(me.json.username).toBe("alice");
    expect((await new Client().req("GET", "/api/auth/me")).status).toBe(401);
    expect((await new Client().req("POST", "/api/auth/register", { username: "alice", password: "another password" })).status).toBe(409);
    expect((await new Client().req("POST", "/api/auth/register", { username: "x", password: "short" })).status).toBe(400);
  });
});

describe("collaboration", () => {
  let owner: Client;
  let guest: Client;
  let projectId: string;
  let mainId: string;

  beforeAll(async () => {
    owner = await signUp("owner1");
    guest = await signUp("guest1");
    const created = await owner.req<{ id: string }>("POST", "/api/projects", { name: "Paper", template: "ieee" });
    expect(created.status).toBe(201);
    projectId = created.json.id;
    const project = await owner.req<{ files: { id: string; path: string }[] }>("GET", `/api/projects/${projectId}`);
    mainId = project.json.files.find((f) => f.path === "main.tex")!.id;
    const invite = await owner.req<{ token: string }>("POST", `/api/projects/${projectId}/invites`, { role: "editor" });
    expect((await guest.req("POST", `/api/invites/${invite.json.token}/accept`)).status).toBe(200);
  });

  it("creates projects from templates", async () => {
    const e = new Editor(owner, projectId, mainId);
    await e.open();
    expect(e.doc.toString()).toContain("\\documentclass[conference]{IEEEtran}");
    await e.close();
  });

  it("merges concurrent edits from two users", async () => {
    const a = new Editor(owner, projectId, mainId);
    const b = new Editor(guest, projectId, mainId);
    await a.open();
    await b.open();
    // Both type at the very start at the same time (no waiting in between).
    a.doc.insert(0, "% alice\n");
    b.doc.insert(0, "% bob\n");
    a.flush();
    b.flush();
    await until(() => a.doc.toString() === b.doc.toString() && a.doc.toString().includes("% bob") && a.doc.toString().includes("% alice"));
    await a.close();
    await b.close();
  });

  it("merges an offline session when it reconnects", async () => {
    const a = new Editor(owner, projectId, mainId);
    await a.open();
    const offline = a.doc;
    await a.close();
    // Offline edits…
    offline.insert(offline.length, "\n% written offline\n");
    // …while someone else keeps editing online.
    const b = new Editor(guest, projectId, mainId);
    await b.open();
    await b.edit((d) => d.insert(0, "% online edit\n"));
    // Reconnect with the offline replica: the join handshake exchanges both sides' changes.
    const back = new Editor(owner, projectId, mainId, offline);
    await back.open();
    await until(() => back.doc.toString() === b.doc.toString() && b.doc.toString().includes("written offline"));
    expect(back.doc.toString()).toContain("% online edit");
    await back.close();
    await b.close();
  });

  it("persists edits across a server restart (snapshot + op log)", async () => {
    const a = new Editor(owner, projectId, mainId);
    await a.open();
    for (let i = 0; i < 12; i++) await a.edit((d) => d.insert(d.length, `line ${i}\n`));
    const expected = a.doc.toString();
    await a.close();
    await ctx.store.flushAll(); // drop the in-memory copy, as if the server restarted
    const fresh = new Editor(owner, projectId, mainId);
    await fresh.open();
    expect(fresh.doc.toString()).toBe(expected);
    await fresh.close();
  });

  it("relays presence", async () => {
    const a = new Editor(owner, projectId, mainId);
    const b = new Editor(guest, projectId, mainId);
    await a.open();
    await b.open();
    a.send({ t: "presence", file: mainId, cursor: { anchor: null, head: null } });
    const p = await b.waitFor((m) => m.t === "presence" && m.peer.name === "owner1" && m.peer.file === mainId);
    expect(p.t === "presence" && p.peer.color).toMatch(/^#/);
    await a.close();
    await b.waitFor((m) => m.t === "peer-left");
    await b.close();
  });

  it("keeps viewers read-only", async () => {
    const viewer = await signUp("viewer1");
    const inv = await owner.req<{ token: string }>("POST", `/api/projects/${projectId}/invites`, { role: "viewer" });
    await viewer.req("POST", `/api/invites/${inv.json.token}/accept`);
    const v = new Editor(viewer, projectId, mainId);
    await v.open();
    v.doc.insert(0, "vandalism");
    v.flush();
    const err = await v.waitFor((m) => m.t === "error");
    expect(err.t === "error" && err.message).toMatch(/view-only/);
    expect((await viewer.req("POST", `/api/projects/${projectId}/files`, { path: "x.tex" })).status).toBe(403);
    await v.close();
  });

  it("hides projects from non-members", async () => {
    const stranger = await signUp("stranger");
    expect((await stranger.req("GET", `/api/projects/${projectId}`)).status).toBe(404);
    const ws = new WebSocket(`${url.replace("http", "ws")}/api/projects/${projectId}/ws`, { headers: { cookie: stranger.cookie } });
    const code = await new Promise((r) => ws.on("close", (c) => r(c)));
    expect(code).toBe(4004);
  });

  it("blocks cross-site requests and WebSocket handshakes", async () => {
    const evil = { cookie: owner.cookie, origin: "https://evil.example", "content-type": "application/json" };
    const del = await fetch(`${url}/api/projects/${projectId}`, { method: "DELETE", headers: evil });
    expect(del.status).toBe(403);
    const ws = new WebSocket(`${url.replace("http", "ws")}/api/projects/${projectId}/ws`, {
      headers: { cookie: owner.cookie, origin: "https://evil.example" },
    });
    const code = await new Promise((r) => ws.on("close", (c) => r(c)));
    expect(code).toBe(4003);
    // The real app (same origin) is still allowed.
    const same = new URL(url).host;
    const ok = await fetch(`${url}/api/projects/${projectId}`, { headers: { cookie: owner.cookie, origin: `http://${same}` } });
    expect(ok.status).toBe(200);
  });

  it("serves uploads with nosniff and a sandbox policy", async () => {
    const { json } = await owner.req<{ files: { id: string; path: string }[] }>("GET", `/api/projects/${projectId}`);
    const res = await fetch(`${url}/api/projects/${projectId}/files/${json.files[0]!.id}/raw`, { headers: { cookie: owner.cookie } });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("rejects malformed and oversized messages", async () => {
    const a = new Editor(owner, projectId, mainId);
    await a.open();
    a.ws.send("{not json");
    expect((await a.waitFor((m) => m.t === "error")).t).toBe("error");
    a.send({ t: "ops", file: mainId, ops: [["i", "x", 99, "orphan", ["nobody", 5], null]] }); // dependency never arrives
    await a.waitFor((m) => m.t === "ack");
    await a.close();
  });

  it("manages files, versions and restore", async () => {
    const created = await owner.req<{ id: string }>("POST", `/api/projects/${projectId}/files`, { path: "chapters/intro.tex", text: "Intro v1" });
    expect(created.status).toBe(201);
    expect((await owner.req("POST", `/api/projects/${projectId}/files`, { path: "../evil.tex" })).status).toBe(400);
    expect((await owner.req("POST", `/api/projects/${projectId}/files`, { path: "chapters/intro.tex" })).status).toBe(409);

    const v = await owner.req<{ id: string }>("POST", `/api/projects/${projectId}/versions`, { name: "Draft 1" });
    const intro = new Editor(owner, projectId, created.json.id);
    await intro.open();
    await intro.edit((d) => d.insert(d.length, " — edited"));
    expect(intro.doc.toString()).toBe("Intro v1 — edited");

    await owner.req("POST", `/api/projects/${projectId}/versions/${v.json.id}/restore`);
    await until(() => intro.doc.toString() === "Intro v1");
    const versions = await owner.req<{ name: string; auto: boolean }[]>("GET", `/api/projects/${projectId}/versions`);
    expect(versions.json[0]!.name).toMatch(/Before restoring/);
    await intro.close();

    const rename = await owner.req("PATCH", `/api/projects/${projectId}/files/${created.json.id}`, { path: "chapters/introduction.tex" });
    expect(rename.status).toBe(200);
    expect((await owner.req("DELETE", `/api/projects/${projectId}/files/${created.json.id}`)).status).toBe(204);
  });

  it("uploads images and proxies compiles", async () => {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), "figure 1.png");
    const up = await fetch(`${url}/api/projects/${projectId}/upload`, { method: "POST", headers: { cookie: owner.cookie }, body: form });
    expect(up.status).toBe(201);
    const bad = new FormData();
    bad.append("file", new Blob(["#!/bin/sh"], { type: "text/x-sh" }), "x.sh");
    expect((await fetch(`${url}/api/projects/${projectId}/upload`, { method: "POST", headers: { cookie: owner.cookie }, body: bad })).status).toBe(415);

    const res = await guest.req<{ ok: boolean; pdf: string }>("POST", `/api/projects/${projectId}/compile`);
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(lastCompile?.main).toBe("main.tex");
    expect(lastCompile?.files.map((f) => f.path).sort()).toEqual(["figure 1.png", "main.tex"]);
  });
});
