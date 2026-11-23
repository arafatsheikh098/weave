// Benchmark: replay synthetic editing traces through the CRDT.
//   npm run bench -w packages/crdt
// Trace: 100,000 keystrokes with realistic locality: mostly typing at the cursor,
// ~12% backspaces, and the cursor occasionally jumping elsewhere in the document.
import { Doc } from "../dist/index.js";

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function typeTrace(doc, n, seed) {
  const r = rng(seed);
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const roll = r();
    if (roll < 0.02 && doc.length > 0) cursor = Math.floor(r() * (doc.length + 1));
    if (roll > 0.88 && cursor > 0) {
      doc.delete(cursor - 1, 1);
      cursor--;
    } else {
      doc.insert(cursor, "abcdefghij klmnop\n"[Math.floor(r() * 18)]);
      cursor++;
    }
  }
}

const fmt = (n) => n.toLocaleString("en-US");
const time = (label, fn) => {
  const t0 = performance.now();
  const out = fn();
  const ms = performance.now() - t0;
  return { label, ms, out };
};

const N = 100_000;
const local = time("local edits", () => {
  const d = new Doc("alice");
  typeTrace(d, N, 1);
  return d;
});
const doc = local.out;
const ops = doc.opsSince({});

const replay = time("remote replay", () => {
  const d = new Doc("bob");
  d.apply(ops);
  return d;
});
if (replay.out.toString() !== doc.toString()) throw new Error("replay diverged");

const state = doc.getState();
const json = JSON.stringify(state);
const load = time("load snapshot", () => Doc.fromState(JSON.parse(json)));
if (load.out.toString() !== doc.toString()) throw new Error("snapshot diverged");

// Two people editing the same document concurrently, then merging.
const concurrent = time("concurrent merge (2 × 50k)", () => {
  const base = new Doc("base");
  base.insert(0, "x".repeat(1000));
  const a = new Doc("a");
  const b = new Doc("b");
  a.apply(base.opsSince({}));
  b.apply(base.opsSince({}));
  typeTrace(a, N / 2, 2);
  typeTrace(b, N / 2, 3);
  a.apply(b.opsSince(a.version()));
  b.apply(a.opsSince(b.version()));
  if (a.toString() !== b.toString()) throw new Error("concurrent merge diverged");
  return a;
});

console.log(`Trace: ${fmt(N)} keystrokes → ${fmt(doc.length)} chars, ${fmt(ops.length)} ops, ${fmt(doc.runCount)} runs`);
for (const r of [local, replay, load, concurrent]) {
  console.log(`  ${r.label.padEnd(28)} ${r.ms.toFixed(0).padStart(6)} ms`);
}
console.log(`  ${"keystrokes / second (local)".padEnd(28)} ${fmt(Math.round(N / (local.ms / 1000))).padStart(9)}`);
console.log(`  ${"snapshot size (JSON)".padEnd(28)} ${(json.length / 1024).toFixed(0).padStart(6)} KiB`);
