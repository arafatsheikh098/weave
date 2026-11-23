// Sandboxed LaTeX compile service.
//
// POST /compile  { main: "main.tex", files: [{ path, text } | { path, base64 }] }
//   -> { ok, pdf (base64) | null, diagnostics: [...], log, ms, cached }
//
// Safety: Tectonic runs in --untrusted mode (no shell-escape, no reading outside the project),
// as a non-root user, with a wall-clock timeout, file-count/size limits and at most
// MAX_PARALLEL compiles at once. The container itself has a memory limit, a read-only root
// filesystem and (by default) no network: only packages in the pre-warmed cache are available.
// See docs/ARCHITECTURE.md for the trade-offs.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { parseDiagnostics } from "./parse.mjs";

const PORT = Number(process.env.PORT ?? 7000);
const TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_MS ?? 45_000);
const MAX_BODY = 25 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_PARALLEL = Number(process.env.COMPILE_PARALLEL ?? 2);
const ALLOW_NETWORK = process.env.COMPILE_ALLOW_NETWORK === "true";
const CACHE_ENTRIES = 64;

/** LRU of compile results keyed by a hash of the inputs. */
const cache = new Map();
let running = 0;
const waiting = [];

const log = (...args) => console.log(new Date().toISOString(), ...args);

function safePath(p) {
  if (typeof p !== "string" || !p || p.length > 200) return null;
  const n = normalize(p).replace(/\\/g, "/");
  if (n.startsWith("/") || n.startsWith("..") || n.includes("/../") || n.includes("\0")) return null;
  return n;
}

async function withSlot(fn) {
  if (running >= MAX_PARALLEL) await new Promise((resolve) => waiting.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function runTectonic(dir, main) {
  const args = ["-X", "compile", main, "--outdir", "out", "--keep-logs", "--untrusted", "--synctex"];
  if (!ALLOW_NETWORK) args.push("--only-cached");
  return new Promise((resolve) => {
    const child = spawn("tectonic", args, { cwd: dir, env: { ...process.env, TECTONIC_UNTRUSTED_MODE: "1" } });
    let output = "";
    const collect = (b) => {
      if (output.length < 200_000) output += b.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      output += `\nerror: compile timed out after ${TIMEOUT_MS / 1000}s\n`;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `error: could not start tectonic: ${err.message}` });
    });
  });
}

async function compile(body) {
  const main = safePath(body.main ?? "main.tex");
  if (!main || !main.endsWith(".tex")) return { status: 400, json: { error: "main must be a .tex file" } };
  if (!Array.isArray(body.files) || body.files.length === 0 || body.files.length > MAX_FILES) {
    return { status: 400, json: { error: `files must be a list of 1-${MAX_FILES} files` } };
  }
  const files = [];
  for (const f of body.files) {
    const path = safePath(f?.path);
    if (!path) return { status: 400, json: { error: `bad file path: ${String(f?.path)}` } };
    if (typeof f.text === "string") files.push({ path, data: Buffer.from(f.text, "utf8") });
    else if (typeof f.base64 === "string") files.push({ path, data: Buffer.from(f.base64, "base64") });
    else return { status: 400, json: { error: `file ${path} has no content` } };
  }
  if (!files.some((f) => f.path === main)) return { status: 400, json: { error: `${main} is not in the project` } };

  const hash = createHash("sha256").update(main);
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) hash.update(f.path).update("\0").update(f.data);
  const key = hash.digest("hex");
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return { status: 200, json: { ...hit, cached: true, ms: 0 } };
  }

  return withSlot(async () => {
    const dir = join(tmpdir(), `work-${randomUUID()}`);
    const started = Date.now();
    try {
      for (const f of files) {
        const target = join(dir, f.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, f.data);
      }
      await mkdir(join(dir, "out"));
      const { code, output } = await runTectonic(dir, main);
      const base = main.replace(/\.tex$/, "");
      const pdf = await readFile(join(dir, "out", `${base}.pdf`)).catch(() => null);
      const texLog = await readFile(join(dir, "out", `${base}.log`), "utf8").catch(() => "");
      const diagnostics = parseDiagnostics(output, texLog, main, new Set(files.map((f) => f.path)));
      const ok = code === 0 && pdf !== null;
      if (!ok && !diagnostics.some((d) => d.level === "error")) {
        const firstError = output.split("\n").find((l) => l.startsWith("error:")) ?? "Compilation failed.";
        diagnostics.unshift({ file: main, line: null, message: firstError.replace(/^error:\s*/, ""), level: "error" });
      }
      const result = {
        ok,
        pdf: pdf ? pdf.toString("base64") : null,
        diagnostics,
        log: output.slice(-20_000),
      };
      cache.set(key, result);
      if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value);
      log(`compile ${main}: ${ok ? "ok" : "failed"} in ${Date.now() - started} ms`);
      return { status: 200, json: { ...result, cached: false, ms: Date.now() - started } };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

const server = createServer(async (req, res) => {
  const send = (status, json) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(json));
  };
  if (req.method === "GET" && req.url === "/health") return send(200, { status: "ok", network: ALLOW_NETWORK });
  if (req.method !== "POST" || req.url !== "/compile") return send(404, { error: "not found" });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return send(413, { error: "project too large" });
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return send(400, { error: "invalid JSON" });
  }
  try {
    const { status, json } = await compile(body);
    send(status, json);
  } catch (err) {
    log("compile crashed", err);
    send(500, { error: "compile service error" });
  }
});

server.listen(PORT, () => log(`compile service on :${PORT} (network ${ALLOW_NETWORK ? "allowed" : "disabled"})`));
